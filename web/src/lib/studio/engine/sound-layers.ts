// The video's sound as the composition plays it, with no React: each recording's sound under its clips (cut fades from
// cutAudioPlan) and each audio track's segments (gain, fades, ducking). composition.tsx draws an <Audio> per layer; the
// studio worker's FFmpeg export mixes the same layers itself. One source for both.
import type { EditorProject } from './contracts';
import { cutAudioPlan, cutVolume } from './cuts';
import { automationValue } from './automation';
import { segmentLevel } from './audio-mix';
import { duckGain, voiceSpans } from './ducking';
import { projectDuration, scheduleProject, type ScheduledClip } from './timeline';

export type SoundLayer = {
  key: string;
  assetId: string;
  /** Timeline frame the layer starts at, and how many frames its Sequence lasts. */
  from: number;
  duration: number;
  /** Where in the file it starts, in project frames (the <Audio>'s trimBefore). */
  trimBefore: number;
  playbackRate: number;
  /** Level at a frame of the layer (0 = its first). */
  volume: (frame: number) => number;
  premountFor: number;
};

export function soundLayers(project: EditorProject, schedule: ScheduledClip[] = scheduleProject(project)): SoundLayer[] {
  const fps = project.output.fps, frames = projectDuration(project);
  const clips = cutAudioPlan(project, schedule).map((plan): SoundLayer => {
    const s = schedule.find((item) => item.clip.id === plan.clipId)!;
    return { key: `audio-${plan.clipId}`, assetId: s.asset.id, from: plan.from, duration: plan.duration, trimBefore: Math.max(0, plan.trimBefore),
      playbackRate: s.clip.playbackRate, premountFor: Math.min(fps, plan.from), volume: (f: number) => cutVolume(plan, f) * automationValue(project, 'volume', plan.from + f) };
  });
  const ducking = project.audioTracks.some((t) => t.role === 'music' && t.duck), spans = ducking ? voiceSpans(project) : [];
  const tracks = project.audioTracks.filter((track) => !track.muted).flatMap((track) => track.segments.filter((segment) => segment.startFrame < frames).map((segment): SoundLayer => ({
    key: segment.id, assetId: segment.assetId, from: segment.startFrame,
    duration: Math.min(frames - segment.startFrame, Math.max(1, Math.round((segment.trimEndSeconds - segment.trimStartSeconds) * fps))),
    trimBefore: segment.trimStartSeconds * fps, playbackRate: 1, premountFor: Math.min(fps * 2, segment.startFrame),
    volume: (f: number) => track.gain * segmentLevel(segment, f, fps) * (track.role === 'music' && track.duck ? duckGain(spans, segment.startFrame + f, fps, track.duck) : 1),
  })));
  return [...clips, ...tracks];
}
