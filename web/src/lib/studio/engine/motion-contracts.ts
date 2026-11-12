import { z } from 'zod';

const finite=z.number().finite(), frame=z.number().int().min(0).max(10_000_000);
const token=z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const color=z.string().regex(/^#[\da-fA-F]{6}(?:[\da-fA-F]{2})?$/);
const norm=finite.min(0).max(1);
export const MotionRectSchema=z.object({x:finite.min(-2).max(2),y:finite.min(-2).max(2),width:finite.min(.01).max(3),height:finite.min(.01).max(3)}).strict();
export const MotionCropSchema=z.object({x:norm,y:norm,width:finite.min(.001).max(1),height:finite.min(.001).max(1)}).strict().refine(c=>c.x+c.width<=1+1e-9&&c.y+c.height<=1+1e-9,'Crop must stay inside the source');
export const MotionVisualSchema=z.object({rect:MotionRectSchema,crop:MotionCropSchema,scale:finite.min(.1).max(8),tiltX:finite.min(-80).max(80),tiltY:finite.min(-80).max(80),rotateZ:finite.min(-180).max(180),opacity:norm}).strict();
export type MotionVisual=z.infer<typeof MotionVisualSchema>;
export const neutralMotionVisual:MotionVisual={rect:{x:0,y:0,width:1,height:1},crop:{x:0,y:0,width:1,height:1},scale:1,tiltX:0,tiltY:0,rotateZ:0,opacity:1};
const LayerBaseSchema=z.object({id:token,name:z.string().min(1).max(100),startFrame:frame,endFrame:frame.positive(),zIndex:z.number().int().min(0).max(1000),visual:MotionVisualSchema}).strict();
export const MotionLayerSchema=z.discriminatedUnion('kind',[
  LayerBaseSchema.extend({kind:z.literal('video'),assetId:token,sourceStartFrame:frame}).strict(),
  LayerBaseSchema.extend({kind:z.literal('text'),text:z.string().min(1).max(1000),font:z.enum(['sans','serif','mono']),fontSizePx:finite.min(.1).max(500),color,weight:z.enum(['regular','medium','bold']),align:z.enum(['left','center','right'])}).strict(),
  LayerBaseSchema.extend({kind:z.literal('frame'),strokeColor:color,strokeWidthPx:finite.min(.01).max(100),radiusPx:finite.min(0).max(500)}).strict(),
  LayerBaseSchema.extend({kind:z.literal('highlight'),fillColor:color,strokeColor:color,radiusPx:finite.min(0).max(500)}).strict(),
]).refine(layer=>layer.endFrame>layer.startFrame,'Layer end must follow start');
export type MotionLayer=z.infer<typeof MotionLayerSchema>;
export const MotionPropertySchema=z.enum(['x','y','width','height','scale','tiltX','tiltY','rotateZ','opacity']);
export type MotionProperty=z.infer<typeof MotionPropertySchema>;
export const motionPropertyBounds:Record<MotionProperty,readonly[number,number]>={x:[-2,2],y:[-2,2],width:[.01,3],height:[.01,3],scale:[.1,8],tiltX:[-80,80],tiltY:[-80,80],rotateZ:[-180,180],opacity:[0,1]};
export const MotionHandleSchema=z.object({dt:finite.min(0).max(10_000_000),dv:finite.min(-1).max(1)}).strict();
export const MotionKeySchema=z.object({id:token,frame,amount:norm,mode:z.enum(['hold','linear','bezier']),left:MotionHandleSchema,right:MotionHandleSchema}).strict();
export type MotionKey=z.infer<typeof MotionKeySchema>;
export const MotionTrackSchema=z.object({id:token,target:token,property:MotionPropertySchema,from:finite,to:finite,keys:z.array(MotionKeySchema).min(2).max(1000)}).strict().superRefine((track,ctx)=>{
  const [min,max]=motionPropertyBounds[track.property];if(track.from<min||track.from>max||track.to<min||track.to>max)ctx.addIssue({code:'custom',message:`${track.property} endpoints exceed their bounds`});
  const ids=new Set<string>();for(let i=0;i<track.keys.length;i++){const key=track.keys[i]!;if(ids.has(key.id))ctx.addIssue({code:'custom',message:'Motion key IDs must be unique'});ids.add(key.id);if(i){const previous=track.keys[i-1]!,gap=key.frame-previous.frame;if(gap<=0||previous.right.dt+key.left.dt>gap)ctx.addIssue({code:'custom',message:'Motion handles must have increasing time and stay inside their segment'});if(previous.mode==='bezier'&&(previous.amount+previous.right.dv<0||previous.amount+previous.right.dv>1||key.amount+key.left.dv<0||key.amount+key.left.dv>1))ctx.addIssue({code:'custom',message:'Motion curve handles must stay within 0–100%'});}}
});
export type MotionTrack=z.infer<typeof MotionTrackSchema>;
export const MotionCanvasSchema=z.object({kind:z.enum(['inherit','solid','gradient']),color,color2:color,angle:finite.min(0).max(360)}).strict();
export const MotionSchema=z.object({canvas:MotionCanvasSchema.default({kind:'inherit',color:'#111118',color2:'#7756be',angle:135}),primary:MotionVisualSchema,layers:z.array(MotionLayerSchema).max(24),tracks:z.array(MotionTrackSchema).max(64)}).strict().superRefine((motion,ctx)=>{
  const layers=new Set<string>(),tracks=new Set<string>(),targets=new Set(['primary']);
  for(const layer of motion.layers){if(layers.has(layer.id))ctx.addIssue({code:'custom',message:'Motion layer IDs must be unique'});layers.add(layer.id);targets.add(layer.id);}
  for(const track of motion.tracks){if(!targets.has(track.target))ctx.addIssue({code:'custom',message:'Motion track target is missing'});const key=`${track.target}:${track.property}`;if(tracks.has(key))ctx.addIssue({code:'custom',message:'Only one automation curve may control each property'});tracks.add(key);}
});
export type EditorMotion=z.infer<typeof MotionSchema>;
export const neutralMotion=():EditorMotion=>({canvas:{kind:'inherit',color:'#111118',color2:'#7756be',angle:135},primary:structuredClone(neutralMotionVisual),layers:[],tracks:[]});
