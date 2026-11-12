import type { EditorZoom } from './contracts';

const ease = (n: number) => { const p = Math.max(0, Math.min(1, n)); return p * p * (3 - 2 * p); };
export function zoomAmount(zoom: EditorZoom | undefined, frame: number): number {
  if (!zoom || frame < zoom.startClipFrame || frame >= zoom.endClipFrame) return 0;
  // Reserve a frame at full scale; a shorter segment cannot fit both ramps.
  const transition = Math.min(zoom.transitionFrames, Math.floor((zoom.endClipFrame - zoom.startClipFrame - 1) / 2));
  if (transition === 0) return 1;
  return Math.min(ease((frame - zoom.startClipFrame) / transition), ease((zoom.endClipFrame - 1 - frame) / transition));
}
