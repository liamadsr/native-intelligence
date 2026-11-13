import type { EditorProject, MotionKey, MotionTrack, PresenterSegment } from './contracts';
import { presenterPieces, presenterVisualAtFrame } from './presenter-pieces';

/** How long the bubble takes to glide to a new spot (seconds). */
export const presenterMoveSeconds = 0.4;
let counter = 0;
const id = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;
type Point = { frame: number; value: number; mode: MotionKey['mode']; left: MotionKey['left']; right: MotionKey['right'] };

function toTrack(property: 'x' | 'y', points: Point[], existing?: MotionTrack): MotionTrack | null {
  const values = points.map(p => p.value), from = Math.min(...values), to = Math.max(...values);
  if (points.length < 2 || to - from < 1e-6) return null;
  return { id: existing?.id ?? id(`presenter-${property}`), target: 'presenter', property, from, to,
    keys: points.map(p => ({ id: id('key'), frame: p.frame, amount: (p.value - from) / (to - from), mode: p.mode, left: p.left, right: p.right })) };
}

/** Move the bubble to (x, y) from `localFrame` onward: it holds its earlier path, glides over `transition`
 * frames, then stays put. Later position changes are replaced, so moving at the very start moves it everywhere. */
export function movePresenterFrom(segment: PresenterSegment, localFrame: number, x: number, y: number, transition: number): PresenterSegment {
  const L = Math.max(0, Math.round(localFrame)), start = L - transition;
  const target = { x, y };
  let visual = segment.visual, tracks = segment.tracks.filter(t => t.property !== 'x' && t.property !== 'y');
  const half = Math.max(1, Math.floor(transition / 2));
  for (const property of ['x', 'y'] as const) {
    visual = { ...visual, rect: { ...visual.rect, [property]: target[property] } };
    if (start <= 0) continue; // From the start: one fixed spot for the whole video.
    const old = segment.tracks.find(t => t.property === property);
    const before = presenterVisualAtFrame(segment, start).rect[property];
    const points: Point[] = (old?.keys ?? []).filter(k => k.frame < start)
      .map(k => ({ frame: k.frame, value: old!.from + k.amount * (old!.to - old!.from), mode: k.mode, left: { dt: k.left.dt, dv: 0 }, right: { dt: k.right.dt, dv: 0 } })); // Range changes, so handles keep timing only.
    if (!points.length) points.push({ frame: 0, value: before, mode: 'hold', left: { dt: 0, dv: 0 }, right: { dt: 0, dv: 0 } });
    const last = points.at(-1)!;
    points[points.length - 1] = { ...last, right: { dt: Math.min(last.right.dt, start - last.frame), dv: 0 } };
    points.push({ frame: start, value: before, mode: 'bezier', left: { dt: 0, dv: 0 }, right: { dt: half, dv: 0 } },
      { frame: L, value: target[property], mode: 'hold', left: { dt: half, dv: 0 }, right: { dt: 0, dv: 0 } });
    const track = toTrack(property, points, old);
    if (track) tracks = [...tracks, track];
  }
  return { ...segment, visual, tracks };
}
export function resetPresenterMoves(segment: PresenterSegment): PresenterSegment {
  const visual = presenterVisualAtFrame(segment, 0);
  return { ...segment, visual: { ...segment.visual, rect: { ...segment.visual.rect, x: visual.rect.x, y: visual.rect.y } }, tracks: segment.tracks.filter(t => t.property !== 'x' && t.property !== 'y') };
}
/** Output frames where the bubble arrives at a spot you chose (for timeline markers). */
export function presenterMoveFrames(project: EditorProject): number[] {
  const track = project.presenterTrack; if (!track) return [];
  const frames = new Set<number>();
  const holds = track.segments[0]!.tracks.filter(t => t.property === 'x' || t.property === 'y').flatMap(t => t.keys.filter(k => k.mode === 'hold' && k.frame > 0).map(k => k.frame));
  for (const local of holds) for (const piece of presenterPieces(project)) {
    const first = piece.visualFrame(0), last = piece.visualFrame(piece.duration - 1);
    if (local >= first && local <= last) { frames.add(piece.from + Math.round((local - first) / Math.max(1e-6, (last - first) / Math.max(1, piece.duration - 1)))); break; }
  }
  return [...frames].sort((a, b) => a - b);
}
