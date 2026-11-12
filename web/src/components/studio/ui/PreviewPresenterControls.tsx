import { studioKeys } from '../studio-env';
import React,{useCallback,useEffect,useRef} from 'react';
import type {EditorProject} from '@/lib/studio/engine/contracts';
import {presenterRadius,presenterStateAtFrame} from '@/lib/studio/engine/presenter';
import {outputRect} from '@/lib/studio/engine/motion-render';
import {dragPresenter} from './presenter-frame';
import {movePresenterFrom,presenterMoveSeconds} from '@/lib/studio/engine/presenter-position';
/** Moving the bubble applies from the playhead onward (a short glide), so it can step aside when it covers something. */
function moveFromPlayhead(base:EditorProject,frame:number,dx:number,dy:number):EditorProject{
 const state=presenterStateAtFrame(base,frame),track=base.presenterTrack;if(!state||!track)return base;
 const moved=movePresenterFrom(state.segment,state.localFrame,state.visual.rect.x+dx,state.visual.rect.y+dy,Math.round(presenterMoveSeconds*base.output.fps));
 return {...base,presenterTrack:{...track,segments:track.segments.map(item=>item.id===moved.id?moved:item)}};
}
import type {FrameGesture} from './preview-motion';

type Gesture={pointerId:number;element:HTMLElement;projectId:string;segmentId:string;frame:number;part:FrameGesture;startX:number;startY:number;lastX:number;lastY:number;width:number;height:number;base:EditorProject};
type Props={project:EditorProject;frame:number;previewWidth:number;enabled:boolean;disabled:boolean;change:(fn:(project:EditorProject)=>EditorProject)=>void;beginEdit:()=>void;endEdit:(cancel:boolean)=>void};
const arrow=(key:string)=>key==='ArrowLeft'?[-1,0]:key==='ArrowRight'?[1,0]:key==='ArrowUp'?[0,-1]:key==='ArrowDown'?[0,1]:null;
export function PreviewPresenterControls({project,frame,previewWidth,enabled,disabled,change,beginEdit,endEdit}:Props){
 const gesture=useRef<Gesture|null>(null),track=project.presenterTrack;
 const state=track?presenterStateAtFrame(project,frame):null,bubble=!!state&&state.view.main!=='camera'&&state.view.bubble;
 const segment=bubble?state!.segment:undefined;
 const visual=bubble?state!.visual:null;
 const previewHeight=previewWidth*project.output.height/project.output.width;
 const region=visual?outputRect(visual,previewWidth,previewHeight):null;
 const side=region?Math.min(region.width,region.height):0;
 const square=region?{x:region.x+(region.width-side)/2,y:region.y+(region.height-side)/2,width:side,height:side}:null;
 const finish=useCallback((cancel:boolean)=>{const current=gesture.current;if(!current)return;gesture.current=null;if(current.element.hasPointerCapture(current.pointerId))current.element.releasePointerCapture(current.pointerId);endEdit(cancel);},[endEdit]);
 useEffect(()=>{const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&gesture.current){event.preventDefault();event.stopPropagation();finish(true);}};const blur=()=>finish(true);studioKeys.addEventListener('keydown',escape,true);window.addEventListener('blur',blur);return()=>{studioKeys.removeEventListener('keydown',escape,true);window.removeEventListener('blur',blur);finish(true);};},[finish]);
 useEffect(()=>{const current=gesture.current;if(current&&(current.projectId!==project.id||current.segmentId!==segment?.id||current.frame!==frame||!enabled||disabled))finish(true);},[project.id,segment?.id,frame,enabled,disabled,finish]);
 const deltaFor=(g:Gesture,x:number,y:number):[number,number]=>{
  const dx=x/g.width,dy=y/g.height;if(g.part==='move')return[dx,dy];
  const ratio=project.output.width/project.output.height,signX=g.part.endsWith('w')?-1:1,signY=g.part.startsWith('n')?-1:1;
  const horizontal=signX*dx,vertical=signY*dy/ratio,d=Math.abs(horizontal)>Math.abs(vertical)?horizontal:vertical;
  return[signX*d,signY*d*ratio];
 };
 const edit=(g:Gesture,x:number,y:number)=>{if(x===g.lastX&&y===g.lastY)return;g.lastX=x;g.lastY=y;const [dx,dy]=deltaFor(g,x,y),next=g.part==='move'?moveFromPlayhead(g.base,g.frame,dx,dy):dragPresenter(g.base,g.segmentId,g.part,dx,dy);
  change(current=>current.id===g.projectId?{...current,presenterTrack:next.presenterTrack}:current);
 };
 const start=(event:React.PointerEvent<HTMLElement>,part:FrameGesture)=>{if(disabled||!enabled||!segment||event.button!==0||gesture.current)return;const shell=event.currentTarget.closest('.preview-shell') as HTMLElement|null,box=shell?.getBoundingClientRect();if(!box?.width||!box.height)return;event.preventDefault();event.stopPropagation();beginEdit();event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);gesture.current={pointerId:event.pointerId,element:event.currentTarget,projectId:project.id,segmentId:segment.id,frame,part,startX:event.clientX,startY:event.clientY,lastX:0,lastY:0,width:box.width,height:box.height,base:project};};
 const move=(event:React.PointerEvent<HTMLElement>)=>{const current=gesture.current;if(!current||current.pointerId!==event.pointerId)return;event.preventDefault();event.stopPropagation();edit(current,event.clientX-current.startX,event.clientY-current.startY);};
 const pointer={onPointerMove:move,onPointerUp:(event:React.PointerEvent<HTMLElement>)=>{if(gesture.current?.pointerId!==event.pointerId)return;move(event);finish(false);},onPointerCancel:(event:React.PointerEvent<HTMLElement>)=>{if(gesture.current?.pointerId===event.pointerId)finish(true);},onLostPointerCapture:(event:React.PointerEvent<HTMLElement>)=>{if(gesture.current?.pointerId===event.pointerId)finish(true);}};
 const nudge=(event:React.KeyboardEvent,part:FrameGesture)=>{const direction=arrow(event.key);if(!direction||!segment||disabled)return;event.preventDefault();event.stopPropagation();const step=event.shiftKey?.025:.005;const fake:Gesture={pointerId:-1,element:event.currentTarget as HTMLElement,projectId:project.id,segmentId:segment.id,frame,part,startX:0,startY:0,lastX:0,lastY:0,width:1,height:1,base:project};const [dx,dy]=deltaFor(fake,direction[0]!*step,direction[1]!*step);change(current=>current.id===project.id?(part==='move'?moveFromPlayhead(current,frame,dx,dy):dragPresenter(current,segment.id,part,dx,dy)):current);};
 if(!enabled||disabled||!square||!segment)return null;
 return <div className="preview-presenter-controls" aria-label="Presenter on-preview controls"><button className="preview-presenter-hit" style={{left:square.x,top:square.y,width:square.width,height:square.height}} aria-label="Move presenter circle on preview" title="Drag presenter circle to move it; arrow keys nudge" onPointerDown={event=>start(event,'move')} onKeyDown={event=>nudge(event,'move')} {...pointer}/><div className="preview-presenter-outline" style={{left:square.x,top:square.y,width:square.width,height:square.height,borderRadius:presenterRadius(track?.style,square.width)}}><span>Drag to move from here · corners resize</span>{(['nw','ne','sw','se'] as const).map(part=><button key={part} className={`preview-motion-handle resize-${part}`} aria-label={`Resize presenter circle ${part} corner`} title="Drag to resize presenter circle; arrows nudge" onPointerDown={event=>start(event,part)} onKeyDown={event=>nudge(event,part)} {...pointer}/>)}</div></div>;
}
