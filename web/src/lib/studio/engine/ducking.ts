// Sidechain ducking: the music dips while someone speaks and comes back in the breaths between sentences.
// The key is the aligned words (narration on voiceover tracks and speech on unmuted clips), not the waveform, so the
// music is already down when the first word lands (look-ahead = attack) and the preview and the export duck alike.
import type { EditorAudioTrack, EditorProject } from './contracts';
import { transcriptWords } from './transcript';

export type Duck = NonNullable<EditorAudioTrack['duck']>;
export const defaultDuck: Duck = { depthDb: 12, attackMs: 150, releaseMs: 500 };

/** Where someone is speaking, in timeline frames: aligned words merged across gaps shorter than `holdSeconds`. */
export function voiceSpans(project: EditorProject, holdSeconds = 0.4): [number, number][] {
  const hold = holdSeconds * project.output.fps, spans: [number, number][] = [];
  for (const word of transcriptWords(project)) {
    if (!word.timingReliable) continue;
    const last = spans.at(-1);
    if (last && word.startFrame - last[1] <= hold) last[1] = Math.max(last[1], word.endFrame); else spans.push([word.startFrame, word.endFrame]);
  }
  return spans;
}

/** The music's gain multiplier (0–1) at a timeline frame: fully down by `depthDb` through each span, easing down over
 *  `attackMs` before it and back up over `releaseMs` after it. Spans must be sorted by start (voiceSpans is). */
export function duckGain(spans: readonly (readonly [number, number])[], frame: number, fps: number, duck: Duck): number {
  const floor = 10 ** (-duck.depthDb / 20), attack = Math.max(1, duck.attackMs / 1000 * fps), release = Math.max(1, duck.releaseMs / 1000 * fps);
  let amount = 0;
  for (const [start, end] of spans) {
    if (frame < start - attack) break;
    const v = frame < start ? (frame - (start - attack)) / attack : frame <= end ? 1 : 1 - (frame - end) / release;
    amount = Math.max(amount, Math.min(1, Math.max(0, v)));
    if (amount === 1) break;
  }
  const eased = amount * amount * (3 - 2 * amount);
  return 1 - (1 - floor) * eased;
}

/** The same ducking as an ffmpeg `volume` expression (linear ramps) in a segment's own time, for mixes built with
 *  ffmpeg (quick listening mixes). `offsetSeconds` = where the segment starts on the timeline. */
export function duckExpression(spans: readonly (readonly [number, number])[], fps: number, duck: Duck, offsetSeconds: number, lengthSeconds: number): string {
  const a = Math.max(1 / fps, duck.attackMs / 1000), r = Math.max(1 / fps, duck.releaseMs / 1000), floor = 10 ** (-duck.depthDb / 20);
  const terms = spans.map(([s, e]) => [s / fps - offsetSeconds, e / fps - offsetSeconds] as const).filter(([s, e]) => e + r > 0 && s - a < lengthSeconds)
    .map(([s, e]) => `min(clip((t-${(s - a).toFixed(3)})/${a.toFixed(3)},0,1),clip((${(e + r).toFixed(3)}-t)/${r.toFixed(3)},0,1))`);
  if (!terms.length) return '1';
  const amount = terms.reduce((acc, term) => `max(${acc},${term})`);
  return `1-${(1 - floor).toFixed(4)}*${amount}`;
}
