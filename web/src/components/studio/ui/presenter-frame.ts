import type { EditorProject,PresenterTrack } from '@/lib/studio/engine/contracts';
import { neutralMotion, type EditorMotion } from '@/lib/studio/engine/motion-contracts';
import { dragMotionFrame,type FrameGesture } from './preview-motion';

export function dragPresenter(project:EditorProject,segmentId:string,part:FrameGesture,dx:number,dy:number):EditorProject{
 const track=project.presenterTrack,segment=track?.segments.find(item=>item.id===segmentId);if(!track||!segment)return project;
 const fake:EditorMotion={...neutralMotion(),layers:[{id:'presenter',name:'Presenter',kind:'video',assetId:track.assetId,sourceStartFrame:segment.sourceStartFrame,startFrame:0,endFrame:segment.endFrame-segment.startFrame,zIndex:1000,visual:segment.visual}],tracks:segment.tracks};
 const edited=dragMotionFrame(fake,'presenter',part,dx,dy),visual=edited.layers[0]!.visual;
 if(JSON.stringify(visual)===JSON.stringify(segment.visual)&&JSON.stringify(edited.tracks)===JSON.stringify(segment.tracks))return project;
 const nextTrack:PresenterTrack={...track,segments:track.segments.map(item=>item.id===segmentId?{...item,visual,tracks:edited.tracks}:item)};
 return {...project,presenterTrack:nextTrack};
}
