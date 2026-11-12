import React, { useRef } from 'react';
import type { EditorProject, ShotLayout } from '@/lib/studio/engine/contracts';
import { defaultInset, layoutArea, layoutTiles, setSegmentLayout, shotSegments, sourceLabel } from '@/lib/studio/engine/shots';

type Gesture = { pointerId: number; part: 'divider' | 'move' | 'resize'; startX: number; startY: number; scale: number; base: EditorProject; clipIds: string[]; layout: ShotLayout };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Direct manipulation of the layout under the playhead: drag the divider of a side-by-side or stacked layout, or move
 * and resize the picture-in-picture window. The change applies to that whole stretch of the Layout track.
 */
export function PreviewLayoutControls({ project, frame, previewWidth, enabled, disabled, change, beginEdit, endEdit }: {
  project: EditorProject; frame: number; previewWidth: number; enabled: boolean; disabled: boolean;
  change: (fn: (p: EditorProject) => EditorProject) => void; beginEdit: () => void; endEdit: (cancel: boolean) => void;
}) {
  const gesture = useRef<Gesture | null>(null);
  const segment = shotSegments(project).find(item => frame >= item.from && frame < item.to), layout = segment?.view.layout;
  if (!enabled || !segment || !layout || layout.kind === 'grid') return null;
  const scale = previewWidth / project.output.width, { area, gap } = layoutArea(project);
  const px = (rect: { x: number; y: number; width: number; height: number }) => ({ left: rect.x * scale, top: rect.y * scale, width: rect.width * scale, height: rect.height * scale });
  const tiles = layoutTiles(layout, area, gap);
  const start = (event: React.PointerEvent<HTMLElement>, part: Gesture['part']) => {
    if (disabled || event.button !== 0) return; event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, part, startX: event.clientX, startY: event.clientY, scale, base: project, clipIds: segment.clipIds, layout }; beginEdit();
  };
  const move = (event: React.PointerEvent<HTMLElement>) => { const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    const dx = (event.clientX - g.startX) / g.scale, dy = (event.clientY - g.startY) / g.scale;
    let patch: Partial<ShotLayout>;
    if (g.part === 'divider') { const ratio = g.layout.ratio ?? 0.5;
      patch = { ratio: +clamp(ratio + (g.layout.kind === 'split' ? dx / (area.width - gap) : dy / (area.height - gap)), 0.15, 0.85).toFixed(3) }; }
    else { const inset = g.layout.inset ?? defaultInset(area, gap);
      if (g.part === 'move') patch = { inset: { ...inset, x: +clamp(inset.x + dx / area.width, 0, 1 - inset.width).toFixed(4), y: +clamp(inset.y + dy / area.height, 0, 1 - inset.height).toFixed(4) } };
      else { // Corner drag keeps the window's shape.
        const width = clamp(inset.width + dx / area.width, 0.08, Math.min(0.9, 1 - inset.x)), height = clamp(inset.height * width / inset.width, 0.08, Math.min(0.9, 1 - inset.y));
        patch = { inset: { ...inset, width: +width.toFixed(4), height: +height.toFixed(4) } }; } }
    const next = setSegmentLayout(g.base, g.clipIds, patch); change(() => next); };
  const end = (cancel: boolean) => (event: React.PointerEvent<HTMLElement>) => { const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null; endEdit(cancel); };
  const handlers = { onPointerMove: move, onPointerUp: end(false), onPointerCancel: end(true) };
  const [first, second] = tiles;
  return <div className="preview-layout-controls" aria-label="Layout on the preview">
    {tiles.map(tile => <span key={tile.source} className="layout-tile-label" style={{ left: tile.rect.x * scale + 6, top: tile.rect.y * scale + 6 }}>{sourceLabel(project, tile.source)}</span>)}
    {(layout.kind === 'split' || layout.kind === 'stack') && first && second ? (() => {
      const vertical = layout.kind === 'split', at = vertical ? (first.rect.x + first.rect.width + gap / 2) * scale : (first.rect.y + first.rect.height + gap / 2) * scale;
      return <button className={`layout-divider ${vertical ? 'vertical' : 'horizontal'}`} disabled={disabled} aria-label={`Resize: ${Math.round((layout.ratio ?? 0.5) * 100)}% / ${Math.round((1 - (layout.ratio ?? 0.5)) * 100)}%`}
        title="Drag to resize · double-click for 50/50" style={vertical ? { left: at, top: area.y * scale, height: area.height * scale } : { top: at, left: area.x * scale, width: area.width * scale }}
        onPointerDown={event => start(event, 'divider')} {...handlers}
        onDoubleClick={() => { beginEdit(); change(p => setSegmentLayout(p, segment.clipIds, { ratio: 0.5 })); endEdit(false); }}
        onKeyDown={event => { const step = (event.shiftKey ? 0.05 : 0.01) * (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0);
          if (!step) return; event.preventDefault(); event.stopPropagation(); change(p => setSegmentLayout(p, segment.clipIds, { ratio: clamp((layout.ratio ?? 0.5) + step, 0.15, 0.85) })); }}>
        <span>{Math.round((layout.ratio ?? 0.5) * 100)} / {Math.round((1 - (layout.ratio ?? 0.5)) * 100)}</span></button>; })() : null}
    {layout.kind === 'pip' && second ? <div className="layout-inset" style={px(second.rect)}>
      <button className="layout-inset-move" disabled={disabled} aria-label="Move the picture-in-picture window" title="Drag to move · arrow keys nudge" onPointerDown={event => start(event, 'move')} {...handlers}
        onKeyDown={event => { const inset = layout.inset ?? defaultInset(area, gap), d = event.shiftKey ? 0.05 : 0.01;
          const dx = event.key === 'ArrowRight' ? d : event.key === 'ArrowLeft' ? -d : 0, dy = event.key === 'ArrowDown' ? d : event.key === 'ArrowUp' ? -d : 0; if (!dx && !dy) return;
          event.preventDefault(); event.stopPropagation(); change(p => setSegmentLayout(p, segment.clipIds, { inset: { ...inset, x: clamp(inset.x + dx, 0, 1 - inset.width), y: clamp(inset.y + dy, 0, 1 - inset.height) } })); }} />
      <button className="layout-inset-resize" disabled={disabled} aria-label="Resize the picture-in-picture window" title="Drag to resize" onPointerDown={event => start(event, 'resize')} {...handlers} />
    </div> : null}
  </div>;
}
