import type { EditorAsset, EditorClip, EditorProject } from './contracts';
import { sliceMotion } from './motion';
export type ScheduledClip = { clip: EditorClip; asset: EditorAsset; startFrame: number; durationFrames: number };
export function scheduleProject(project: EditorProject): ScheduledClip[] {
  let seconds = 0, previous = 0;
  return project.clips.map((clip) => {
    const asset = project.assets.find((a) => a.id === clip.assetId)!;
    seconds += (clip.trimEndSourceFrame - clip.trimStartSourceFrame) / asset.sourceFps! / clip.playbackRate + clip.holdEndFrames / project.output.fps;
    const end = Math.round(seconds * project.output.fps), startFrame = previous; previous = end;
    if (end <= startFrame) throw new Error('Clip shorter than one project frame');
    return { clip, asset, startFrame, durationFrames: end - startFrame };
  });
}
export function projectDuration(project: EditorProject): number {
  const last = scheduleProject(project).at(-1)!; return last.startFrame + last.durationFrames;
}
export function sourceTimeSeconds(clip: EditorClip, asset: EditorAsset, localFrame: number, projectFps: number): number {
  return Math.min((clip.trimEndSourceFrame - 1) / asset.sourceFps!, clip.trimStartSourceFrame / asset.sourceFps! + localFrame / projectFps * clip.playbackRate);
}
export function clampZooms(clip: EditorClip, durationFrames: number): EditorClip {
  return { ...clip, zooms: clip.zooms.filter((z) => z.startClipFrame < durationFrames).map((z) => ({ ...z, endClipFrame: Math.min(durationFrames, z.endClipFrame) })) };
}
/** Normalize every clip after a sequence edit: cumulative FPS rounding can change neighboring durations. */
export function normalizeProjectZooms(project: EditorProject): EditorProject {
  const schedule = scheduleProject(project);
  return { ...project, clips: schedule.map((s) => ({...clampZooms(s.clip, s.durationFrames),motion:sliceMotion(s.clip.motion,0,s.durationFrames,project.output.fps,project.assets,s.clip.playbackRate)})), voiceoverDraft: { ...project.voiceoverDraft, targetClipIds: project.voiceoverDraft.targetClipIds.filter(id => project.clips.some(c => c.id === id)) } };
}
export function trimClip(project: EditorProject, clipId: string, start: number, end: number): EditorProject {
  const scheduled = scheduleProject(project).find((s) => s.clip.id === clipId);
  if (!scheduled) return project;
  const offset = Math.round((start - scheduled.clip.trimStartSourceFrame) / scheduled.asset.sourceFps! * project.output.fps / scheduled.clip.playbackRate);
  const edited = { ...project, clips: project.clips.map((clip) => clip.id !== clipId ? clip : { ...clip, trimStartSourceFrame: start, trimEndSourceFrame: end,
    zooms: clip.zooms.filter((zoom) => zoom.endClipFrame > offset).map((zoom) => ({ ...zoom, startClipFrame: Math.max(0, zoom.startClipFrame - offset), endClipFrame: zoom.endClipFrame - offset })) }) };
  const duration=scheduleProject(edited).find(s=>s.clip.id===clipId)!.durationFrames;
  const remapped={...edited,clips:edited.clips.map(clip=>clip.id===clipId?{...clip,motion:sliceMotion(scheduled.clip.motion,offset,offset+duration,project.output.fps,project.assets,clip.playbackRate)}:clip)};
  return normalizeProjectZooms(remapped);
}
export function splitClip(project: EditorProject, clipId: string, localFrame: number): EditorProject {
  const s = scheduleProject(project).find((v) => v.clip.id === clipId);
  if (!s || localFrame <= 0 || localFrame >= s.durationFrames) return project;
  if (localFrame >= s.durationFrames - s.clip.holdEndFrames) throw new Error('Split inside recorded footage; the ending hold has no additional recorded frames.');
  const boundary = Math.round(s.clip.trimStartSourceFrame + localFrame / project.output.fps * s.asset.sourceFps! * s.clip.playbackRate);
  if (boundary <= s.clip.trimStartSourceFrame || boundary >= s.clip.trimEndSourceFrame) return project;
  const before = scheduleProject(project).filter((v) => v.startFrame < s.startFrame).reduce((n, v) => n + (v.clip.trimEndSourceFrame - v.clip.trimStartSourceFrame) / v.asset.sourceFps! / v.clip.playbackRate + v.clip.holdEndFrames / project.output.fps, 0);
  const splitFrame = Math.round((before + (boundary - s.clip.trimStartSourceFrame) / s.asset.sourceFps! / s.clip.playbackRate) * project.output.fps) - s.startFrame;
  if ((boundary - s.clip.trimStartSourceFrame) / s.asset.sourceFps! / s.clip.playbackRate * project.output.fps < 1 || (s.clip.trimEndSourceFrame - boundary) / s.asset.sourceFps! / s.clip.playbackRate * project.output.fps < 1) return project;
  const left = { ...s.clip, trimEndSourceFrame: boundary, holdEndFrames: 0, zooms: s.clip.zooms.filter((z) => z.startClipFrame < splitFrame).map((z) => ({ ...z, endClipFrame: Math.min(z.endClipFrame, splitFrame) })),motion:sliceMotion(s.clip.motion,0,splitFrame,project.output.fps,project.assets,s.clip.playbackRate) };
  const right = { ...s.clip, id: `${s.clip.id.slice(0,55)}-${crypto.randomUUID().slice(0,8)}`, trimStartSourceFrame: boundary,
    zooms: s.clip.zooms.filter((z) => z.endClipFrame > splitFrame).map((z) => ({ ...z, id: `${z.id}-split`, startClipFrame: Math.max(0, z.startClipFrame - splitFrame), endClipFrame: z.endClipFrame - splitFrame })),motion:sliceMotion(s.clip.motion,splitFrame,s.durationFrames,project.output.fps,project.assets,s.clip.playbackRate) };
  return normalizeProjectZooms({ ...project, clips: project.clips.flatMap((c) => c.id === clipId ? [left, right] : [c]) });
}
