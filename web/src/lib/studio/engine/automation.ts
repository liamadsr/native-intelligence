import type { EditorProject } from './contracts';

/**
 * Automation (Logic-style): curves over the timeline. The main picture and the audio have project-wide lanes here; each
 * layer carries its own lanes (layers.ts). Points are output frames; values are in each parameter's own unit.
 */
export type AutomationParam = 'zoom' | 'panX' | 'panY' | 'shiftX' | 'shiftY' | 'rotate' | 'tiltX' | 'tiltY' | 'blur' | 'opacity' | 'saturation' | 'contrast' | 'volume' | 'camZoom' | 'camX' | 'camY' | 'camRotate';
export type CurveShape = 'smooth' | 'linear' | 'hold';
/** `curve` shapes the segment that ends at this point. */
export type AutomationPoint = { frame: number; value: number; curve?: CurveShape };
export type AutomationLane = { param: AutomationParam; points: AutomationPoint[] };
export type ParamInfo = { id: string; label: string; min: number; max: number; neutral: number; format: (v: number) => string; help: string };

const percent = (v: number) => `${Math.round(v * 100)}%`, signedPercent = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`;
export const automationParams: (ParamInfo & { id: AutomationParam; target: 'video' | 'audio' })[] = [
  { id: 'zoom', target: 'video', label: 'Zoom', min: 1, max: 4, neutral: 1, format: v => `${v.toFixed(2)}×`, help: 'Zoom into the picture (1× = whole frame)' },
  { id: 'panX', target: 'video', label: 'Pan ←→', min: 0, max: 1, neutral: 0.5, format: v => signedPercent((v - 0.5) * 2), help: 'Where the zoom looks, left to right' },
  { id: 'panY', target: 'video', label: 'Pan ↑↓', min: 0, max: 1, neutral: 0.5, format: v => signedPercent((v - 0.5) * 2), help: 'Where the zoom looks, top to bottom' },
  { id: 'shiftX', target: 'video', label: 'Slide ←→', min: -1, max: 1, neutral: 0, format: signedPercent, help: 'Move the whole picture sideways (whips, slide-ins)' },
  { id: 'shiftY', target: 'video', label: 'Slide ↑↓', min: -1, max: 1, neutral: 0, format: signedPercent, help: 'Move the whole picture up or down' },
  { id: 'rotate', target: 'video', label: 'Rotation', min: -45, max: 45, neutral: 0, format: v => `${v.toFixed(1)}°`, help: 'Tilt the picture' },
  { id: 'tiltX', target: 'video', label: 'Tilt ↕ (3D)', min: -45, max: 45, neutral: 0, format: v => `${v.toFixed(1)}°`, help: 'Lean the picture back or forward in 3D' },
  { id: 'tiltY', target: 'video', label: 'Tilt ↔ (3D)', min: -45, max: 45, neutral: 0, format: v => `${v.toFixed(1)}°`, help: 'Turn the picture left or right in 3D' },
  { id: 'saturation', target: 'video', label: 'Colour', min: 0, max: 2, neutral: 1, format: v => `${Math.round(v * 100)}%`, help: '0% = black and white (grade the footage so coloured text pops)' },
  { id: 'contrast', target: 'video', label: 'Contrast', min: 0.5, max: 2, neutral: 1, format: v => `${Math.round(v * 100)}%`, help: 'Punchier or flatter picture' },
  { id: 'blur', target: 'video', label: 'Blur', min: 0, max: 60, neutral: 0, format: v => `${v.toFixed(0)} px`, help: 'Motion or focus blur on the picture' },
  { id: 'opacity', target: 'video', label: 'Opacity', min: 0, max: 1, neutral: 1, format: percent, help: 'Fade the picture to the background' },
  { id: 'camZoom', target: 'video', label: 'Camera zoom', min: 0.5, max: 3, neutral: 1, format: v => `${v.toFixed(2)}×`, help: 'Graphics camera: push in or pull out on every graphic layer at once (captions stay put)' },
  { id: 'camX', target: 'video', label: 'Camera ←→', min: -0.5, max: 0.5, neutral: 0, format: signedPercent, help: 'Graphics camera: drift all graphic layers sideways' },
  { id: 'camY', target: 'video', label: 'Camera ↑↓', min: -0.5, max: 0.5, neutral: 0, format: signedPercent, help: 'Graphics camera: drift all graphic layers up or down' },
  { id: 'camRotate', target: 'video', label: 'Camera roll', min: -20, max: 20, neutral: 0, format: v => `${v.toFixed(1)}°`, help: 'Graphics camera: a slight roll of all graphic layers' },
  { id: 'volume', target: 'audio', label: 'Volume', min: 0, max: 2, neutral: 1, format: v => v <= 0.001 ? '−∞ dB' : `${(20 * Math.log10(v)).toFixed(1)} dB`, help: 'Level of the recording\'s sound' },
];
export const isAutomationParam = (value: string): value is AutomationParam => automationParams.some(item => item.id === value);
export const paramInfo = (param: AutomationParam) => automationParams.find(item => item.id === param)!;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const smoothstep = (t: number) => t * t * (3 - 2 * t);

/** Value of a curve at a frame: holds before the first and after the last point; each segment eases, ramps or steps. */
export function curveValue(points: readonly AutomationPoint[], frame: number, neutral: number, min = -Infinity, max = Infinity): number {
  if (!points.length) return clamp(neutral, min, max);
  if (frame <= points[0]!.frame) return clamp(points[0]!.value, min, max);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    if (frame < b.frame) {
      if (b.curve === 'hold') return clamp(a.value, min, max);
      const t = (frame - a.frame) / (b.frame - a.frame);
      return clamp(a.value + (b.value - a.value) * (b.curve === 'linear' ? t : smoothstep(t)), min, max);
    }
  }
  return clamp(points.at(-1)!.value, min, max);
}

/** Sorted, one point per frame, values clamped. */
export function normalizePoints(points: readonly AutomationPoint[], min: number, max: number): AutomationPoint[] {
  const byFrame = new Map<number, AutomationPoint>();
  for (const point of points) { if (!Number.isFinite(point.frame) || !Number.isFinite(point.value)) continue;
    const frame = Math.max(0, Math.round(point.frame)); byFrame.set(frame, { ...point, frame, value: clamp(point.value, min, max) }); }
  return [...byFrame.values()].sort((a, b) => a.frame - b.frame);
}

/**
 * Pencil strokes arrive as one sample per pointer move; keep the shape with far fewer points (Ramer–Douglas–Peucker
 * in frame/value space, tolerance as a fraction of the value range).
 */
export function simplifyPoints(points: readonly AutomationPoint[], range: number, tolerance = 0.012): AutomationPoint[] {
  if (points.length <= 2) return [...points];
  const span = Math.max(1, points.at(-1)!.frame - points[0]!.frame);
  const nx = (p: AutomationPoint) => (p.frame - points[0]!.frame) / span, ny = (p: AutomationPoint) => p.value / Math.max(1e-9, range);
  const keep = new Array<boolean>(points.length).fill(false); keep[0] = keep[points.length - 1] = true;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) { const [a, b] = stack.pop()!; let worst = -1, at = -1;
    const ax = nx(points[a]!), ay = ny(points[a]!), bx = nx(points[b]!), by = ny(points[b]!), dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) { const d = Math.abs(dy * nx(points[i]!) - dx * ny(points[i]!) + bx * ay - by * ax) / length; if (d > worst) { worst = d; at = i; } }
    if (worst > tolerance && at > 0) { keep[at] = true; stack.push([a, at], [at, b]); } }
  return points.filter((_, i) => keep[i]);
}

export function lanePoints(project: EditorProject, param: AutomationParam): AutomationPoint[] {
  return project.automation?.lanes.find(lane => lane.param === param)?.points ?? [];
}
export function automationValue(project: EditorProject, param: AutomationParam, frame: number): number {
  const info = paramInfo(param); return curveValue(lanePoints(project, param), frame, info.neutral, info.min, info.max);
}
export function hasAutomation(project: EditorProject) { return !!project.automation?.lanes.some(lane => lane.points.length) || !!project.layers?.some(layer => layer.automation.some(lane => lane.points.length)); }

/** Replace one lane's points. */
export function setLanePoints(project: EditorProject, param: AutomationParam, points: AutomationPoint[]): EditorProject {
  const info = paramInfo(param), sorted = normalizePoints(points, info.min, info.max);
  const lanes = (project.automation?.lanes ?? []).filter(lane => lane.param !== param);
  if (sorted.length) lanes.push({ param, points: sorted });
  lanes.sort((a, b) => automationParams.findIndex(p => p.id === a.param) - automationParams.findIndex(p => p.id === b.param));
  return { ...project, automation: { lanes } };
}

/** Write a shape into [from, to] of a curve: points inside the window are replaced, the curve outside is untouched. */
export function spliceCurve(points: readonly AutomationPoint[], from: number, to: number, shape: AutomationPoint[], neutral: number, min: number, max: number): AutomationPoint[] {
  const before = curveValue(points, from, neutral, min, max), after = curveValue(points, to, neutral, min, max);
  const kept = points.filter(point => point.frame < from || point.frame > to);
  const edges: AutomationPoint[] = [];
  if (!shape.some(point => point.frame === from)) edges.push({ frame: from, value: before });
  if (!shape.some(point => point.frame === to)) edges.push({ frame: to, value: after });
  return normalizePoints([...kept, ...edges, ...shape], min, max);
}

/** "Add zoom": ease in to `scale` at the playhead, hold, ease back out — as editable points on the Zoom lane. */
export function addZoomBump(project: EditorProject, frame: number, total: number, scale = 1.8, holdSeconds = 1.5, x?: number, y?: number): EditorProject {
  const fps = project.output.fps, ramp = Math.round(fps * 0.5), hold = Math.round(fps * holdSeconds);
  const start = Math.max(0, Math.min(frame, total - 1)), end = Math.min(total, start + ramp * 2 + hold);
  const base = automationValue(project, 'zoom', start), after = automationValue(project, 'zoom', end);
  const kept = lanePoints(project, 'zoom').filter(point => point.frame < start || point.frame > end);
  let next = setLanePoints(project, 'zoom', [...kept, { frame: start, value: base }, { frame: start + ramp, value: scale }, { frame: end - ramp, value: scale }, { frame: end, value: after }]);
  for (const [param, value] of [['panX', x], ['panY', y]] as const) if (value !== undefined) {
    const info = paramInfo(param), points = lanePoints(next, param), from = curveValue(points, start, info.neutral, info.min, info.max);
    next = setLanePoints(next, param, spliceCurve(points, start, end, [{ frame: start, value: from }, { frame: start + ramp, value }, { frame: end - ramp, value }, { frame: end, value: from }], info.neutral, info.min, info.max));
  }
  return next;
}

export type TransitionKind = 'zoom-punch' | 'whip-left' | 'whip-right' | 'whip-up' | 'whip-down' | 'blur' | 'spin' | 'fade-through' | 'defocus' | 'push-left' | 'push-right' | 'tilt-in' | 'zoom-in';
export const transitionKinds: { id: TransitionKind; label: string; help: string }[] = [
  { id: 'zoom-punch', label: 'Zoom punch', help: 'A quick punch in and settle — energy on a beat or a cut' },
  { id: 'whip-left', label: 'Whip left', help: 'Fast swipe left with motion blur' },
  { id: 'whip-right', label: 'Whip right', help: 'Fast swipe right with motion blur' },
  { id: 'whip-up', label: 'Whip up', help: 'Fast swipe up with motion blur' },
  { id: 'whip-down', label: 'Whip down', help: 'Fast swipe down with motion blur' },
  { id: 'blur', label: 'Blur through', help: 'Defocus and refocus across the moment' },
  { id: 'spin', label: 'Spin', help: 'A short rotate-and-zoom flourish' },
  { id: 'fade-through', label: 'Fade through', help: 'Dip the picture to the background and back' },
  { id: 'defocus', label: 'Defocus', help: 'Blur out and sharpen back in with a slight push — soft, cinematic' },
  { id: 'push-left', label: 'Push left', help: 'Slide the picture out left and the next moment in from the right, with motion blur' },
  { id: 'push-right', label: 'Push right', help: 'Slide out right, in from the left, with motion blur' },
  { id: 'tilt-in', label: '3D tilt in', help: 'The picture swings up from a 3D lean and settles flat (starts at the time)' },
  { id: 'zoom-in', label: 'Zoom in reveal', help: 'Start pushed in and blurred, pull back to the full picture (starts at the time)' },
];

/**
 * Transitions are just automation: a short shape written into the main picture's lanes centred on `frame`, so they
 * stay editable point by point afterwards. `length` is the whole effect in frames (default ≈ 0.4 s).
 */
export function addTransition(project: EditorProject, frame: number, kind: TransitionKind, total: number, length?: number): EditorProject {
  const fps = project.output.fps, span = Math.max(4, Math.round(length ?? fps * 0.4)), half = Math.round(span / 2);
  const from = Math.max(0, frame - half), to = Math.min(Math.max(1, total - 1), frame + half), mid = Math.max(from + 1, Math.min(to - 1, Math.round((from + to) / 2)));
  if (to - from < 3) return project;
  const write = (p: EditorProject, param: AutomationParam, shape: AutomationPoint[]) => { const info = paramInfo(param);
    return setLanePoints(p, param, spliceCurve(lanePoints(p, param), from, to, shape, info.neutral, info.min, info.max)); };
  const base = (param: AutomationParam) => automationValue(project, param, from);
  if (kind === 'zoom-punch') { const z = base('zoom'), peak = Math.min(4, z * 1.22);
    return write(project, 'zoom', [{ frame: from, value: z }, { frame: Math.min(to - 1, from + Math.max(2, Math.round((to - from) * 0.2))), value: peak, curve: 'linear' }, { frame: to, value: z, curve: 'smooth' }]); }
  if (kind.startsWith('whip')) { const horizontal = kind === 'whip-left' || kind === 'whip-right', sign = kind === 'whip-left' || kind === 'whip-up' ? -1 : 1;
    const param: AutomationParam = horizontal ? 'shiftX' : 'shiftY', b = base(param), blur = base('blur');
    // Out fast past the edge, snap back in from the other side: reads as a whip pan between two moments.
    let next = write(project, param, [{ frame: from, value: b }, { frame: mid, value: b + sign, curve: 'smooth' }, { frame: mid + 1, value: b - sign, curve: 'hold' }, { frame: to, value: b, curve: 'smooth' }]);
    next = write(next, 'blur', [{ frame: from, value: blur }, { frame: mid, value: Math.max(blur, 36), curve: 'smooth' }, { frame: to, value: blur, curve: 'smooth' }]);
    return next; }
  if (kind === 'blur') { const blur = base('blur'); return write(project, 'blur', [{ frame: from, value: blur }, { frame: mid, value: Math.max(blur, 28), curve: 'smooth' }, { frame: to, value: blur, curve: 'smooth' }]); }
  if (kind === 'spin') { const r = base('rotate'), z = base('zoom');
    const next = write(project, 'rotate', [{ frame: from, value: r }, { frame: mid, value: r + 8, curve: 'smooth' }, { frame: to, value: r, curve: 'smooth' }]);
    return write(next, 'zoom', [{ frame: from, value: z }, { frame: mid, value: Math.min(4, z * 1.15), curve: 'smooth' }, { frame: to, value: z, curve: 'smooth' }]); }
  if (kind === 'defocus') { const blur = base('blur'), z = base('zoom');
    const next = write(project, 'blur', [{ frame: from, value: blur }, { frame: mid, value: Math.max(blur, 30), curve: 'smooth' }, { frame: to, value: blur, curve: 'smooth' }]);
    return write(next, 'zoom', [{ frame: from, value: z }, { frame: mid, value: Math.min(4, z * 1.08), curve: 'smooth' }, { frame: to, value: z, curve: 'smooth' }]); }
  if (kind === 'push-left' || kind === 'push-right') { const b = base('shiftX'), sign = kind === 'push-left' ? -1 : 1;
    return write(project, 'shiftX', [{ frame: from, value: b }, { frame: mid, value: b + sign * 1.05, curve: 'smooth' }, { frame: mid + 1, value: b - sign * 1.05, curve: 'hold' }, { frame: to, value: b, curve: 'smooth' }]); }
  if (kind === 'tilt-in' || kind === 'zoom-in') {
    // Entrances start at the time and settle over the length (≈0.7 s).
    const start = Math.max(0, frame), end = Math.min(Math.max(1, total - 1), start + Math.max(6, Math.round(length ?? fps * 0.7)));
    const settle = (p: EditorProject, param: AutomationParam, value: number) => { const info = paramInfo(param), rest = automationValue(p, param, end);
      return setLanePoints(p, param, spliceCurve(lanePoints(p, param), start, end, [{ frame: start, value }, { frame: end, value: rest, curve: 'smooth' }], info.neutral, info.min, info.max)); };
    if (kind === 'tilt-in') return settle(settle(settle(project, 'tiltX', 32), 'zoom', 1.25), 'blur', 10);
    return settle(settle(project, 'zoom', 1.6), 'blur', 22); }
  const o = base('opacity');
  return write(project, 'opacity', [{ frame: from, value: o }, { frame: mid, value: 0, curve: 'smooth' }, { frame: to, value: o, curve: 'smooth' }]);
}

/** Erase points of a curve inside [from, to]. */
export function erasePoints(points: readonly AutomationPoint[], from: number, to: number): AutomationPoint[] {
  return points.filter(point => point.frame < Math.min(from, to) || point.frame > Math.max(from, to));
}

export const cutPoints = (points: readonly AutomationPoint[], cuts: { startFrame: number; endFrame: number }[], mapFrame: (frame: number) => number) => points
  .filter(point => !cuts.some(cut => point.frame > cut.startFrame && point.frame < cut.endFrame))
  .map(point => ({ ...point, frame: mapFrame(point.frame) }))
  .filter((point, index, all) => index === 0 || point.frame !== all[index - 1]!.frame);

/** After cutting ranges out of the timeline: points inside a cut go, the rest move with the footage. */
export function cutAutomation(project: EditorProject, cuts: { startFrame: number; endFrame: number }[], mapFrame: (frame: number) => number): EditorProject['automation'] {
  if (!project.automation) return project.automation;
  return { lanes: project.automation.lanes.map(lane => ({ ...lane, points: cutPoints(lane.points, cuts, mapFrame) })).filter(lane => lane.points.length) };
}
/** After inserting `length` frames at `at` (punch-in): later points move right. */
export function insertAutomation(project: EditorProject, at: number, length: number): EditorProject['automation'] {
  if (!project.automation || !length) return project.automation;
  return { lanes: project.automation.lanes.map(lane => ({ ...lane, points: lane.points.map(point => point.frame >= at ? { ...point, frame: point.frame + length } : point) })) };
}
