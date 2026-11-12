import { studioKeys } from '../studio-env';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import type {EditorProject,EditorMotion,MotionLayer,MotionVisual} from '@/lib/studio/engine/contracts';
import {scheduleProject} from '@/lib/studio/engine/timeline';
import {evaluateMotionAtFrame} from '@/lib/studio/engine/motion';
import {motionWindowStyle,outputRect,primaryRect,sourceCropRect,type PixelRect} from '@/lib/studio/engine/motion-render';
import {dragMotionCrop,dragMotionFrame,primaryPreviewCropRect,resetMotionCrop,setClipMotion,type CropGesture,type FrameGesture} from './preview-motion';

type Mode={kind:'frame';part:FrameGesture}|{kind:'crop';part:CropGesture};
type ActiveGesture={pointerId:number;element:HTMLElement;projectId:string;clipId:string;target:string;frame:number;mode:Mode;startX:number;startY:number;lastX:number;lastY:number;shellWidth:number;shellHeight:number;cropDx:number;cropDy:number;base:EditorMotion};
type Props={project:EditorProject;frame:number;previewWidth:number;selectedLayerId:string;enabled:boolean;disabled:boolean;select:(clipId:string,layerId:string)=>void;change:(fn:(project:EditorProject)=>EditorProject)=>void;beginEdit:()=>void;endEdit:(cancel:boolean)=>void};
const arrow=(key:string)=>key==='ArrowLeft'?[-1,0]:key==='ArrowRight'?[1,0]:key==='ArrowUp'?[0,-1]:key==='ArrowDown'?[0,1]:null;
const visualFor=(motion:EditorMotion,target:string):MotionVisual|undefined=>target==='primary'?motion.primary:motion.layers.find(layer=>layer.id===target)?.visual;
function legacyPane(project:EditorProject,assetWidth:number,assetHeight:number):PixelRect{
 const {width,height}=project.output,padding=Math.min(project.presentation.padding+project.presentation.inset,Math.min(width,height)*.45);
 const fit=Math.min((width-padding*2)/assetWidth,(height-padding*2)/assetHeight),w=assetWidth*fit,h=assetHeight*fit;
 return{x:(width-w)/2,y:(height-h)/2,width:w,height:h};
}

export function PreviewMotionControls({project,frame,previewWidth,selectedLayerId,enabled,disabled,select,change,beginEdit,endEdit}:Props){
 const [cropMode,setCropMode]=useState(false),[toolbarHost,setToolbarHost]=useState<HTMLElement|null>(null),gesture=useRef<ActiveGesture|null>(null);
 useEffect(()=>{setToolbarHost(document.getElementById('preview-motion-toolbar-slot'));},[]);
 const scheduled=scheduleProject(project).find(item=>frame>=item.startFrame&&frame<item.startFrame+item.durationFrames);
 const clip=scheduled?.clip,clipFrame=scheduled?frame-scheduled.startFrame:0;
 const evaluated=clip?evaluateMotionAtFrame(clip,clipFrame):null;
 const selected=selectedLayerId==='primary'?null:clip?.motion.layers.find(layer=>layer.id===selectedLayerId);
 const visual=selected?evaluated?.layers.find(layer=>layer.id===selected.id)?.visual:selectedLayerId==='primary'?evaluated?.primary:undefined;
 const editable=!!clip&&!!visual&&enabled&&!disabled;
 const output=project.output,previewHeight=previewWidth*output.height/output.width,scale=previewWidth/output.width;
 const selectedAsset=selected?.kind==='video'?project.assets.find(asset=>asset.id===selected.assetId):selectedLayerId==='primary'?scheduled?.asset:undefined;
 const canCrop=!!selectedAsset?.width&&!!selectedAsset.height;
 const selectedRect=visual?(cropMode&&selectedLayerId==='primary'&&selectedAsset?.width&&selectedAsset.height?
  primaryPreviewCropRect(legacyPane(project,selectedAsset.width,selectedAsset.height),visual,output.width,output.height,previewWidth):outputRect(visual,previewWidth,previewHeight)):null;
 const finish=useCallback((cancel:boolean)=>{const current=gesture.current;if(!current)return;gesture.current=null;
  if(current.element.hasPointerCapture(current.pointerId))current.element.releasePointerCapture(current.pointerId);
  endEdit(cancel);
 },[endEdit]);
 useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&gesture.current){event.preventDefault();event.stopPropagation();finish(true);}};
  const blur=()=>finish(true);studioKeys.addEventListener('keydown',escape,true);window.addEventListener('blur',blur);
  return()=>{studioKeys.removeEventListener('keydown',escape,true);window.removeEventListener('blur',blur);finish(true);};
 },[finish]);
 useEffect(()=>{finish(true);setCropMode(false);},[project.id,enabled,disabled,finish]);
 useEffect(()=>{const current=gesture.current;if(current&&(current.clipId!==clip?.id||current.target!==selectedLayerId||current.frame!==frame))finish(true);
  else if(!current)setCropMode(false);
 },[clip?.id,selectedLayerId,frame,finish]);
 const motionAt=(current:ActiveGesture,deltaX:number,deltaY:number)=>current.mode.kind==='frame'?
  dragMotionFrame(current.base,current.target,current.mode.part,deltaX/current.shellWidth,deltaY/current.shellHeight):
  dragMotionCrop(current.base,current.target,current.mode.part,deltaX*current.cropDx,deltaY*current.cropDy);
 const edit=(current:ActiveGesture,deltaX:number,deltaY:number)=>{
  if(deltaX===current.lastX&&deltaY===current.lastY)return;
  current.lastX=deltaX;current.lastY=deltaY;
  const next=motionAt(current,deltaX,deltaY);
  change(value=>value.id!==current.projectId?value:setClipMotion(value,current.clipId,next));
 };
 const start=(event:React.PointerEvent<HTMLElement>,target:string,mode:Mode)=>{
  if(!enabled||disabled||!clip||!evaluated||event.button!==0||gesture.current||target!=='primary'&&!evaluated.layers.some(layer=>layer.id===target))return;
  const shell=event.currentTarget.closest('.preview-shell') as HTMLElement|null,box=shell?.getBoundingClientRect();
  if(!box?.width||!box.height)return;
  const targetLayer=clip.motion.layers.find(layer=>layer.id===target);
  const asset=target==='primary'?scheduled?.asset:targetLayer?.kind==='video'?project.assets.find(item=>item.id===targetLayer.assetId):undefined;
  const targetVisual=visualFor(evaluated?{...clip.motion,primary:evaluated.primary,layers:evaluated.layers}:clip.motion,target);
  let cropDx=0,cropDy=0;
  if(mode.kind==='crop'&&asset?.width&&asset.height&&targetVisual){
   const region=target==='primary'?primaryRect(legacyPane(project,asset.width,asset.height),targetVisual,output.width,output.height):outputRect(targetVisual,output.width,output.height);
   const source=sourceCropRect(asset.width,asset.height,targetVisual.crop,region.width,region.height);
   cropDx=output.width/box.width/source.width;cropDy=output.height/box.height/source.height;
  }
  event.preventDefault();event.stopPropagation();if(target!==selectedLayerId&&cropMode)setCropMode(false);select(clip.id,target);beginEdit();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);
  gesture.current={pointerId:event.pointerId,element:event.currentTarget,projectId:project.id,clipId:clip.id,target,frame,mode,startX:event.clientX,startY:event.clientY,lastX:0,lastY:0,shellWidth:box.width,shellHeight:box.height,cropDx,cropDy,base:clip.motion};
 };
 const move=(event:React.PointerEvent<HTMLElement>)=>{const current=gesture.current;if(!current||current.pointerId!==event.pointerId)return;event.preventDefault();event.stopPropagation();edit(current,event.clientX-current.startX,event.clientY-current.startY);};
 const pointer={onPointerMove:move,onPointerUp:(event:React.PointerEvent<HTMLElement>)=>{const current=gesture.current;if(current?.pointerId!==event.pointerId)return;move(event);finish(motionAt(current,event.clientX-current.startX,event.clientY-current.startY)===current.base);},onPointerCancel:(event:React.PointerEvent<HTMLElement>)=>{if(gesture.current?.pointerId===event.pointerId)finish(true);},onLostPointerCapture:(event:React.PointerEvent<HTMLElement>)=>{if(gesture.current?.pointerId===event.pointerId)finish(true);}};
 const nudge=(event:React.KeyboardEvent,target:string,mode:Mode)=>{const direction=arrow(event.key);if(!direction||!clip||disabled)return;event.preventDefault();event.stopPropagation();select(clip.id,target);
  const step=event.shiftKey?.05:.005;
  change(value=>{if(value.id!==project.id)return value;const current=value.clips.find(item=>item.id===clip.id);if(!current)return value;
   const motion=mode.kind==='frame'?dragMotionFrame(current.motion,target,mode.part,direction[0]!*step,direction[1]!*step):dragMotionCrop(current.motion,target,mode.part,direction[0]!*step,direction[1]!*step);
   return setClipMotion(value,clip.id,motion);
  });
 };
 if(!enabled||disabled||!clip||!evaluated)return null;
 const regions:[string,string,MotionVisual,PixelRect,number,MotionLayer|null][]=[];
 if(scheduled?.asset.width&&scheduled.asset.height){const pane=primaryRect(legacyPane(project,scheduled.asset.width,scheduled.asset.height),evaluated.primary,output.width,output.height);regions.push(['primary','Primary recording',evaluated.primary,pane,0,null]);}
 for(const layer of evaluated.layers){const region=outputRect(layer.visual,output.width,output.height);regions.push([layer.id,layer.name,layer.visual,region,layer.zIndex,layer]);}
 return <div className="preview-motion-controls" aria-label="On-preview motion controls">
  {regions.filter(([, ,item])=>item.opacity>.01).map(([target,name,item,region,z,layer])=>{
   const pixel={x:region.x*scale,y:region.y*scale,width:region.width*scale,height:region.height*scale};
   const mode:Mode=cropMode&&target===selectedLayerId?{kind:'crop',part:'pan'}:{kind:'frame',part:'move'};
   const handlers={onPointerDown:(event:React.PointerEvent<HTMLElement>)=>start(event,target,mode),onKeyDown:(event:React.KeyboardEvent)=>nudge(event,target,mode),onClick:()=>select(clip.id,target),...pointer};
   const style={...motionWindowStyle(pixel,item,previewHeight,z+10),opacity:1};
   if(layer?.kind==='frame'||layer?.kind==='text')return <div key={target} className="preview-motion-frame-hit" style={style}>
    {(['top','right','bottom','left'] as const).map(edge=><button key={edge} className={`preview-motion-frame-edge edge-${edge}`} aria-label={`Move ${name} on preview, ${edge} edge`} title="Drag the layer edge to move it; arrows nudge" {...handlers}/>)}
   </div>;
   return <button key={target} className="preview-motion-hit" style={style} aria-label={`${cropMode&&target===selectedLayerId?'Pan crop in':'Move'} ${name} on preview`} title={cropMode&&target===selectedLayerId?'Drag to pan source crop':'Drag to move frame; arrows nudge'} {...handlers}/>;
  })}
  {selectedRect&&<div className={`preview-motion-edit-frame ${cropMode?'cropping':''}`} style={{left:selectedRect.x,top:selectedRect.y,width:selectedRect.width,height:selectedRect.height}}>
   <span className="preview-motion-frame-name">{selected?.name??'Primary recording'} · {cropMode?'source crop':'frame before tilt'}</span>
   {cropMode?(['left','right','top','bottom'] as const).map(part=><button key={part} className={`preview-motion-handle crop-${part}`} disabled={!editable||!canCrop} aria-label={`Crop ${selected?.name??'primary recording'} ${part} edge`} title={`Drag to crop ${part}; arrows nudge`} onPointerDown={event=>start(event,selectedLayerId,{kind:'crop',part})} onKeyDown={event=>nudge(event,selectedLayerId,{kind:'crop',part})} {...pointer}/>):(['nw','ne','sw','se'] as const).map(part=><button key={part} className={`preview-motion-handle resize-${part}`} disabled={!editable} aria-label={`Resize ${selected?.name??'primary recording'} ${part} corner`} title="Drag to resize; arrows nudge" onPointerDown={event=>start(event,selectedLayerId,{kind:'frame',part})} onKeyDown={event=>nudge(event,selectedLayerId,{kind:'frame',part})} {...pointer}/>)}
  </div>}
  {toolbarHost?createPortal(<div className="preview-motion-toolbar"><span title={cropMode?'Drag the image to pan; drag an edge to crop.':'Drag a window to move; corners resize its frame before tilt.'}>{cropMode?'Drag image or edge · source crop':'Drag window or corner · frame before tilt'}</span>{!cropMode?<span className="preview-motion-curve-hint" title="Animated positions move the whole curve without changing its timing or shape">Curves move together</span>:null}<button disabled={!editable||!canCrop} aria-pressed={cropMode} onClick={()=>setCropMode(value=>!value)}>{cropMode?'Done cropping':'Crop video'}</button>{cropMode?<button disabled={!editable} onClick={()=>change(value=>{if(value.id!==project.id)return value;const current=value.clips.find(item=>item.id===clip.id);return current?setClipMotion(value,clip.id,resetMotionCrop(current.motion,selectedLayerId)):value;})}>Reset crop</button>:null}</div>,toolbarHost):null}
 </div>;
}
