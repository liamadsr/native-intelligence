// One audio segment's level over its own frames: its gain, shaped by a fade in at the head and a fade out at the tail
// (equal-power curves, so a fade sounds even rather than dropping off a cliff at the end).
import type { EditorAudioTrack } from './contracts';

type Segment = EditorAudioTrack['segments'][number];

/** Fade lengths that fit the segment (together never longer than it). */
export function fadeLengths(segment: Pick<Segment, 'trimStartSeconds' | 'trimEndSeconds' | 'fadeInSeconds' | 'fadeOutSeconds'>) {
  const length = segment.trimEndSeconds - segment.trimStartSeconds, fadeIn = Math.max(0, segment.fadeInSeconds ?? 0), fadeOut = Math.max(0, segment.fadeOutSeconds ?? 0);
  const scale = fadeIn + fadeOut > length ? length / (fadeIn + fadeOut) : 1;
  return { length, fadeIn: fadeIn * scale, fadeOut: fadeOut * scale };
}

/** Linear gain at `frame` frames into the segment. */
export function segmentLevel(segment: Segment, frame: number, fps: number): number {
  const { length, fadeIn, fadeOut } = fadeLengths(segment), t = frame / fps, gain = segment.gain ?? 1;
  let shape = 1;
  if (fadeIn > 0 && t < fadeIn) shape = Math.sin(Math.max(0, t / fadeIn) * Math.PI / 2);
  if (fadeOut > 0 && t > length - fadeOut) shape = Math.min(shape, Math.sin(Math.max(0, (length - t) / fadeOut) * Math.PI / 2));
  return gain * shape;
}
