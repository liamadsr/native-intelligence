import { studioKeys } from '../studio-env';
import React,{useCallback,useEffect,useRef,useState} from 'react';
import type {MotionKey,MotionTrack} from '@/lib/studio/engine/contracts';
import {moveMotionHandle,moveMotionPoint,nudgeMotionHandle} from '@/lib/studio/engine/motion-authoring';
import {motionPropertyLabels} from './motion-labels';
import {StudioSelect} from './controls';

const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
const x=(frame:number,duration:number)=>frame/duration*1000;
const y=(amount:number)=>100-amount*100;

export function motionCurvePath(track:MotionTrack,duration:number):string{
  const keys=track.keys;if(!keys.length)return'';
  let path=`M ${x(keys[0]!.frame,duration)} ${y(keys[0]!.amount)}`;
  for(let index=0;index<keys.length-1;index++){
    const from=keys[index]!,to=keys[index+1]!;
    if(from.mode==='hold')path+=` L ${x(to.frame,duration)} ${y(from.amount)} L ${x(to.frame,duration)} ${y(to.amount)}`;
    else if(from.mode==='linear')path+=` L ${x(to.frame,duration)} ${y(to.amount)}`;
    else path+=` C ${x(from.frame+from.right.dt,duration)} ${y(from.amount+from.right.dv)} ${x(to.frame-to.left.dt,duration)} ${y(to.amount+to.left.dv)} ${x(to.frame,duration)} ${y(to.amount)}`;
  }
  return path;
}

type Gesture={pointerId:number;target:HTMLElement;kind:'point'|'left'|'right';keyId:string;startTrack:MotionTrack};
export function MotionCurveLane({track,duration,disabled,edit,beginEdit,endEdit}:{track:MotionTrack;duration:number;disabled:boolean;edit:(next:MotionTrack)=>void;beginEdit:()=>void;endEdit:(cancel:boolean)=>void}){
  const graph=useRef<HTMLDivElement>(null),gesture=useRef<Gesture|null>(null),[selectedKeyId,setSelectedKeyId]=useState<string|null>(null);
  const selected=track.keys.find(key=>key.id===selectedKeyId)??track.keys[0]!,selectedIndex=track.keys.findIndex(key=>key.id===selected.id);
  const finish=useCallback((cancel:boolean)=>{const current=gesture.current;if(!current)return;gesture.current=null;endEdit(cancel);if(current.target.hasPointerCapture(current.pointerId))current.target.releasePointerCapture(current.pointerId);},[endEdit]);
  useEffect(()=>{const cancel=()=>finish(true),escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&gesture.current){event.preventDefault();event.stopPropagation();cancel();}};window.addEventListener('blur',cancel);studioKeys.addEventListener('keydown',escape,true);return()=>{window.removeEventListener('blur',cancel);studioKeys.removeEventListener('keydown',escape,true);cancel();};},[finish]);
  useEffect(()=>{finish(true);setSelectedKeyId(null);},[track.id,finish]);
  useEffect(()=>{if(disabled)finish(true);},[disabled,finish]);
  const applyPointer=(event:React.PointerEvent<HTMLElement>)=>{const current=gesture.current,box=graph.current?.getBoundingClientRect();if(!current||!box||current.pointerId!==event.pointerId)return;event.preventDefault();event.stopPropagation();
    const frame=clamp(Math.round((event.clientX-box.left)/box.width*duration),0,duration),amount=clamp(1-(event.clientY-box.top)/box.height,0,1),key=current.startTrack.keys.find(item=>item.id===current.keyId)!;
    if(current.kind==='point')edit(moveMotionPoint(current.startTrack,current.keyId,frame,amount));
    else edit(moveMotionHandle(current.startTrack,current.keyId,current.kind,current.kind==='left'?key.frame-frame:frame-key.frame,amount-key.amount));
  };
  const handlers={onPointerMove:applyPointer,onPointerUp:(event:React.PointerEvent<HTMLElement>)=>{if(gesture.current?.pointerId!==event.pointerId)return;applyPointer(event);finish(false);},onPointerCancel:(event:React.PointerEvent<HTMLElement>)=>{if(gesture.current?.pointerId===event.pointerId)finish(true);},onLostPointerCapture:(event:React.PointerEvent<HTMLElement>)=>{if(gesture.current?.pointerId===event.pointerId)finish(true);}};
  const start=(event:React.PointerEvent<HTMLElement>,key:MotionKey,kind:Gesture['kind'])=>{if(disabled||event.button!==0||gesture.current)return;event.preventDefault();event.stopPropagation();setSelectedKeyId(key.id);event.currentTarget.focus();event.currentTarget.setPointerCapture(event.pointerId);beginEdit();gesture.current={pointerId:event.pointerId,target:event.currentTarget,kind,keyId:key.id,startTrack:track};};
  const nudge=(event:React.KeyboardEvent<HTMLElement>,key:MotionKey,kind:Gesture['kind'])=>{if(disabled||gesture.current||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();event.stopPropagation();setSelectedKeyId(key.id);const amountDelta=event.key==='ArrowUp'?.01:event.key==='ArrowDown'?-.01:0,frameDelta=event.key==='ArrowRight'?1:event.key==='ArrowLeft'?-1:0;
    if(kind==='point')edit(moveMotionPoint(track,key.id,key.frame+frameDelta,key.amount+amountDelta));
    else edit(nudgeMotionHandle(track,key.id,kind,event.key as 'ArrowLeft'|'ArrowRight'|'ArrowUp'|'ArrowDown'));
  };
  return <div className="motion-curve-lane" aria-label={`${motionPropertyLabels[track.property]} animation curve, 0 to 100 percent`}><div className="motion-curve-header"><span>{motionPropertyLabels[track.property]} · amount 0–100%</span><label>From point <StudioSelect aria-label="Curve after selected point" value={selected.mode} disabled={disabled||selectedIndex===track.keys.length-1} onChange={v => edit({...track,keys:track.keys.map(key=>key.id===selected.id?{...key,mode:v as MotionKey['mode']}:key)})}><option value="bezier">Smooth</option><option value="linear">Straight</option><option value="hold">Hold</option></StudioSelect></label></div><div className="motion-curve-graph" ref={graph}><span className="motion-curve-max">100</span><span className="motion-curve-min">0</span><svg className="motion-curve-svg" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path d={motionCurvePath(track,duration)} />{track.keys.flatMap((key,index)=>{const lines:React.ReactNode[]=[];if(index&&track.keys[index-1]!.mode==='bezier')lines.push(<line key={`${key.id}-left`} x1={x(key.frame,duration)} y1={y(key.amount)} x2={x(key.frame-key.left.dt,duration)} y2={y(key.amount+key.left.dv)}/>);if(index<track.keys.length-1&&key.mode==='bezier')lines.push(<line key={`${key.id}-right`} x1={x(key.frame,duration)} y1={y(key.amount)} x2={x(key.frame+key.right.dt,duration)} y2={y(key.amount+key.right.dv)}/>);return lines;})}</svg>{track.keys.map((key,index)=>{const prev=track.keys[index-1],next=track.keys[index+1];return <React.Fragment key={key.id}>
      <button className={`motion-curve-point ${selected.id===key.id?'active':''}`} style={{left:`${key.frame/duration*100}%`,top:`${(1-key.amount)*100}%`}} aria-label={`Curve point ${index+1}, ${Math.round(key.amount*100)} percent at frame ${key.frame}`} aria-pressed={selected.id===key.id} disabled={disabled} onClick={()=>setSelectedKeyId(key.id)} onPointerDown={event=>start(event,key,'point')} onKeyDown={event=>nudge(event,key,'point')} {...handlers}/>
      {prev&&prev.mode==='bezier'?<button className="motion-curve-handle" style={{left:`${(key.frame-key.left.dt)/duration*100}%`,top:`${(1-key.amount-key.left.dv)*100}%`}} aria-label={`Curve point ${index+1} incoming handle`} disabled={disabled} onPointerDown={event=>start(event,key,'left')} onKeyDown={event=>nudge(event,key,'left')} {...handlers}/>:null}
      {next&&key.mode==='bezier'?<button className="motion-curve-handle" style={{left:`${(key.frame+key.right.dt)/duration*100}%`,top:`${(1-key.amount-key.right.dv)*100}%`}} aria-label={`Curve point ${index+1} outgoing handle`} disabled={disabled} onPointerDown={event=>start(event,key,'right')} onKeyDown={event=>nudge(event,key,'right')} {...handlers}/>:null}
    </React.Fragment>;})}</div><div className="motion-curve-point-fields"><label>Frame <input aria-label="Selected curve point frame" type="number" min={selectedIndex?track.keys[selectedIndex-1]!.frame+1:0} max={selectedIndex<track.keys.length-1?track.keys[selectedIndex+1]!.frame-1:duration} value={selected.frame} disabled={disabled||selectedIndex===0||selectedIndex===track.keys.length-1} onChange={event=>edit(moveMotionPoint(track,selected.id,Number(event.target.value),selected.amount))}/></label><label>Amount % <input aria-label="Selected curve point amount percent" type="number" min={0} max={100} value={Math.round(selected.amount*100)} disabled={disabled} onChange={event=>edit(moveMotionPoint(track,selected.id,selected.frame,Number(event.target.value)/100))}/></label><button disabled={disabled||selectedIndex===0||selectedIndex===track.keys.length-1} onClick={()=>{edit({...track,keys:track.keys.filter(key=>key.id!==selected.id)});setSelectedKeyId(track.keys[selectedIndex-1]!.id);}}>Remove point</button></div></div>;
}
