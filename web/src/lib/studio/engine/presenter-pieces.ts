// The camera's timing and placement, with no React: what the composition (presenter.tsx) draws and what the studio
// worker's FFmpeg export composes are computed here once.
import type { ClipView, EditorClip, EditorAsset, EditorProject, PresenterSegment, PresenterTrack, MotionVisual } from './contracts';
import { clipView } from './shots';
import { neutralMotionVisual } from './motion-contracts';
import { evaluateMotionProperty } from './motion';
import { projectDuration, scheduleProject } from './timeline';

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
