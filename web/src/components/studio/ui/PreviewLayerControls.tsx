import React, { useEffect, useRef, useState } from 'react';
import type { EditorProject } from '@/lib/studio/engine/contracts';

type Layer = NonNullable<EditorProject['layers']>[number];
type Side = -1 | 0 | 1;
type Part = 'move' | 'resize' | 'rotate' | 'tip' | 'tail';
type Gesture = { pointerId: number; id: string; part: Part; sx: Side; sy: Side; startX: number; startY: number; scale: number; base: Layer; moved: boolean;
  /** The layer's centre on the screen and the pointer's angle from it when a rotation starts. */ cx: number; cy: number; angle: number };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const round = (v: number) => +v.toFixed(4);
const SNAP = 0.012;

/**
 * Layers you can grab on the preview at this frame. A full-frame one (a background, a scene) only while it is the one
 * selected, so it never covers the others' handles, and once selected it moves and resizes on the screen like the
 * rest (Liam, 11-24: "when you add background … you can't resize it via the screen"). Drawn first, it stays under them.
 */
export function grabbableLayers(project: EditorProject, frame: number, selectedLayerId: string | null = null, dragged?: Layer) {
  // The layer being dragged is placed as it was when the drag began, so it never moves in the stack mid-drag.
  const fullFrame = (l: Layer) => { const at = dragged && l.id === dragged.id ? dragged : l; return at.kind === 'background' || (at.width >= 0.97 && at.height >= 0.97); };
  const here = (project.layers ?? []).filter(l => frame >= l.startFrame && frame < l.endFrame && (l.id === selectedLayerId || !fullFrame(l)));
  // Full-frame ones first, under the others, however late they were added: the overlays on them stay clickable.
  return [...here.filter(fullFrame), ...here.filter(l => !fullFrame(l))];
}

/**
 * A resize from one of the box's handles (a corner keeps the shape, a side changes one dimension), with the opposite
 * side or corner staying put, or with the centre staying put when `fromCentre` (Alt). `dx`/`dy` are the pointer's move
 * in preview pixels and `frameW`/`frameH` the frame's size in them; the move is read along the layer's own rotated
 * axes, so a turned box still grows the way its handle points. A text layer's size follows a corner.
 */
export function resizeLayer(base: Layer, sx: Side, sy: Side, dx: number, dy: number, frameW: number, frameH: number, fromCentre = false): Partial<Layer> {
  const t = base.rotate * Math.PI / 180, cos = Math.cos(t), sin = Math.sin(t);
  const lx = dx * cos + dy * sin, ly = -dx * sin + dy * cos, bw = base.width * frameW, bh = base.height * frameH, k = fromCentre ? 2 : 1;
  let width = base.width, height = base.height, ux = 0, uy = 0, f = 1;
  if (sx && sy) { // a corner: one factor for both sides, from how far the pointer went along the corner's diagonal
    const cx = sx * bw / 2, cy = sy * bh / 2;
    // The limits always take in the starting size (1), so a layer made thinner or bigger than them (the agent's 1%
    // underline, an image twice the frame) never jumps on the first move; it only can't be dragged further out.
    f = clamp(1 + k * (lx * cx + ly * cy) / (2 * (cx * cx + cy * cy) || 1), Math.min(1, Math.max(0.02 / base.width, 0.02 / base.height)), Math.max(1, Math.min(1.5 / base.width, 1.5 / base.height)));
    width = base.width * f; height = base.height * f;
    if (!fromCentre) { ux = (f - 1) * cx; uy = (f - 1) * cy; }
  } else if (sx) {
    const next = clamp(bw + k * lx * sx, Math.min(bw, 0.02 * frameW), Math.max(bw, 1.5 * frameW)); width = next / frameW;
    if (!fromCentre) ux = sx * (next - bw) / 2;
  } else if (sy) {
    const next = clamp(bh + k * ly * sy, Math.min(bh, 0.02 * frameH), Math.max(bh, 1.5 * frameH)); height = next / frameH;
    if (!fromCentre) uy = sy * (next - bh) / 2;
  }
  // The centre moves by the grown half, turned back into the frame's axes.
  const out: Partial<Layer> = { x: round(base.x + (ux * cos - uy * sin) / frameW), y: round(base.y + (ux * sin + uy * cos) / frameH), width: round(width), height: round(height) };
  if (base.kind === 'text' && sx && sy && typeof base.style?.size === 'number') out.style = { ...base.style, size: round(clamp(base.style.size * f, 0.01, 0.5)) };
  return out;
}

/** A turn from the keyboard: `by` degrees from `rotate`; with `steps` it lands on the 15° steps. Within ±180. */
export function turnBy(rotate: number, by: number, steps = false): number {
  let deg = (((rotate + by + 180) % 360) + 360) % 360 - 180;
  if (steps) deg = Math.round(deg / 15) * 15;
  deg = Math.round(deg);
  return deg === -180 ? 180 : deg;
}

/** The rotation after turning the pointer around the centre from `startAngle` to `angle` (degrees): Shift steps 15°, and it settles on straight (0, ±90, 180) within 4°. */
export function rotationFrom(base: number, startAngle: number, angle: number, steps = false): number {
  let deg = (((base + angle - startAngle + 180) % 360) + 360) % 360 - 180;
  if (steps) deg = Math.round(deg / 15) * 15;
  else { const straight = Math.round(deg / 90) * 90; if (Math.abs(deg - straight) < 4) deg = straight; }
  deg = Math.round(deg);
  return deg === -180 ? 180 : deg;
}

/** An arrow's two ends on the frame (fractions), as drawn: its rotation turns the tail around the tip. */
export function arrowEnds(l: Layer, W: number, H: number) {
  const tail = { x: round(l.style?.fromX ?? l.x - 0.2), y: round(l.style?.fromY ?? l.y - 0.2) };
  if (!l.rotate) return { tip: { x: l.x, y: l.y }, tail };
  const t = l.rotate * Math.PI / 180, px = (tail.x - l.x) * W, py = (tail.y - l.y) * H;
  return { tip: { x: l.x, y: l.y }, tail: { x: round(l.x + (px * Math.cos(t) - py * Math.sin(t)) / W), y: round(l.y + (px * Math.sin(t) + py * Math.cos(t)) / H) } };
}

/**
 * Where a selected box's turn knob and its "In front" tag go: the knob under the box, the tag over it, each moved to the
 * other side (or inside the box) when that would leave the picture, which clips them. `fw`/`fh` are the frame's size on
 * the screen; the box is turned like the layer, so the knob's spot is turned with it.
 */
export function handlePlaces(l: Pick<Layer, 'x' | 'y' | 'width' | 'height' | 'rotate'>, fw: number, fh: number) {
  const w = l.width * fw, h = l.height * fh, t = l.rotate * Math.PI / 180;
  const onFrame = (lx: number, ly: number) => { const x = l.x * fw + lx * Math.cos(t) - ly * Math.sin(t), y = l.y * fh + lx * Math.sin(t) + ly * Math.cos(t);
    return x >= 8 && x <= fw - 8 && y >= 8 && y <= fh - 8; };
  const knob: 'below' | 'above' | 'inside' = onFrame(0, h / 2 + 31) ? 'below' : onFrame(0, -h / 2 - 31) ? 'above' : 'inside';
  const tag: 'above' | 'below' | 'inside' = knob !== 'above' && onFrame(-w / 2, -h / 2 - 26) ? 'above' : knob !== 'below' && onFrame(-w / 2, h / 2 + 26) ? 'below' : 'inside';
  return { knob, tag };
}

/** The resize cursor that points the way a handle does once the box is turned. */
const cursorFor = (sx: Side, sy: Side, rotate: number) => ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(((((Math.atan2(sy, sx) * 180 / Math.PI + rotate) % 180) + 180) % 180) / 45) % 4];
const HANDLES: [Side, Side][] = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];

/**
 * Overlays moved, sized and turned right on the preview (Liam, 11-24: "make sure I can do all this on the screen like
 * rotate and move and resize and no need for these controls"): click one to select it, drag it to move (snaps to the
 * centre lines), drag a corner to resize keeping its shape or a side to stretch it (Alt: from the centre), drag the
 * knob under it to turn it (Shift: 15° steps, double-click: straight). An arrow is moved by its two ends. Arrow keys
 * nudge, B puts it behind or in front of the people; on a handle or the knob they size or turn it. Positions are the
 * edit's own (the Original frame); in a platform format the controls step aside and the layer panel sets them.
 */
export function PreviewLayerControls({ project, frame, previewWidth, enabled, disabled, selectedLayerId, select, change, beginEdit, endEdit }: {
  project: EditorProject; frame: number; previewWidth: number; enabled: boolean; disabled: boolean; selectedLayerId: string | null;
  select: (id: string | null) => void; change: (fn: (p: EditorProject) => EditorProject) => void; beginEdit: () => void; endEdit: (cancel: boolean) => void;
}) {
  const gesture = useRef<Gesture | null>(null), [guides, setGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  const reframed = !!project.delivery?.format && project.delivery.format !== 'original';
  // A drag the controls can't finish (they step aside mid-drag, as playback starts, or go away) still closes its undo
  // step, so later changes never join it.
  const endRef = useRef(endEdit); endRef.current = endEdit;
  const drop = () => { const g = gesture.current; gesture.current = null; if (g?.moved) endRef.current(false); };
  useEffect(() => { if (!enabled || reframed) { drop(); setGuides({ x: false, y: false }); } }, [enabled, reframed]);
  useEffect(() => drop, []);
  if (!enabled || reframed) return null;
  const W = project.output.width, H = project.output.height, scale = previewWidth / W, layers = grabbableLayers(project, frame, selectedLayerId, gesture.current?.base);
  const patch = (id: string, fn: (l: Layer) => Partial<Layer>) => change(p => ({ ...p, layers: (p.layers ?? []).map(l => l.id === id ? { ...l, ...fn(l) } as Layer : l) }));
  // An arrow moves whole: its tail goes with its tip.
  const shift = (l: Layer, dx: number, dy: number): Partial<Layer> => ({ x: round(l.x + dx), y: round(l.y + dy),
    ...(l.kind === 'arrow' ? { style: { ...l.style, fromX: round((l.style?.fromX ?? l.x - 0.2) + dx), fromY: round((l.style?.fromY ?? l.y - 0.2) + dy) } } : {}) });
  const start = (event: React.PointerEvent<HTMLElement>, l: Layer, part: Part, sx: Side = 0, sy: Side = 0) => {
    if (disabled || event.button !== 0) return; event.preventDefault(); event.stopPropagation();
    select(l.id); event.currentTarget.setPointerCapture(event.pointerId);
    const frameBox = event.currentTarget.closest('.preview-layer-controls')?.getBoundingClientRect();
    const cx = (frameBox?.left ?? 0) + l.x * W * scale, cy = (frameBox?.top ?? 0) + l.y * H * scale;
    gesture.current = { pointerId: event.pointerId, id: l.id, part, sx, sy, startX: event.clientX, startY: event.clientY, scale, base: l, moved: false,
      cx, cy, angle: Math.atan2(event.clientY - cy, event.clientX - cx) * 180 / Math.PI };
  };
  const move = (event: React.PointerEvent<HTMLElement>) => { const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    const px = event.clientX - g.startX, py = event.clientY - g.startY, dx = px / g.scale / W, dy = py / g.scale / H;
    if (!g.moved) { if (Math.abs(dx) + Math.abs(dy) < 0.003) return; g.moved = true; beginEdit(); }
    const b = g.base;
    if (g.part === 'move') {
      let x = clamp(b.x + dx, -0.1, 1.1), y = clamp(b.y + dy, -0.1, 1.1); const sx = Math.abs(x - 0.5) < SNAP, sy = Math.abs(y - 0.5) < SNAP;
      if (sx) x = 0.5; if (sy) y = 0.5; setGuides({ x: sx, y: sy });
      patch(g.id, () => shift(b, x - b.x, y - b.y));
    } else if (g.part === 'resize') patch(g.id, () => resizeLayer(b, g.sx, g.sy, px, py, W * g.scale, H * g.scale, event.altKey));
    else if (g.part === 'rotate') patch(g.id, () => ({ rotate: rotationFrom(b.rotate, g.angle, Math.atan2(event.clientY - g.cy, event.clientX - g.cx) * 180 / Math.PI, event.shiftKey) }));
    else { // an arrow's end: the drawn ends become its own (rotation folded in), then the dragged one follows the pointer
      const { tip, tail } = arrowEnds(b, W, H), end = g.part === 'tip' ? tip : tail;
      const at = { x: round(clamp(end.x + dx, -0.1, 1.1)), y: round(clamp(end.y + dy, -0.1, 1.1)) };
      patch(g.id, l => ({ rotate: 0, ...(g.part === 'tip' ? { x: at.x, y: at.y, style: { ...l.style, fromX: tail.x, fromY: tail.y } } : { style: { ...l.style, fromX: at.x, fromY: at.y } }) }));
    } };
  const end = (cancel: boolean) => (event: React.PointerEvent<HTMLElement>) => { const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null; setGuides({ x: false, y: false }); if (g.moved) endEdit(cancel); };
  const once = (id: string, fn: (l: Layer) => Partial<Layer>) => { beginEdit(); patch(id, fn); endEdit(false); };
  const key = (event: React.KeyboardEvent, l: Layer) => {
    if (event.key === 'b' || event.key === 'B') { event.preventDefault(); event.stopPropagation(); once(l.id, x => ({ behind: x.behind ? undefined : true })); return; }
    const d = event.shiftKey ? 0.02 : 0.005, dx = event.key === 'ArrowRight' ? d : event.key === 'ArrowLeft' ? -d : 0, dy = event.key === 'ArrowDown' ? d : event.key === 'ArrowUp' ? -d : 0;
    if (!dx && !dy) return; event.preventDefault(); event.stopPropagation(); once(l.id, x => shift(x, dx, dy)); };
  const handlers = { onPointerMove: move, onPointerUp: end(false), onPointerCancel: end(true), onLostPointerCapture: end(false) };
  // The keyboard's way to size and turn (WCAG 2.5.7: dragging is never the only way): on a corner, the arrows grow
  // (up, right) or shrink (down, left) the layer by 2% keeping its shape, 10% with Shift; on a side, they stretch it;
  // on the knob, they turn it 1°, 15° with Shift. Each press is one undo step; the centre stays put.
  const sizeKey = (event: React.KeyboardEvent, l: Layer, sx: Side, sy: Side) => {
    const sign = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!sign) return; event.preventDefault(); event.stopPropagation();
    const step = sign * (event.shiftKey ? 0.1 : 0.02), fw = W * scale, fh = H * scale, t = l.rotate * Math.PI / 180;
    // the move along the layer's own axes that grows it by that step from its centre, turned into the screen's
    const lx = sx && sy ? sx * l.width * fw / 2 * step : sx * step * fw / 2, ly = sx && sy ? sy * l.height * fh / 2 * step : sy * step * fh / 2;
    once(l.id, x => resizeLayer(x, sx, sy, lx * Math.cos(t) - ly * Math.sin(t), lx * Math.sin(t) + ly * Math.cos(t), fw, fh, true)); };
  const turnKey = (event: React.KeyboardEvent, l: Layer) => {
    const sign = event.key === 'ArrowUp' || event.key === 'ArrowRight' ? 1 : event.key === 'ArrowDown' || event.key === 'ArrowLeft' ? -1 : 0;
    if (!sign) return; event.preventDefault(); event.stopPropagation();
    once(l.id, x => ({ rotate: turnBy(x.rotate, sign * (event.shiftKey ? 15 : 1), event.shiftKey) })); };
  return <div className="preview-layer-controls" aria-label="Overlays on the preview">
    {guides.x ? <i className="layer-guide vertical" /> : null}{guides.y ? <i className="layer-guide horizontal" /> : null}
    {layers.map(l => { const on = l.id === selectedLayerId, label = l.kind === 'text' ? String(l.style?.text ?? 'Text') : l.name;
      const places = l.kind === 'arrow' ? { knob: 'below' as const, tag: 'above' as const } : handlePlaces(l, W * scale, H * scale);
      const behind = <button className={`layer-hit-behind ${places.tag}${l.behind ? ' on' : ''}`} disabled={disabled} title="Switch behind or in front of the people (B)"
        style={l.kind !== 'arrow' && l.rotate ? { transform: `rotate(${-l.rotate}deg)`, transformOrigin: places.tag === 'above' ? '0 100%' : '0 0' } : undefined}
        onPointerDown={e => e.stopPropagation()} onClick={() => once(l.id, x => ({ behind: x.behind ? undefined : true }))}>{l.behind ? 'Behind people ⇅' : 'In front ⇅'}</button>;
      const grab = <button className="layer-hit-move" disabled={disabled} aria-label={`${label}: drag to move`} title={`${label} · drag to move · arrows nudge · B: behind/in front`}
        onPointerDown={e => start(e, l, 'move')} {...handlers} onKeyDown={e => key(e, l)} />;
      if (l.kind === 'arrow') { // the box around both ends, upright; a knob on each end
        const { tip, tail } = arrowEnds(l, W, H), pad = 10, left = Math.min(tip.x, tail.x) * W * scale - pad, top = Math.min(tip.y, tail.y) * H * scale - pad;
        const knob = (part: 'tip' | 'tail', at: { x: number; y: number }) => <button className={`layer-hit-end ${part}`} disabled={disabled} aria-label={part === 'tip' ? 'Move the tip' : 'Move the start'}
          title={part === 'tip' ? 'Drag to move the tip' : 'Drag to move the start'} style={{ left: at.x * W * scale - left, top: at.y * H * scale - top }} onPointerDown={e => start(e, l, part)} {...handlers} />;
        return <div key={l.id} className={`layer-hit${on ? ' selected' : ''}`} style={{ left, top, width: Math.abs(tip.x - tail.x) * W * scale + pad * 2, height: Math.abs(tip.y - tail.y) * H * scale + pad * 2 }}>
          {grab}{on ? <>{knob('tail', tail)}{knob('tip', tip)}{behind}</> : null}</div>; }
      const w = l.width * W * scale, h = l.height * H * scale;
      return <div key={l.id} className={`layer-hit${on ? ' selected' : ''}`} style={{ left: (l.x - l.width / 2) * W * scale, top: (l.y - l.height / 2) * H * scale, width: w, height: h, transform: l.rotate ? `rotate(${l.rotate}deg)` : undefined }}>
        {grab}
        {on ? <>
          {HANDLES.filter(([sx, sy]) => (sx && sy) || (sx ? h >= 36 : w >= 36 && l.kind !== 'text')).map(([sx, sy]) => <button key={`${sx}${sy}`} className={`layer-hit-handle${sx && sy ? ' corner' : ''}`} disabled={disabled}
            aria-label={sx && sy ? 'Resize' : sx ? 'Change the width' : 'Change the height'} title={sx && sy ? 'Drag to resize · Alt: from the centre · arrow keys too' : 'Drag to stretch · Alt: from the centre · arrow keys too'}
            style={{ left: `${(sx + 1) * 50}%`, top: `${(sy + 1) * 50}%`, cursor: cursorFor(sx, sy, l.rotate) }} onPointerDown={e => start(e, l, 'resize', sx, sy)} {...handlers} onKeyDown={e => sizeKey(e, l, sx, sy)} />)}
          {places.knob !== 'inside' ? <i className={`layer-hit-stem ${places.knob}`} /> : null}
          <button className={`layer-hit-rotate ${places.knob}`} disabled={disabled} aria-label="Rotate" title="Drag to rotate · Shift: 15° steps · double-click: straight · arrow keys turn 1°"
            onPointerDown={e => start(e, l, 'rotate')} {...handlers} onKeyDown={e => turnKey(e, l)} onDoubleClick={() => once(l.id, () => ({ rotate: 0 }))} />
          {behind}
        </> : null}
      </div>; })}
  </div>;
}
