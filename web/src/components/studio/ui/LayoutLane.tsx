import React, { useEffect, useRef, useState } from 'react';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { layoutPresetOf, layoutPresets, moveShotChange, setLayoutRange, shotSegments, sourceLabel, type ShotSegment } from '@/lib/studio/engine/shots';

type Drag = { pointerId: number; kind: 'edge' | 'range'; x: number; width: number; base: EditorProject; boundary: number; before?: ShotSegment; after?: ShotSegment; from: number; to: number; moved: boolean };

export const presetShort = (label: string) => label.replace('Side by side · ', '↔ ').replace('Stacked · ', '↕ ').replace('Picture in picture', 'PiP').replace('One source', 'Single');

/**
 * The Layout track: one region per stretch that shows the same thing (a single source or a layout of several).
 * Drag a region's edge to move when the layout changes; drag across the track to choose a layout for that stretch;
 * click a region to select it (its sources, order and swap are in the inspector).
 */
export function LayoutLane({ project, duration, disabled, change, beginEdit, endEdit, seek, selectClips, notify }: {
  project: EditorProject; duration: number; disabled: boolean; change: (fn: (p: EditorProject) => EditorProject) => void;
  beginEdit: () => void; endEdit: (cancel: boolean) => void; seek: (frame: number) => void; selectClips: (ids: string[]) => void; notify?: (text: string, error?: boolean) => void;
}) {
  const drag = useRef<Drag | null>(null), [ghost, setGhost] = useState<{ from: number; to: number } | null>(null);
  const [picker, setPicker] = useState<{ from: number; to: number; left: number } | null>(null);
  useEffect(() => { if (!picker) return; const close = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest('.layout-picker')) setPicker(null); };
    window.addEventListener('pointerdown', close); return () => window.removeEventListener('pointerdown', close); }, [picker]);
  const segments = shotSegments(project);
  const frameAt = (clientX: number, d: Drag) => Math.max(0, Math.min(duration, Math.round((clientX - d.x) / d.width * duration)));
  const laneBox = (element: HTMLElement) => (element.closest('.layout-lane') as HTMLElement).getBoundingClientRect();
  const startEdge = (event: React.PointerEvent<HTMLElement>, index: number) => {
    if (disabled || event.button !== 0) return; event.preventDefault(); event.stopPropagation();
    const box = laneBox(event.currentTarget), before = segments[index]!, after = segments[index + 1]!;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, kind: 'edge', x: box.left, width: box.width, base: project, boundary: before.to, before, after, from: before.to, to: before.to, moved: false }; beginEdit();
  };
  const startRange = (event: React.PointerEvent<HTMLElement>) => {
    if (disabled || event.button !== 0) return; event.preventDefault();
    const box = laneBox(event.currentTarget); event.currentTarget.setPointerCapture(event.pointerId);
    const d: Drag = { pointerId: event.pointerId, kind: 'range', x: box.left, width: box.width, base: project, boundary: 0, from: 0, to: 0, moved: false };
    d.from = d.to = frameAt(event.clientX, d); drag.current = d;
  };
  const move = (event: React.PointerEvent<HTMLElement>) => { const d = drag.current; if (!d || d.pointerId !== event.pointerId) return;
    const at = frameAt(event.clientX, d); if (!d.moved && Math.abs(at - d.from) < duration * 0.004) return; d.moved = true; d.to = at;
    if (d.kind === 'edge') {
      // The edge can travel up to the far side of either neighbour, never past it.
      const limit = Math.max(d.before!.from + 1, Math.min(d.after!.to - 1, at));
      try { const next = moveShotChange(d.base, d.boundary, limit, d.before!.view, d.after!.view); change(() => next); } catch { /* inside a hold: keep the last valid edit */ }
    } else setGhost({ from: Math.min(d.from, at), to: Math.max(d.from, at) });
  };
  const end = (cancel: boolean) => (event: React.PointerEvent<HTMLElement>) => { const d = drag.current; if (!d || d.pointerId !== event.pointerId) return;
    drag.current = null; setGhost(null);
    if (d.kind === 'edge') { endEdit(cancel || !d.moved); return; }
    if (cancel) return;
    if (!d.moved) { const hit = segments.find(segment => d.from >= segment.from && d.from < segment.to); if (hit) { selectClips(hit.clipIds); seek(d.from); } return; }
    const box = laneBox(event.currentTarget);
    setPicker({ from: Math.min(d.from, d.to), to: Math.max(d.from, d.to), left: Math.min(box.width - 240, Math.max(0, (Math.min(d.from, d.to) / duration) * box.width)) });
  };
  const apply = (presetId: string) => { const range = picker; setPicker(null); if (!range) return;
    try { const next = setLayoutRange(project, range.from, range.to, presetId); change(() => next); notify?.(`${layoutPresets.find(item => item.id === presetId)!.label} from ${(range.from / project.output.fps).toFixed(1)}s to ${(range.to / project.output.fps).toFixed(1)}s`); }
    catch (error) { notify?.(error instanceof Error ? error.message : String(error), true); } };
  const handlers = { onPointerMove: move, onPointerUp: end(false), onPointerCancel: end(true) };
  return <div className="layout-lane" data-head="layout" role="group" aria-label="Layout track: what is on screen when" onPointerDown={startRange} {...handlers}
    title="Drag across to choose a layout for that stretch · drag an edge to move when it changes · click to select">
    {segments.map((segment, index) => { const preset = layoutPresets.find(item => item.id === layoutPresetOf(segment.view));
      const names = (segment.view.layout?.sources ?? [segment.view.main]).map(id => sourceLabel(project, id)).join(' + ');
      return <div key={`${segment.from}-${index}`} className={`layout-region ${segment.view.layout ? `kind-${segment.view.layout.kind}` : 'kind-single'}`}
        style={{ left: `${segment.from / duration * 100}%`, width: `${(segment.to - segment.from) / duration * 100}%` }}>
        <LayoutGlyph kind={segment.view.layout?.kind ?? 'single'} ratio={segment.view.layout?.ratio} />
        <span className="layout-name">{presetShort(preset?.label ?? segment.view.layout?.kind ?? 'Single')}</span><small>{names}</small>
        {index < segments.length - 1 ? <button className="layout-edge" aria-label={`Move the change at ${(segment.to / project.output.fps).toFixed(2)} seconds`} disabled={disabled}
          onPointerDown={event => startEdge(event, index)} {...handlers} onClick={event => event.stopPropagation()} /> : null}
      </div>; })}
    {ghost ? <span className="layout-ghost" style={{ left: `${ghost.from / duration * 100}%`, width: `${(ghost.to - ghost.from) / duration * 100}%` }} /> : null}
    {picker ? <div className="layout-picker" role="menu" style={{ left: picker.left }} onPointerDown={event => event.stopPropagation()}>
      <b>Show from {(picker.from / project.output.fps).toFixed(1)}s to {(picker.to / project.output.fps).toFixed(1)}s</b>
      {layoutPresets.map(item => <button key={item.id} role="menuitem" onClick={() => apply(item.id)}><LayoutGlyph kind={item.layout?.kind ?? 'single'} ratio={item.layout?.ratio} />{item.label}</button>)}
    </div> : null}
  </div>;
}

/** Tiny pictogram of a layout, so regions read at a glance. */
export function LayoutGlyph({ kind, ratio = 0.5 }: { kind: string; ratio?: number }) {
  const r = Math.round(ratio * 14);
  return <svg className="layout-glyph" width="18" height="12" viewBox="0 0 18 12" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="1" y="1" width="16" height="10" rx="1.5" />
    {kind === 'split' ? <path d={`M${1 + r} 1v10`} /> : kind === 'stack' ? <path d={`M1 ${1 + Math.round(ratio * 10)}h16`} /> : kind === 'pip' ? <rect x="10.5" y="6" width="5" height="3.5" rx=".6" fill="currentColor" /> : kind === 'grid' ? <path d="M9 1v10M1 6h16" /> : null}
  </svg>;
}
