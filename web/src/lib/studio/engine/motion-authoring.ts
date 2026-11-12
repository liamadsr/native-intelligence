import type { EditorAsset, EditorClip } from './contracts';
import { motionPropertyBounds, neutralMotionVisual, type EditorMotion, type MotionKey, type MotionLayer, type MotionProperty, type MotionTrack, type MotionVisual } from './motion-contracts';
import { sideEntranceTrack, sliceMotionTrack } from './motion';

export type MotionLayerKind=MotionLayer['kind'];
const visual=(x:number,y:number,width:number,height:number):MotionVisual=>({...structuredClone(neutralMotionVisual),rect:{x,y,width,height}});
export function createMotionLayer(kind:MotionLayerKind,id:string,assetId:string,durationFrames:number,zIndex:number):MotionLayer{
  const common={id,name:{video:'Video window',text:'Headline',frame:'Frame',highlight:'Highlight'}[kind],startFrame:0,endFrame:durationFrames,zIndex,visual:visual(.15,.15,.7,.7)};
  if(kind==='video')return{...common,kind,assetId,sourceStartFrame:0};
  if(kind==='text')return{...common,kind,text:'Your headline',font:'serif',fontSizePx:72,color:'#ffffff',weight:'medium',align:'center'};
  if(kind==='frame')return{...common,kind,strokeColor:'#ffffff',strokeWidthPx:6,radiusPx:24};
  return{...common,kind,fillColor:'#ffdf5a66',strokeColor:'#ffdf5a',radiusPx:20};
}
export function motionPropertyValue(visual:MotionVisual,property:MotionProperty){return property==='x'||property==='y'||property==='width'||property==='height'?visual.rect[property]:visual[property];}
export function motionAutomationEndpoints(property:MotionProperty,current:number):{from:number;to:number}{
  const defaults:Record<MotionProperty,{from:number;to:number}>={
    x:{from:current-.3,to:current},y:{from:current+.2,to:current},width:{from:current*.75,to:current},height:{from:current*.75,to:current},
    scale:{from:1,to:current===1?1.5:current},tiltX:{from:0,to:current===0?25:current},tiltY:{from:0,to:current===0?25:current},rotateZ:{from:0,to:current===0?12:current},opacity:{from:0,to:current},
  };
  const [min,max]=motionPropertyBounds[property];
  return {from:clamp(defaults[property].from,min,max),to:clamp(defaults[property].to,min,max)};
}
export function createMotionTrack(id:string,target:string,property:MotionProperty,from:number,to:number,durationFrames:number):MotionTrack{
  const duration=Math.max(1,durationFrames),handle=duration/3;
  return{id,target,property,from,to,keys:[{id:`${id.slice(0,74)}-start`,frame:0,amount:0,mode:'bezier',left:{dt:0,dv:0},right:{dt:handle,dv:0}},{id:`${id.slice(0,74)}-end`,frame:duration,amount:1,mode:'hold',left:{dt:handle,dv:0},right:{dt:0,dv:0}}]};
}
/** A ready-to-tune centered panel plus two cropped side windows. */
export function threeWindowPreset(clip:EditorClip,durationFrames:number,ids:[string,string]):EditorMotion{
  const left=createMotionLayer('video',ids[0],clip.assetId,durationFrames,1),right=createMotionLayer('video',ids[1],clip.assetId,durationFrames,2);
  if(left.kind!=='video'||right.kind!=='video')throw new Error('Video layer setup failed');
  left.visual.rect={x:.02,y:.24,width:.26,height:.52};left.visual.crop={x:0,y:.1,width:.4,height:.8};
  right.visual.rect={x:.72,y:.24,width:.26,height:.52};right.visual.crop={x:.6,y:.1,width:.4,height:.8};
  const primary=structuredClone(clip.motion.primary);primary.rect={x:.25,y:.08,width:.5,height:.84};
  return{...clip.motion,primary,layers:[...clip.motion.layers,left,right],tracks:[...clip.motion.tracks,sideEntranceTrack(left,durationFrames,'left',Math.min(18,Math.floor(durationFrames/5))),sideEntranceTrack(right,durationFrames,'right',Math.min(18,Math.floor(durationFrames/5)))]};
}
export function titleSlidePreset(motion:EditorMotion,durationFrames:number,id:string):EditorMotion{
  const title=createMotionLayer('text',id,'',durationFrames,Math.max(1,...motion.layers.map(layer=>layer.zIndex+1)));
  if(title.kind!=='text')throw new Error('Title layer setup failed');
  title.visual.rect={x:.1,y:.24,width:.8,height:.52};title.fontSizePx=92;title.text='Your headline';
  return{...motion,canvas:{kind:'gradient',color:'#211a3f',color2:'#8559b8',angle:135},primary:{...motion.primary,opacity:0},layers:[...motion.layers,title]};
}
export function closeupPreset(motion:EditorMotion):EditorMotion{
  return{...motion,primary:{...motion.primary,rect:{x:.08,y:.08,width:.84,height:.84},crop:{x:.28,y:.22,width:.44,height:.52},scale:1.12,tiltX:0,tiltY:0,rotateZ:0,opacity:1}};
}
export function sourceOptions(assets:readonly EditorAsset[]){return assets.filter(asset=>asset.kind==='video');}

const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));
/** A key's neighboring frames and curve handles remain valid while it is dragged. */
export function moveMotionPoint(track:MotionTrack,keyId:string,frame:number,amount:number):MotionTrack{
  const index=track.keys.findIndex(key=>key.id===keyId);if(index<0)return track;
  const old=track.keys[index]!,before=track.keys[index-1],after=track.keys[index+1];
  const nextFrame=before&&after?clamp(Math.round(frame),before.frame+1,after.frame-1):old.frame;
  const nextAmount=clamp(amount,0,1);
  const keys=track.keys.map((key,i):MotionKey=>{
    if(i===index)return {...key,frame:nextFrame,amount:nextAmount,left:{dt:Math.min(key.left.dt,before?Math.max(0,nextFrame-before.frame-before.right.dt):0),dv:clamp(key.left.dv,-nextAmount,1-nextAmount)},right:{dt:Math.min(key.right.dt,after?Math.max(0,after.frame-nextFrame-after.left.dt):0),dv:clamp(key.right.dv,-nextAmount,1-nextAmount)}};
    if(i===index-1)return {...key,right:{...key.right,dt:Math.min(key.right.dt,nextFrame-key.frame)}};
    if(i===index+1)return {...key,left:{...key.left,dt:Math.min(key.left.dt,key.frame-nextFrame)}};
    return key;
  });
  return {...track,keys};
}
export function moveMotionHandle(track:MotionTrack,keyId:string,side:'left'|'right',dt:number,dv:number):MotionTrack{
  const index=track.keys.findIndex(key=>key.id===keyId);if(index<0)return track;
  const key=track.keys[index]!,neighbor=side==='left'?track.keys[index-1]:track.keys[index+1];
  if(!neighbor)return track;
  const span=Math.abs(key.frame-neighbor.frame),other=side==='left'?neighbor.right.dt:neighbor.left.dt;
  const handle={dt:clamp(dt,0,Math.max(0,span-other)),dv:clamp(dv,-key.amount,1-key.amount)};
  return {...track,keys:track.keys.map(item=>item.id===keyId?{...item,[side]:handle}:item)};
}
export function nudgeMotionHandle(track:MotionTrack,keyId:string,side:'left'|'right',arrow:'ArrowLeft'|'ArrowRight'|'ArrowUp'|'ArrowDown'):MotionTrack{
  const key=track.keys.find(item=>item.id===keyId);if(!key)return track;
  const horizontal=arrow==='ArrowRight'?1:arrow==='ArrowLeft'?-1:0;
  const vertical=arrow==='ArrowUp'?.01:arrow==='ArrowDown'?-.01:0;
  return moveMotionHandle(track,keyId,side,key[side].dt+(side==='left'?-horizontal:horizontal),key[side].dv+vertical);
}

/** Edits a visual strip without changing the primary picture or its audio. */
export function editMotionLayerSpan(motion:EditorMotion,layerId:string,mode:'move'|'start'|'end',deltaFrames:number,durationFrames:number,projectFps:number,assets:readonly EditorAsset[]):EditorMotion{
  const layer=motion.layers.find(item=>item.id===layerId);if(!layer)return motion;
  const requested=Math.round(deltaFrames);
  let start=layer.startFrame,end=layer.endFrame;
  if(mode==='move'){const delta=clamp(requested,-start,durationFrames-end);start+=delta;end+=delta;}
  if(mode==='start')start=clamp(start+requested,0,end-1);
  if(mode==='end')end=clamp(end+requested,start+1,durationFrames);
  if(start===layer.startFrame&&end===layer.endFrame)return motion;
  const shift=start-layer.startFrame;
  const changed=motion.layers.map(item=>{
    if(item.id!==layerId)return item;
    if(item.kind!=='video'||mode!=='start')return {...item,startFrame:start,endFrame:end};
    const asset=assets.find(asset=>asset.id===item.assetId);
    if(!asset?.sourceFps||!asset.sourceFrames)throw new Error('Visual layer footage is unavailable');
    const sourceStartFrame=clamp(item.sourceStartFrame+Math.round(shift*asset.sourceFps/projectFps),0,asset.sourceFrames-1);
    return {...item,startFrame:start,endFrame:end,sourceStartFrame};
  });
  const tracks=mode==='move'?motion.tracks.map(track=>track.target===layerId?sliceMotionTrack({...track,keys:track.keys.map(key=>({...key,frame:key.frame+shift}))},0,durationFrames):track):motion.tracks;
  return {...motion,layers:changed,tracks};
}
