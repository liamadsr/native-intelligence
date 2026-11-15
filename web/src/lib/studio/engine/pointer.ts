import type { EditorTrace } from './contracts';

/** How long a click's ring grows and fades, and how long the pointer is pressed, in milliseconds of the recording. */
export const CLICK_RING_MS = 220, CLICK_PRESS_MS = 100;

/**
 * Where the recorded pointer is at `ms` of its recording, as fractions of the recording's width and height: between two
 * samples less than 100 ms apart it moves in a straight line, otherwise it stays on the earlier one. Null before the
 * first sample. The composition draws it there (composition.tsx), and so does the worker's FFmpeg export.
 */
export function pointerAt(trace: EditorTrace, ms: number): [number, number] | null {
  if (!trace.cursor.length || ms < trace.cursor[0]![0]) return null;
  const samples = trace.cursor; let lo = 0, hi = samples.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid]![0] <= ms) lo = mid; else hi = mid; }
  const a = samples[lo]!, b = samples[hi]!;
  const mix = b[0] === a[0] || b[0] - a[0] > 100 ? 0 : Math.max(0, Math.min(1, (ms - a[0]) / (b[0] - a[0])));
  const point = ms >= b[0] ? b : [ms, a[1] + (b[1] - a[1]) * mix, a[2] + (b[2] - a[2]) * mix];
  return [point[1]! / trace.viewport.width, point[2]! / trace.viewport.height];
}

/** The click whose ring shows at `ms` (the last one listed that started at most CLICK_RING_MS before), if any. */
export function clickAt(trace: EditorTrace, ms: number): EditorTrace['actions'][number] | undefined {
  return trace.actions.filter((a) => a.kind === 'click' && a.t <= ms && ms - a.t < CLICK_RING_MS).at(-1);
}

/** The pointer's scale while a click presses it (1 otherwise). */
export function pressScale(click: { t: number } | undefined | false, ms: number): number {
  return click && ms - click.t < CLICK_PRESS_MS ? 1 - 0.12 * Math.sin(Math.PI * (ms - click.t) / CLICK_PRESS_MS) : 1;
}
