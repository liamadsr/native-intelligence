import React, { useRef, useState } from 'react';
import type { EditorProject } from '@/lib/studio/engine/contracts';

type Layer = NonNullable<EditorProject['layers']>[number];
type Gesture = { pointerId: number; id: string; part: 'move' | 'resize'; startX: number; startY: number; scale: number; base: Layer; moved: boolean };
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const SNAP = 0.012;

/** Layers you can grab on the preview at this frame: not full-frame backdrops or scenes. */
export function grabbableLayers(project: EditorProject, frame: number) {
  return (project.layers ?? []).filter(l => frame >= l.startFrame && frame < l.endFrame && l.kind !== 'background' && !(l.width >= 0.97 && l.height >= 0.97));
}

/**
 * Text and other overlays moved right on the preview: click one to select it, drag to move it (snaps to the centre
 * lines), drag the corner to resize it (text grows with its box), arrow keys nudge, B puts it behind or in front of
 * the people. Positions are the edit's own (the Original frame); in a platform format the controls step aside.
 */
export function PreviewLayerControls({ project, frame, previewWidth, enabled, disabled, selectedLayerId, select, change, beginEdit, endEdit }: {
  project: EditorProject; frame: number; previewWidth: number; enabled: boolean; disabled: boolean; selectedLayerId: string | null;
  select: (id: string | null) => void; change: (fn: (p: EditorProject) => EditorProject) => void; beginEdit: () => void; endEdit: (cancel: boolean) => void;
}) {
  const gesture = useRef<Gesture | null>(null), [guides, setGuides] = useState<{ x: boolean; y: boolean }>({ x: false, y: false });
  const reframed = !!project.delivery?.format && project.delivery.format !== 'original';
  if (!enabled || reframed) return null;
  const W = project.output.width, H = project.output.height, scale = previewWidth / W, layers = grabbableLayers(project, frame);
  const patch = (id: string, fn: (l: Layer) => Partial<Layer>) => change(p => ({ ...p, layers: (p.layers ?? []).map(l => l.id === id ? { ...l, ...fn(l) } as Layer : l) }));
  const box = (l: Layer) => ({ left: (l.x - l.width / 2) * W * scale, top: (l.y - l.height / 2) * H * scale, width: l.width * W * scale, height: l.height * H * scale });
  const start = (event: React.PointerEvent<HTMLElement>, l: Layer, part: Gesture['part']) => {
    if (disabled || event.button !== 0) return; event.preventDefault(); event.stopPropagation();
    select(l.id); event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, id: l.id, part, startX: event.clientX, startY: event.clientY, scale, base: l, moved: false };
  };
  const move = (event: React.PointerEvent<HTMLElement>) => { const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    const dx = (event.clientX - g.startX) / g.scale / W, dy = (event.clientY - g.startY) / g.scale / H;
    if (!g.moved) { if (Math.abs(dx) + Math.abs(dy) < 0.003) return; g.moved = true; beginEdit(); }
    if (g.part === 'move') {
      let x = clamp(g.base.x + dx, -0.1, 1.1), y = clamp(g.base.y + dy, -0.1, 1.1); const sx = Math.abs(x - 0.5) < SNAP, sy = Math.abs(y - 0.5) < SNAP;
      if (sx) x = 0.5; if (sy) y = 0.5; setGuides({ x: sx, y: sy });
      patch(g.id, () => ({ x: +x.toFixed(4), y: +y.toFixed(4) }));
    } else { // corner: grow from the centre, keep the shape; text size follows the box
      const f = clamp((g.base.width + dx * 2) / g.base.width, 0.2, 5);
      patch(g.id, l => ({ width: +clamp(g.base.width * f, 0.02, 1.5).toFixed(4), height: +clamp(g.base.height * f, 0.02, 1.5).toFixed(4),
        ...(l.kind === 'text' && typeof g.base.style?.size === 'number' ? { style: { ...l.style, size: +clamp(g.base.style.size * f, 0.01, 0.5).toFixed(4) } } : {}) }));
    } };
  const end = (cancel: boolean) => (event: React.PointerEvent<HTMLElement>) => { const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null; setGuides({ x: false, y: false }); if (g.moved) endEdit(cancel); };
  const key = (event: React.KeyboardEvent, l: Layer) => {
    if (event.key === 'b' || event.key === 'B') { event.preventDefault(); event.stopPropagation(); beginEdit(); patch(l.id, x => ({ behind: x.behind ? undefined : true })); endEdit(false); return; }
    const d = event.shiftKey ? 0.02 : 0.005, dx = event.key === 'ArrowRight' ? d : event.key === 'ArrowLeft' ? -d : 0, dy = event.key === 'ArrowDown' ? d : event.key === 'ArrowUp' ? -d : 0;
    if (!dx && !dy) return; event.preventDefault(); event.stopPropagation(); beginEdit(); patch(l.id, x => ({ x: +(x.x + dx).toFixed(4), y: +(x.y + dy).toFixed(4) })); endEdit(false); };
  const handlers = { onPointerMove: move, onPointerUp: end(false), onPointerCancel: end(true) };
  return <div className="preview-layer-controls" aria-label="Overlays on the preview">
    {guides.x ? <i className="layer-guide vertical" /> : null}{guides.y ? <i className="layer-guide horizontal" /> : null}
    {layers.map(l => { const on = l.id === selectedLayerId, label = l.kind === 'text' ? String(l.style?.text ?? 'Text') : l.name;
      return <div key={l.id} className={`layer-hit${on ? ' selected' : ''}`} style={box(l)}>
        <button className="layer-hit-move" disabled={disabled} aria-label={`${label}: drag to move`} title={`${label} · drag to move · arrows nudge · B: behind/in front`}
          onPointerDown={e => start(e, l, 'move')} {...handlers} onKeyDown={e => key(e, l)} />
        {on ? <>
          <button className="layer-hit-resize" disabled={disabled} aria-label="Resize" title="Drag to resize" onPointerDown={e => start(e, l, 'resize')} {...handlers} />
          <button className={`layer-hit-behind${l.behind ? ' on' : ''}`} disabled={disabled} title="Switch behind or in front of the people (B)"
            onPointerDown={e => e.stopPropagation()} onClick={() => { beginEdit(); patch(l.id, x => ({ behind: x.behind ? undefined : true })); endEdit(false); }}>{l.behind ? 'Behind people ⇅' : 'In front ⇅'}</button>
        </> : null}
      </div>; })}
  </div>;
}
