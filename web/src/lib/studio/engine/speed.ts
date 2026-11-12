import { EditorProjectSchema, type EditorClip, type EditorMotion, type EditorProject } from './contracts';
import { projectDuration, scheduleProject, splitClip } from './timeline';

export type TypingSuggestion={id:string;clipId:string;actionIndex:number;startFrame:number;endFrame:number;label:string;eligible:boolean;reason?:string};

const overlaps=(a:number,b:number,c:number,d:number)=>a<d&&c<b;
function blockedReason(project:EditorProject,clip:EditorClip,start:number,end:number):string|undefined{
  const asset=project.assets.find(item=>item.id===clip.assetId)!;
  if(clip.playbackRate!==1)return 'This interval is already accelerated';
  const transcript=project.transcripts.find(item=>item.assetId===asset.id);
  if(asset.hasAudio&&!clip.audio.muted&&!transcript)return 'Transcribe this audio-bearing recording before speeding a typing interval';
  const sourceFrom=clip.trimStartSourceFrame/asset.sourceFps!*1000+(start/project.output.fps)*1000;
  const sourceTo=clip.trimStartSourceFrame/asset.sourceFps!*1000+(end/project.output.fps)*1000;
  if(transcript?.words.some(word=>overlaps(sourceFrom,sourceTo,word.startMs,Math.max(word.startMs+1,word.endMs))))return 'Spoken source audio overlaps this typing interval';
  const scheduled=scheduleProject(project).find(item=>item.clip.id===clip.id)!;
  const absoluteFrom=scheduled.startFrame+start,absoluteTo=scheduled.startFrame+end;
  for(const track of project.audioTracks)if(track.role==='voiceover'&&track.segments.some(segment=>overlaps(absoluteFrom,absoluteTo,segment.startFrame,segment.startFrame+Math.round((segment.trimEndSeconds-segment.trimStartSeconds)*project.output.fps))))return 'Voiceover overlaps this typing interval';
  if(!project.presenterTrack?.sync&&project.presenterTrack?.segments.some(segment=>overlaps(absoluteFrom,absoluteTo,segment.startFrame,segment.endFrame)))return 'Presenter footage overlaps this typing interval';
  return undefined;
}

/** Suggestions come exclusively from measured, positive-duration type actions in immutable traces. */
export function typingSuggestions(project:EditorProject):TypingSuggestion[]{
  const fps=project.output.fps;
  return scheduleProject(project).flatMap(({clip,asset,startFrame,durationFrames})=>(asset.trace?.actions??[]).flatMap((action,index):TypingSuggestion[]=>{
    if(action.kind!=='type'||action.end<=action.t||clip.dismissedActionIndices.includes(index))return[];
    const sourceFrom=Math.round(action.t/1000*asset.sourceFps!),sourceTo=Math.round(action.end/1000*asset.sourceFps!);
    if(sourceFrom<clip.trimStartSourceFrame||sourceTo>clip.trimEndSourceFrame||sourceTo<=sourceFrom)return[];
    // A project frame may straddle the measured action boundary. Keep only
    // frames wholly inside typing; speeding an adjacent pre/post frame could
    // mute speech that was never part of the measured typing interval.
    const localFrom=Math.ceil((sourceFrom-clip.trimStartSourceFrame)/asset.sourceFps!*fps/clip.playbackRate-1e-8);
    const localTo=Math.floor((sourceTo-clip.trimStartSourceFrame)/asset.sourceFps!*fps/clip.playbackRate+1e-8);
    const selectedFrom=Math.round(clip.trimStartSourceFrame+localFrom/fps*asset.sourceFps!*clip.playbackRate);
    const selectedTo=Math.round(clip.trimStartSourceFrame+localTo/fps*asset.sourceFps!*clip.playbackRate);
    const reason=localTo<=localFrom||localTo>durationFrames-clip.holdEndFrames||selectedFrom<sourceFrom||selectedTo>sourceTo?'Typing interval is shorter than an aligned project frame':blockedReason(project,clip,localFrom,localTo);
    return[{id:`${clip.id}-type-${index}`,clipId:clip.id,actionIndex:index,startFrame:startFrame+localFrom,endFrame:startFrame+localTo,label:action.label,eligible:!reason,...(reason?{reason}:{})}];
  }));
}

const mapFrame=(frame:number,oldDuration:number,newDuration:number)=>Math.round(frame*newDuration/oldDuration);
function retimeMotion(motion:EditorMotion,oldDuration:number,newDuration:number):EditorMotion{
  if(oldDuration===newDuration)return structuredClone(motion);
  const layers=motion.layers.map(layer=>{const startFrame=mapFrame(layer.startFrame,oldDuration,newDuration),endFrame=mapFrame(layer.endFrame,oldDuration,newDuration);
    if(endFrame<=startFrame)throw new Error('An animated layer would collapse at this speed. Adjust its span first.');return{...layer,startFrame,endFrame};});
  const tracks=motion.tracks.map(track=>{
    const keys=track.keys.map(key=>({...key,frame:mapFrame(key.frame,oldDuration,newDuration),left:{...key.left,dt:key.left.dt*newDuration/oldDuration},right:{...key.right,dt:key.right.dt*newDuration/oldDuration}}));
    if(keys.some((key,index)=>index>0&&key.frame<=keys[index-1]!.frame))throw new Error('Motion keyframes would collide at this speed. Adjust them first.');
    for(let index=1;index<keys.length;index++){const left=keys[index-1]!,right=keys[index]!,gap=right.frame-left.frame,sum=left.right.dt+right.left.dt;
      if(sum>gap){const scale=gap/sum;left.right.dt*=scale;right.left.dt*=scale;}}
    return{...track,keys};});
  return{...motion,layers,tracks};
}
function retimeClip(clip:EditorClip,oldDuration:number,newDuration:number):EditorClip{
  const zooms=clip.zooms.map(zoom=>{const startClipFrame=mapFrame(zoom.startClipFrame,oldDuration,newDuration),endClipFrame=mapFrame(zoom.endClipFrame,oldDuration,newDuration);
    if(endClipFrame<=startClipFrame)throw new Error('A zoom would collapse at this speed. Adjust it first.');
    return{...zoom,startClipFrame,endClipFrame,transitionFrames:Math.min(Math.round(zoom.transitionFrames*newDuration/oldDuration),Math.floor((endClipFrame-startClipFrame)/2))};});
  return{...clip,zooms,motion:retimeMotion(clip.motion,oldDuration,newDuration)};
}
export function changeClipPlaybackRate(project:EditorProject,clipId:string,rate:number):EditorProject{
  const schedule=scheduleProject(project),current=schedule.find(item=>item.clip.id===clipId);if(!current)throw new Error('Typing clip is unavailable');
  if(current.clip.holdEndFrames)throw new Error('Speed edits require recorded frames without an ending hold');
  if(current.clip.playbackRate===rate)return project;
  if(rate>1&&blockedReason(project,{...current.clip,playbackRate:1},0,current.durationFrames))throw new Error(blockedReason(project,{...current.clip,playbackRate:1},0,current.durationFrames));
  const proposed={...project,clips:project.clips.map(clip=>clip.id===clipId?{...clip,playbackRate:rate}:clip)};
  const nextSchedule=scheduleProject(proposed),next=nextSchedule.find(item=>item.clip.id===clipId)!;
  const oldDuration=current.durationFrames,newDuration=next.durationFrames,oldEnd=current.startFrame+oldDuration,totalDelta=projectDuration(proposed)-projectDuration(project);
  const translate=(frame:number)=>{
    if(frame<=current.startFrame)return frame;
    if(frame>=projectDuration(project))return projectDuration(proposed)+frame-projectDuration(project);
    const index=schedule.findIndex(item=>frame>=item.startFrame&&frame<item.startFrame+item.durationFrames);
    if(index<0)throw new Error('Timeline position is outside the saved edit');
    const before=schedule[index]!,after=nextSchedule[index]!;
    return after.startFrame+Math.round((frame-before.startFrame)*after.durationFrames/before.durationFrames);
  };
  if(newDuration<1)throw new Error('Typing interval would be shorter than one output frame');
  const adjusted={...proposed,clips:proposed.clips.map(clip=>clip.id===clipId?retimeClip(clip,oldDuration,newDuration):clip),
    audioTracks:project.audioTracks.map(track=>({...track,segments:track.segments.map(segment=>{
      const segmentEnd=segment.startFrame+Math.round((segment.trimEndSeconds-segment.trimStartSeconds)*project.output.fps);
      if(segment.startFrame>=oldEnd)return{...segment,startFrame:translate(segment.startFrame)};
      if(track.role==='voiceover'&&overlaps(current.startFrame,oldEnd,segment.startFrame,segmentEnd))throw new Error('Voiceover overlaps this typing interval');
      if(segmentEnd>current.startFrame&&segmentEnd>oldEnd){const trimEndSeconds=segment.trimEndSeconds+totalDelta/project.output.fps;
        if(trimEndSeconds<=segment.trimStartSeconds)throw new Error('Music segment would disappear at this speed');return{...segment,trimEndSeconds};}
      return segment;
    })})),presenterTrack:project.presenterTrack?.sync?project.presenterTrack:project.presenterTrack?{...project.presenterTrack,segments:project.presenterTrack.segments.map(segment=>{
      if(overlaps(current.startFrame,oldEnd,segment.startFrame,segment.endFrame))throw new Error('Presenter overlaps this typing interval');
      if(segment.startFrame<oldEnd)return segment;
      const startFrame=translate(segment.startFrame);return{...segment,startFrame,endFrame:startFrame+(segment.endFrame-segment.startFrame)};
    })}:null};
  return EditorProjectSchema.parse(adjusted);
}
export function applyTypingSpeed(project:EditorProject,suggestionId:string,rate:number):EditorProject{
  if(!Number.isFinite(rate)||rate<1||rate>4||Math.round(rate*4)!==rate*4)throw new Error('Typing speed must be 1–4× in quarter steps');
  const suggestion=typingSuggestions(project).find(item=>item.id===suggestionId);if(!suggestion)throw new Error('Typing suggestion is unavailable');
  if(!suggestion.eligible)throw new Error(suggestion.reason??'Typing suggestion is unavailable');
  if(rate===1)return project;
  let edited=project;const original=scheduleProject(project).find(item=>item.clip.id===suggestion.clipId)!,originalIndex=project.clips.findIndex(clip=>clip.id===suggestion.clipId);
  const localStart=suggestion.startFrame-original.startFrame,localEnd=suggestion.endFrame-original.startFrame;
  if(localEnd<original.durationFrames){const split=splitClip(edited,suggestion.clipId,localEnd);if(split===edited)throw new Error('Typing end is not aligned to a source frame');edited=split;}
  if(localStart>0){const split=splitClip(edited,suggestion.clipId,localStart);if(split===edited)throw new Error('Typing start is not aligned to a source frame');edited=split;}
  const action=original.asset.trace!.actions[suggestion.actionIndex]!;
  const expectedStart=Math.round(action.t/1000*original.asset.sourceFps!),expectedEnd=Math.round(action.end/1000*original.asset.sourceFps!);
  // Splits retain the left clip at its original index and insert the selected
  // interval immediately after it. Source bounds alone are not an identity:
  // the same immutable take may be reused earlier in the timeline.
  const middle=scheduleProject(edited)[originalIndex+(localStart>0?1:0)];
  if(!middle||middle.asset.id!==original.asset.id||middle.clip.trimStartSourceFrame<expectedStart||middle.clip.trimEndSourceFrame>expectedEnd)throw new Error('Typing interval changed while splitting');
  const changed=changeClipPlaybackRate(edited,middle.clip.id,rate);
  if(projectDuration(changed)>=projectDuration(project))throw new Error('Typing speed did not shorten the edit');
  return changed;
}
export function applyAllTypingSpeeds(project:EditorProject,rate:number):EditorProject{
  if(rate===1)return project;
  let next=project;for(let count=0;count<project.clips.length*100;count++){
    const suggestion=typingSuggestions(next).find(item=>item.eligible);if(!suggestion)return next;
    next=applyTypingSpeed(next,suggestion.id,rate);
  }throw new Error('Too many typing intervals; no changes were saved');
}
export function resetTypingSpeed(project:EditorProject,clipId:string):EditorProject{return changeClipPlaybackRate(project,clipId,1);}
export function dismissTypingSuggestion(project:EditorProject,suggestionId:string):EditorProject{
  const suggestion=typingSuggestions(project).find(item=>item.id===suggestionId);if(!suggestion)return project;
  return EditorProjectSchema.parse({...project,clips:project.clips.map(clip=>clip.id===suggestion.clipId?{...clip,dismissedActionIndices:[...new Set([...clip.dismissedActionIndices,suggestion.actionIndex])].sort((a,b)=>a-b)}:clip)});
}
