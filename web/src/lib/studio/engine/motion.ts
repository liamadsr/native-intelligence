import type { EditorAsset, EditorClip } from './contracts';
import { motionPropertyBounds, type EditorMotion, type MotionKey, type MotionLayer, type MotionProperty, type MotionTrack, type MotionVisual } from './motion-contracts';

const clamp=(n:number,min:number,max:number)=>Math.max(min,Math.min(max,n));
const zeroHandle=()=>({dt:0,dv:0});
const cubic=(a:number,b:number,c:number,d:number,t:number)=>{const u=1-t;return u*u*u*a+3*u*u*t*b+3*u*t*t*c+t*t*t*d;};
const lerp=(a:number,b:number,t:number)=>a+(b-a)*t;

type Point={x:number;y:number};
const mix=(a:Point,b:Point,t:number):Point=>({x:lerp(a.x,b.x,t),y:lerp(a.y,b.y,t)});
function controls(a:MotionKey,b:MotionKey):[Point,Point,Point,Point]{return[
  {x:a.frame,y:a.amount},
  {x:a.frame+a.right.dt,y:a.amount+a.right.dv},
  {x:b.frame-b.left.dt,y:b.amount+b.left.dv},
  {x:b.frame,y:b.amount},
];}
function bezierParameter(points:[Point,Point,Point,Point],frame:number){let lo=0,hi=1;for(let i=0;i<40;i++){const middle=(lo+hi)/2;if(cubic(points[0].x,points[1].x,points[2].x,points[3].x,middle)<frame)lo=middle;else hi=middle;}return(lo+hi)/2;}
export function evaluateMotionAmount(track:MotionTrack,frame:number):number{
  const keys=track.keys;if(frame<=keys[0]!.frame)return keys[0]!.amount;if(frame>=keys.at(-1)!.frame)return keys.at(-1)!.amount;
  const index=keys.findIndex(key=>key.frame>frame),a=keys[index-1]!,b=keys[index]!;
  if(a.mode==='hold')return a.amount;
  if(a.mode==='linear')return lerp(a.amount,b.amount,(frame-a.frame)/(b.frame-a.frame));
  const p=controls(a,b),t=bezierParameter(p,frame);
  return clamp(cubic(p[0].y,p[1].y,p[2].y,p[3].y,t),0,1);
}
export function evaluateMotionProperty(track:MotionTrack,frame:number):number{
  const [min,max]=motionPropertyBounds[track.property];
  return clamp(lerp(track.from,track.to,evaluateMotionAmount(track,frame)),min,max);
}
function setVisualProperty(visual:MotionVisual,property:MotionProperty,value:number):MotionVisual{
  if(property==='x'||property==='y'||property==='width'||property==='height')return {...visual,rect:{...visual.rect,[property]:value}};
  return {...visual,[property]:value};
}
export type EvaluatedMotion={primary:MotionVisual;layers:(MotionLayer&{visual:MotionVisual})[]};
/** Clip-local frame evaluation shared by Player and offline render. Rects are normalized output coordinates. */
export function evaluateMotionAtFrame(clip:Pick<EditorClip,'motion'>,localFrame:number):EvaluatedMotion{
  const motion=clip.motion,values=new Map<string,MotionVisual>();values.set('primary',motion.primary);
  for(const layer of motion.layers)if(localFrame>=layer.startFrame&&localFrame<layer.endFrame)values.set(layer.id,layer.visual);
  for(const track of motion.tracks){const current=values.get(track.target);if(current)values.set(track.target,setVisualProperty(current,track.property,evaluateMotionProperty(track,localFrame)));}
  return {primary:values.get('primary')!,layers:motion.layers.filter(layer=>values.has(layer.id)).sort((a,b)=>a.zIndex-b.zIndex).map(layer=>({...layer,visual:values.get(layer.id)!}))};
}
function boundaryId(track:MotionTrack,frame:number,keys:MotionKey[]){const stem=`boundary-${track.id.slice(0,50)}-${frame}`.slice(0,90);let id=stem,ordinal=1;while(keys.some(key=>key.id===id))id=`${stem}-${ordinal++}`;return id;}
function insertBoundary(keys:MotionKey[],track:MotionTrack,frame:number):MotionKey[]{
  if(keys.some(key=>key.frame===frame))return keys;
  const first=keys[0]!,last=keys.at(-1)!;
  if(frame<first.frame)return[{id:boundaryId(track,frame,keys),frame,amount:first.amount,mode:'hold',left:zeroHandle(),right:zeroHandle()},...keys];
  if(frame>last.frame)return[...keys,{id:boundaryId(track,frame,keys),frame,amount:last.amount,mode:'hold',left:zeroHandle(),right:zeroHandle()}];
  const index=keys.findIndex(key=>key.frame>frame),a=keys[index-1]!,b=keys[index]!;
  if(a.mode!=='bezier')return[...keys.slice(0,index),{id:boundaryId(track,frame,keys),frame,amount:evaluateMotionAmount({...track,keys},frame),mode:a.mode,left:zeroHandle(),right:zeroHandle()},...keys.slice(index)];
  const [p0,p1,p2,p3]=controls(a,b),t=bezierParameter([p0,p1,p2,p3],frame),q0=mix(p0,p1,t),q1=mix(p1,p2,t),q2=mix(p2,p3,t),r0=mix(q0,q1,t),r1=mix(q1,q2,t),center=mix(r0,r1,t);
  const amount=clamp(center.y,0,1),at:MotionKey={id:boundaryId(track,frame,keys),frame,amount,mode:'bezier',left:{dt:frame-r0.x,dv:r0.y-amount},right:{dt:r1.x-frame,dv:r1.y-amount}};
  return[...keys.slice(0,index-1),{...a,right:{dt:q0.x-p0.x,dv:q0.y-a.amount}},at,{...b,left:{dt:p3.x-q2.x,dv:q2.y-b.amount}},...keys.slice(index+1)];
}
/** Adds an editable point without changing the curve on either side. */
export function insertMotionKey(track:MotionTrack,frame:number):MotionTrack{
  if(!Number.isInteger(frame)||frame<0||track.keys.some(key=>key.frame===frame))return track;
  return {...track,keys:insertBoundary(track.keys,track,frame)};
}
export function sliceMotionTrack(track:MotionTrack,startFrame:number,endFrame:number):MotionTrack{
  if(endFrame<=startFrame)throw new Error('Motion slice needs at least one frame');
  let keys=insertBoundary(track.keys,track,startFrame);keys=insertBoundary(keys,track,endFrame);
  keys=keys.filter(key=>key.frame>=startFrame&&key.frame<=endFrame).map(key=>({...key,frame:key.frame-startFrame,left:{...key.left},right:{...key.right}}));
  keys[0]={...keys[0]!,left:zeroHandle()};keys[keys.length-1]={...keys.at(-1)!,right:zeroHandle()};
  return {...track,keys};
}
/** Keeps visual motion at cut boundaries; video overlays follow their own immutable source time. */
export function sliceMotion(motion:EditorMotion,startFrame:number,endFrame:number,projectFps:number,assets:readonly EditorAsset[],playbackRate=1):EditorMotion{
  if(endFrame<=startFrame)throw new Error('Motion slice needs at least one frame');
  const layers:MotionLayer[]=[];
  for(const layer of motion.layers){const from=Math.max(startFrame,layer.startFrame),to=Math.min(endFrame,layer.endFrame);if(to<=from)continue;
    if(layer.kind==='video'){const asset=assets.find(a=>a.id===layer.assetId);if(!asset?.sourceFps||!asset.sourceFrames)throw new Error('Motion video source is unavailable');const sourceStartFrame=Math.min(asset.sourceFrames-1,layer.sourceStartFrame+Math.round((from-layer.startFrame)*asset.sourceFps/projectFps*playbackRate));layers.push({...layer,startFrame:from-startFrame,endFrame:to-startFrame,sourceStartFrame});}
    else layers.push({...layer,startFrame:from-startFrame,endFrame:to-startFrame});
  }
  const targets=new Set(['primary',...layers.map(layer=>layer.id)]);
  return {canvas:{...motion.canvas},primary:structuredClone(motion.primary),layers,tracks:motion.tracks.filter(track=>targets.has(track.target)).map(track=>sliceMotionTrack(track,startFrame,endFrame))};
}
/** Creates one saved amount curve for a smooth side reveal, optionally returning offscreen. */
export function sideEntranceTrack(layer:MotionLayer,durationFrames:number,side:'left'|'right',exitFrames=0):MotionTrack{
  const start=layer.startFrame,end=Math.min(durationFrames,layer.endFrame),span=end-start;
  const enter=Math.max(1,Math.min(Math.floor(span/2),Math.round(span*.16))),exit=Math.max(0,Math.min(Math.floor(span/2),exitFrames));
  const shown=layer.visual.rect.x,hidden=side==='left'?-(layer.visual.rect.width+.05):1.05;
  const key=(id:string,frame:number,amount:number,mode:'hold'|'linear'|'bezier'):MotionKey=>({id,frame,amount,mode,left:zeroHandle(),right:zeroHandle()});
  const keys=[key(`${layer.id}-entrance-start`,start,0,'bezier'),key(`${layer.id}-entrance-end`,start+enter,1,'hold')];
  keys[0]!.right={dt:enter*.4,dv:0};keys[1]!.left={dt:enter*.4,dv:0};
  if(exit&&end-exit>start+enter){keys[1]!.mode='hold';keys.push(key(`${layer.id}-exit-start`,end-exit,1,'bezier'),key(`${layer.id}-exit-end`,end,0,'hold'));keys[keys.length-2]!.right={dt:exit*.4,dv:0};keys[keys.length-1]!.left={dt:exit*.4,dv:0};}
  return {id:`${layer.id}-slide-x`.slice(0,100),target:layer.id,property:'x',from:hidden,to:shown,keys};
}
