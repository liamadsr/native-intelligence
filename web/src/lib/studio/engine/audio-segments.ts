import type { EditorProject } from './contracts';

/** What the timeline edits on an audio segment (sound effect, music, voiceover). Fades are optional. */
export type AudioSegmentSpan = { startFrame: number; trimStartSeconds: number; trimEndSeconds: number; fadeInSeconds?: number; fadeOutSeconds?: number };
export type AudioSegmentEdit = 'move' | 'start' | 'end' | 'fadeIn' | 'fadeOut';

const round = (n: number) => Math.round(n * 1e6) / 1e6, clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export const segmentSeconds = (s: AudioSegmentSpan) => s.trimEndSeconds - s.trimStartSeconds;
/** Timeline frame just after the segment's last frame. */
export const segmentEndFrame = (s: AudioSegmentSpan, fps: number) => s.startFrame + Math.round(segmentSeconds(s) * fps);

/** Keep fades inside the segment: fade in + fade out never exceed its length. Fields that were absent stay absent. */
export function clampFades<S extends AudioSegmentSpan>(s: S): S {
  const length = segmentSeconds(s), next = { ...s };
  if (s.fadeInSeconds !== undefined) next.fadeInSeconds = round(clamp(s.fadeInSeconds, 0, length));
  if (s.fadeOutSeconds !== undefined) next.fadeOutSeconds = round(clamp(s.fadeOutSeconds, 0, length - (next.fadeInSeconds ?? 0)));
  return next;
}

/**
 * Drag one part of an audio segment by `delta` timeline frames. Move shifts it in time; the left edge trims the start
 * (start frame and source offset move together so the sound stays in sync); the right edge trims the end, never past the
 * file (`sourceSeconds`); fade handles lengthen or shorten the fades. The segment is always at least one frame long.
 */
export function editAudioSegment<S extends AudioSegmentSpan>(s: S, mode: AudioSegmentEdit, delta: number, fps: number, sourceSeconds?: number): S {
  const d = Math.round(delta), frame = 1 / fps;
  if (mode === 'move') return { ...s, startFrame: Math.max(0, s.startFrame + d) };
  if (mode === 'start') { const lo = Math.max(-s.startFrame, Math.ceil(-s.trimStartSeconds * fps - 1e-6)), hi = Math.floor((segmentSeconds(s) - frame) * fps + 1e-6), shift = clamp(d, lo, Math.max(lo, hi));
    return clampFades({ ...s, startFrame: s.startFrame + shift, trimStartSeconds: round(Math.max(0, s.trimStartSeconds + shift / fps)) }); }
  if (mode === 'end') { const min = s.trimStartSeconds + frame, max = Math.max(min, sourceSeconds ?? Infinity);
    return clampFades({ ...s, trimEndSeconds: round(clamp(s.trimEndSeconds + d / fps, min, max)) }); }
  const length = segmentSeconds(s), fadeIn = s.fadeInSeconds ?? 0, fadeOut = s.fadeOutSeconds ?? 0;
  return mode === 'fadeIn' ? { ...s, fadeInSeconds: round(clamp(fadeIn + d / fps, 0, length - fadeOut)) } : { ...s, fadeOutSeconds: round(clamp(fadeOut - d / fps, 0, length - fadeIn)) };
}

type Segment = EditorProject['audioTracks'][number]['segments'][number];
export function updateAudioSegment(p: EditorProject, trackId: string, segmentId: string, fn: (s: Segment) => Segment): EditorProject {
  return { ...p, audioTracks: p.audioTracks.map(t => t.id === trackId ? { ...t, segments: t.segments.map(s => s.id === segmentId ? fn(s) : s) } : t) };
}
export function removeAudioSegment(p: EditorProject, trackId: string, segmentId: string): EditorProject {
  const track = p.audioTracks.find(t => t.id === trackId); if (!track?.segments.some(s => s.id === segmentId)) return p;
  return { ...p, audioTracks: p.audioTracks.map(t => t.id === trackId ? { ...t, segments: t.segments.filter(s => s.id !== segmentId) } : t) };
}
