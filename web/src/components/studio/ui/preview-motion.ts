import { motionPropertyBounds,type EditorMotion,type MotionProperty,type MotionVisual } from '@/lib/studio/engine/motion-contracts';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import {primaryRect,type PixelRect} from '@/lib/studio/engine/motion-render';

export type FrameGesture='move'|'nw'|'ne'|'sw'|'se';
export type CropGesture='pan'|'left'|'right'|'top'|'bottom';
export function primaryPreviewCropRect(legacyOutput:PixelRect,visual:MotionVisual,outputWidth:number,outputHeight:number,previewWidth:number):PixelRect{
 const output=primaryRect(legacyOutput,visual,outputWidth,outputHeight),scale=previewWidth/outputWidth;
 return{x:output.x*scale,y:output.y*scale,width:output.width*scale,height:output.height*scale};
}
export function setClipMotion(project:EditorProject,clipId:string,motion:EditorMotion):EditorProject{
 const clip=project.clips.find(item=>item.id===clipId);if(!clip||clip.motion===motion)return project;
 return {...project,clips:project.clips.map(item=>item.id===clipId?{...item,motion}:item)};
}
type RectProperty=Extract<MotionProperty,'x'|'y'|'width'|'height'>;
type AxisCoefficients=Partial<Record<RectProperty,number>>;
const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(max,value));

function targetVisual(motion:EditorMotion,target:string):MotionVisual|undefined{
 return target==='primary'?motion.primary:motion.layers.find(layer=>layer.id===target)?.visual;
}
function shiftLimit(motion:EditorMotion,target:string,coefficients:AxisCoefficients):[number,number]{
 const visual=targetVisual(motion,target);if(!visual)return[0,0];
 let low=-Infinity,high=Infinity;
 for(const [property,coefficient] of Object.entries(coefficients) as [RectProperty,number][]){
  if(!coefficient)continue;
  const [min,max]=motionPropertyBounds[property],track=motion.tracks.find(track=>track.target===target&&track.property===property);
  for(const value of [visual.rect[property],...(track?[track.from,track.to]:[])]){
   const a=(min-value)/coefficient,b=(max-value)/coefficient;
   low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));
  }
 }
 return [low,high];
}
function shiftAxis(motion:EditorMotion,target:string,coefficients:AxisCoefficients,requested:number):EditorMotion{
 const visual=targetVisual(motion,target);if(!visual||!Number.isFinite(requested))return motion;
 const [low,high]=shiftLimit(motion,target,coefficients),delta=clamp(requested,low,high);
 if(delta===0)return motion;
 const shifts=Object.fromEntries(Object.entries(coefficients).map(([key,value])=>[key,value*delta])) as Partial<Record<RectProperty,number>>;
 const nextVisual={...visual,rect:{...visual.rect}};
 for(const [property,amount] of Object.entries(shifts) as [RectProperty,number][])nextVisual.rect[property]+=amount;
 return {...motion,primary:target==='primary'?nextVisual:motion.primary,
  layers:target==='primary'?motion.layers:motion.layers.map(layer=>layer.id===target?{...layer,visual:nextVisual}:layer),
  tracks:motion.tracks.map(track=>track.target===target&&track.property in shifts?{...track,from:track.from+shifts[track.property as RectProperty]!,to:track.to+shifts[track.property as RectProperty]!}:track)};
}

/** Pointer deltas use fractions of the output frame. One bounded offset moves base and animated endpoints together. */
export function dragMotionFrame(motion:EditorMotion,target:string,gesture:FrameGesture,dx:number,dy:number):EditorMotion{
 const horizontal:AxisCoefficients=gesture==='move'?{x:1}:gesture==='nw'||gesture==='sw'?{x:1,width:-1}:{width:1};
 const vertical:AxisCoefficients=gesture==='move'?{y:1}:gesture==='nw'||gesture==='ne'?{y:1,height:-1}:{height:1};
 return shiftAxis(shiftAxis(motion,target,horizontal,dx),target,vertical,dy);
}

/** Source crop moves inside its immutable media; no crop animation track exists in V3. */
export function dragMotionCrop(motion:EditorMotion,target:string,gesture:CropGesture,dx:number,dy:number):EditorMotion{
 const visual=targetVisual(motion,target);if(!visual||![dx,dy].every(Number.isFinite))return motion;
 const crop={...visual.crop};
 if(gesture==='pan'){crop.x=clamp(crop.x-dx,0,1-crop.width);crop.y=clamp(crop.y-dy,0,1-crop.height);}
 if(gesture==='left'){const amount=clamp(dx,-crop.x,crop.width-.001);crop.x+=amount;crop.width-=amount;}
 if(gesture==='right')crop.width=clamp(crop.width+dx,.001,1-crop.x);
 if(gesture==='top'){const amount=clamp(dy,-crop.y,crop.height-.001);crop.y+=amount;crop.height-=amount;}
 if(gesture==='bottom')crop.height=clamp(crop.height+dy,.001,1-crop.y);
 if(crop.x===visual.crop.x&&crop.y===visual.crop.y&&crop.width===visual.crop.width&&crop.height===visual.crop.height)return motion;
 const nextVisual={...visual,crop};
 return target==='primary'?{...motion,primary:nextVisual}:{...motion,layers:motion.layers.map(layer=>layer.id===target?{...layer,visual:nextVisual}:layer)};
}

export function resetMotionCrop(motion:EditorMotion,target:string):EditorMotion{
 const visual=targetVisual(motion,target);if(!visual)return motion;
 if(visual.crop.x===0&&visual.crop.y===0&&visual.crop.width===1&&visual.crop.height===1)return motion;
 const nextVisual={...visual,crop:{x:0,y:0,width:1,height:1}};
 return target==='primary'?{...motion,primary:nextVisual}:{...motion,layers:motion.layers.map(layer=>layer.id===target?{...layer,visual:nextVisual}:layer)};
}
