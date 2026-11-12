import React from 'react';
import { MediaVideo } from './media-video';
import { Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ClipView, EditorClip, EditorAsset, EditorProject, PresenterSegment, PresenterTrack, MotionVisual } from './contracts';
import { clipView } from './shots';
import { neutralMotionVisual } from './motion-contracts';
import { evaluateMotionAtFrame, evaluateMotionProperty } from './motion';
import { zoomAmount } from './zoom';
import { automationValue } from './automation';
import { motionWindowStyle, outputRect, primaryRect, previewVideoFrameWidth, sourceCropRect } from './motion-render';
import { projectDuration, scheduleProject } from './timeline';
import { gradeFilter, passAsset, useCutoutPass } from './cutout-pass';

export function createPresenterTrack(project:EditorProject,asset:EditorAsset):PresenterTrack{
  if(asset.kind!=='video'||!asset.sourceFps||!asset.sourceFrames)throw new Error('Choose a normalized presenter video');
  const frames=Math.min(projectDuration(project),Math.floor(asset.sourceFrames/asset.sourceFps*project.output.fps));
  if(frames<1)throw new Error('Presenter recording is shorter than one project frame');
  const side=Math.min(project.output.width*.22,project.output.height*.28),width=side/project.output.width,height=side/project.output.height;
  const visual:MotionVisual={...structuredClone(neutralMotionVisual),rect:{x:1-width-.04,y:1-height-.04,width,height}};
  return{id:`presenter-${crypto.randomUUID().slice(0,8)}`,assetId:asset.id,audio:{muted:!asset.hasAudio,gain:1},segments:[{id:`presenter-segment-${crypto.randomUUID().slice(0,8)}`,startFrame:0,endFrame:frames,sourceStartFrame:0,visual,tracks:[]}]};
}
export function presenterVisualAtFrame(segment:PresenterSegment,localFrame:number):MotionVisual{
  let visual=structuredClone(segment.visual);
  for(const track of segment.tracks){const value=evaluateMotionProperty(track,localFrame);
    if(track.property==='x'||track.property==='y'||track.property==='width'||track.property==='height')visual={...visual,rect:{...visual.rect,[track.property]:value}};
    else visual={...visual,[track.property]:value};}
  return visual;
}
/** CSS corner radius for the bubble at a given side length. */
export function presenterRadius(style:{shape:'circle'|'rounded';radius:number}|undefined,side:number):string|number{return !style||style.shape==='circle'?'50%':Math.round(style.radius*side);}
export type PresenterPiece={key:string;from:number;duration:number;segment:PresenterSegment;sourceStartSeconds:number;playbackRate:number;
  visualFrame:(local:number)=>number;view:(local:number)=>ClipView;
  /** The screen clip this piece belongs to, so a full-frame camera shot takes that clip's zooms and motion. */
  clip?:EditorClip;clipFrame?:(local:number)=>number;
  /** Camera recording for this piece (punched-in takes have their own). */
  assetId:string};
function viewLookup(project:EditorProject){const schedule=scheduleProject(project);
  return(frame:number)=>{const hit=schedule.find(s=>frame>=s.startFrame&&frame<s.startFrame+s.durationFrames)??schedule.at(-1)!;return clipView(hit.clip);};}
/** Where and how the presenter plays. Synced tracks follow each screen clip's source time, so trims and word cuts keep lip-sync. */
export function presenterPieces(project:EditorProject):PresenterPiece[]{
  const track=project.presenterTrack;if(!track)return[];const asset=project.assets.find(item=>item.id===track.assetId);
  if(!asset||asset.kind!=='video'||!asset.sourceFps||!asset.sourceFrames)return[];const fps=project.output.fps;
  if(!track.sync){const view=viewLookup(project);
    return track.segments.map(segment=>({key:segment.id,from:segment.startFrame,duration:segment.endFrame-segment.startFrame,segment,
      sourceStartSeconds:segment.sourceStartFrame/asset.sourceFps!,playbackRate:1,visualFrame:local=>local,view:local=>view(segment.startFrame+local),assetId:asset.id}));}
  const sync=track.sync,master=track.segments[0]!;
  const takes=[{screenAssetId:sync.screenAssetId,assetId:asset.id,offsetSeconds:sync.offsetSeconds},...(track.takes??[])];
  return scheduleProject(project).flatMap((s):PresenterPiece[]=>{
    const take=takes.find(item=>item.screenAssetId===s.asset.id),camera=take&&project.assets.find(item=>item.id===take.assetId);
    if(!take||!camera?.sourceFrames||!camera.sourceFps)return[];const cameraSeconds=camera.sourceFrames/camera.sourceFps;
    const view=clipView(s.clip);if(view.main!=='camera'&&!view.bubble)return[];
    // In a layout the camera is a tile of the picture (drawn there); otherwise only its bubble shows here.
    if(view.layout&&(view.layout.sources.includes('camera')||!view.bubble))return[];
    if(view.main.startsWith('src-')&&!view.bubble)return[];
    const rate=s.clip.playbackRate,playback=s.durationFrames-s.clip.holdEndFrames;
    let cameraTime=s.clip.trimStartSourceFrame/s.asset.sourceFps!-take.offsetSeconds,lead=0;
    if(cameraTime<0){lead=Math.ceil(-cameraTime*fps/rate-1e-9);cameraTime+=lead*rate/fps;}
    const duration=Math.min(playback-lead,Math.floor((cameraSeconds-cameraTime)*fps/rate+1e-9));
    if(duration<1)return[];const start=cameraTime;
    return[{key:`${s.clip.id}-presenter`,from:s.startFrame+lead,duration,segment:master,sourceStartSeconds:start,playbackRate:rate,
      visualFrame:local=>Math.round((start+local*rate/fps)*fps),view:()=>view,clip:s.clip,clipFrame:local=>lead+local,assetId:camera.id}];
  });
}
export function presenterStateAtFrame(project:EditorProject,frame:number){
  const piece=presenterPieces(project).find(item=>frame>=item.from&&frame<item.from+item.duration);if(!piece)return null;
  const local=frame-piece.from,view=piece.view(local);
  return{piece,segment:piece.segment,localFrame:piece.visualFrame(local),view,visual:presenterVisualAtFrame(piece.segment,piece.visualFrame(local))};
}
function PresenterMedia({piece,asset,project,assetPath}:{piece:PresenterPiece;asset:EditorAsset;project:EditorProject;assetPath:(file:string)=>string}){
  const frame=useCurrentFrame(),{width,height,fps}=useVideoConfig(),view=piece.view(frame),p=project.presentation;
  // In the cut-out pass the camera plays its transparent cut-out (or nothing), with no frame shadow.
  const cutPass=useCutoutPass(),shown=passAsset(project,asset,cutPass);
  if(!shown)return null;
  let box:React.CSSProperties,crop:{x:number;y:number;width:number;height:number};
  let zoomed:React.CSSProperties|null=null;
  if(view.main==='camera'){
    const pad=Math.min(p.padding+p.inset,Math.min(width,height)*.45),angle=p.shadow.angle*Math.PI/180;
    const clipFrame=piece.clipFrame?.(frame)??frame,motion=piece.clip?evaluateMotionAtFrame(piece.clip,clipFrame).primary:neutralMotionVisual;
    // Same frame as the screen and slides (the recording's shape), so a cut to the camera keeps the window size.
    const screen=project.assets.find(item=>item.id===piece.clip?.assetId),availW=width-pad*2,availH=height-pad*2;
    const fit=!p.cameraFill&&screen?.width&&screen.height?Math.min(availW/screen.width,availH/screen.height):0,frameW=fit?screen!.width!*fit:availW,frameH=fit?screen!.height!*fit:availH;
    const pane=primaryRect({x:(width-frameW)/2,y:(height-frameH)/2,width:frameW,height:frameH},motion,width,height);
    crop=sourceCropRect(asset.width!,asset.height!,motion.crop,pane.width,pane.height);
    // A focus point (vertical cuts follow the person): centre the crop on it, never past the picture's edges.
    if(view.focus){crop={...crop,x:Math.max(pane.width-crop.width,Math.min(0,pane.width/2-view.focus.x*crop.width)),y:Math.max(pane.height-crop.height,Math.min(0,pane.height/2-view.focus.y*crop.height))};}
    const timelineAt=piece.from+frame,grade=gradeFilter(automationValue(project,'saturation',timelineAt),automationValue(project,'contrast',timelineAt));
    box={...motionWindowStyle(pane,motion,height,5),overflow:'hidden',borderRadius:p.radius,...(grade?{filter:grade}:{}),
      boxShadow:cutPass?undefined:`${Math.cos(angle)*p.shadow.distance}px ${Math.sin(angle)*p.shadow.distance}px ${p.shadow.blur}px rgba(0,0,0,${p.shadow.opacity})`};
    // The clip's zooms apply to the camera the same way they apply to the screen or slides.
    const zoom=piece.clip?.zooms.find(z=>clipFrame>=z.startClipFrame&&clipFrame<z.endClipFrame),clipScale=1+((zoom?.scale??1)-1)*zoomAmount(zoom,clipFrame);
    const timelineFrame=piece.from+frame,scale=clipScale*automationValue(project,'zoom',timelineFrame);
    const fx=zoom&&clipScale>1?zoom.x:automationValue(project,'panX',timelineFrame),fy=zoom&&clipScale>1?zoom.y:automationValue(project,'panY',timelineFrame);
    if(scale!==1){const w=pane.width,h=pane.height;
      const x=Math.max(w*(1-scale),Math.min(0,w/2-fx*w*scale)),y=Math.max(h*(1-scale),Math.min(0,h/2-fy*h*scale));
      zoomed={position:'absolute',left:0,top:0,width:w,height:h,transformOrigin:'0 0',transform:`translate(${x}px,${y}px) scale(${scale})`};}
  }else{
    const visual=presenterVisualAtFrame(piece.segment,piece.visualFrame(frame));
    const rectangular=outputRect(visual,width,height),side=Math.min(rectangular.width,rectangular.height);
    const square={x:rectangular.x+(rectangular.width-side)/2,y:rectangular.y+(rectangular.height-side)/2,width:side,height:side};
    crop=sourceCropRect(asset.width!,asset.height!,visual.crop,side,side);
    const style=project.presenterTrack!.style;
    box={...motionWindowStyle(square,visual,height,1001),overflow:'hidden',borderRadius:presenterRadius(style,side),...(view.bubble?{}:{opacity:0})};
  }
  return <div data-presenter-segment={piece.segment.id} data-presenter-mode={view.main==='camera'?'full':'bubble'} style={box}>
    <div style={zoomed??{position:'absolute',left:0,top:0,width:'100%',height:'100%'}}><MediaVideo src={assetPath(shown.file)} trimBefore={piece.sourceStartSeconds*fps}
      durationInFrames={piece.duration} playbackRate={piece.playbackRate}
      muted={cutPass||project.presenterTrack!.audio.muted||!asset.hasAudio} volume={project.presenterTrack!.audio.gain}
      maxCanvasSinkFrameSize={{width:previewVideoFrameWidth}}
      style={{position:'absolute',left:crop.x,top:crop.y,width:crop.width,height:crop.height}} /></div>
  </div>;
}
export function PresenterLayer({project,assetPath}:{project:EditorProject;assetPath:(file:string)=>string}){
  const track=project.presenterTrack;if(!track)return null;const asset=project.assets.find(item=>item.id===track.assetId);
  if(!asset)return null;
  return <>{presenterPieces(project).map(piece=>{const media=project.assets.find(item=>item.id===piece.assetId)??asset;return <Sequence key={piece.key} from={piece.from} durationInFrames={piece.duration}
    premountFor={Math.min(project.output.fps,piece.from)}><PresenterMedia piece={piece} asset={media} project={project} assetPath={assetPath}/></Sequence>;})}</>;
}
