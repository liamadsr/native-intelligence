export function emptyTimelineFrame(clientX:number,left:number,width:number,duration:number):number|null{
  if(width<=0||duration<1||![clientX,left,width,duration].every(Number.isFinite))return null;
  return Math.max(0,Math.min(duration-1,Math.round((clientX-left)/width*duration)));
}
export type PlaybackSession = {frame:number;startFrame:number|null};
export const newPlaybackSession = ():PlaybackSession => ({frame:0,startFrame:null});
const playbackFrame = (frame:number,duration:number) => Math.max(0,Math.min(Math.max(0,duration-1),Math.round(frame)));
/** A deliberate seek replaces the replay start; duration correction does not. */
export function seekPlayback(session:PlaybackSession,frame:number,duration:number,deliberate=true):PlaybackSession{
  const next=playbackFrame(frame,duration);
  return {frame:next,startFrame:deliberate?next:session.startFrame};
}
/** Frame updates report playback progress without moving the chosen start. */
export function progressPlayback(session:PlaybackSession,frame:number):PlaybackSession{
  return {...session,frame};
}
export function startPlayback(session:PlaybackSession,duration:number):{session:PlaybackSession;seekTo:number|null}{
  const frame=playbackFrame(session.frame,duration),lastFrame=Math.max(0,duration-1);
  // Resume from wherever playback was paused (or the playhead was moved to).
  const requested=frame;
  // Remotion starts at frame 0 when play() is called on the final frame.
  const start=requested===lastFrame&&lastFrame>0?0:requested;
  return {session:{frame:start,startFrame:start},seekTo:start===session.frame?null:start};
}
export function spacePlaybackAllowed(event:{code:string;key?:string;repeat:boolean;isComposing:boolean;defaultPrevented:boolean;metaKey:boolean;ctrlKey:boolean;altKey:boolean},blocked:boolean){
  return (event.code==='Space'||event.key===' ')&&!blocked&&!event.repeat&&!event.isComposing&&!event.defaultPrevented&&!event.metaKey&&!event.ctrlKey&&!event.altKey;
}
/** Motion buttons and handles own their editing keys; global clip deletion must not intercept them. */
export function motionControlOwnsKey(target:{closest:(selector:string)=>unknown},key:string,command:boolean){
  return !command&&['Delete','Backspace','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(key)&&!!target.closest('.motion-inspector,.motion-curve-lane,.motion-layer-lane,.motion-track-lane,.preview-motion-controls,.preview-motion-toolbar');
}
