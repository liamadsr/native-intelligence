import React, { useRef, useState } from 'react';
import { curveValue, erasePoints, normalizePoints, simplifyPoints, spliceCurve, type AutomationPoint, type ParamInfo } from '@/lib/studio/engine/automation';

export type AutomationTool = 'pointer' | 'pencil' | 'line' | 'eraser';
export const automationTools: { id: AutomationTool; label: string; key: string; help: string }[] = [
  { id: 'pointer', label: 'Pointer', key: 'V', help: 'Click to add a point · drag points to shape · double-click a point to delete' },
  { id: 'pencil', label: 'Pencil', key: 'P', help: 'Draw the curve freehand' },
  { id: 'line', label: 'Line', key: 'L', help: 'Drag to draw a straight ramp' },
  { id: 'eraser', label: 'Eraser', key: 'E', help: 'Drag across points (or click one) to remove them' },
];

/** Line colour per main-picture parameter, so each curve reads as itself. */
export const paramTone: Record<string, string> = { zoom: '#f2a65a', panX: '#6fd3a6', panY: '#6fd3a6', shiftX: '#6fb8ff', shiftY: '#6fb8ff', rotate: '#c8a2ff', blur: '#9fb4ff', opacity: '#e6e6ea', volume: '#e16ad8' };

/** Curve area inside the track, in % of its height: room at the top for point value labels so nothing spills out. */
const TOP = 26, SPAN = 68;
type Gesture = { pointerId: number; base: AutomationPoint[]; tool: AutomationTool; index?: number; anchor?: AutomationPoint; samples?: AutomationPoint[]; lo?: number; hi?: number };

/**
 * Logic-style automation drawn on top of a track (fills its position:relative parent). Works on any curve: give it the
 * parameter's range and the points, and it hands back new points. Every gesture is one undo step.
 */
export function AutomationOverlay({ info, points, setPoints, duration, disabled, beginEdit, endEdit, seek, tool = 'pointer', tone }: {
  info: Pick<ParamInfo, 'label' | 'min' | 'max' | 'neutral' | 'format'>; points: AutomationPoint[]; setPoints: (next: AutomationPoint[]) => void;
  duration: number; disabled: boolean; beginEdit: () => void; endEdit: (cancel: boolean) => void; seek: (frame: number) => void; tool?: AutomationTool; tone?: string;
}) {
  const box = useRef<HTMLDivElement>(null), gesture = useRef<Gesture | null>(null), [active, setActive] = useState<number | null>(null);
  const range = info.max - info.min || 1;
  const at = (event: { clientX: number; clientY: number }): AutomationPoint => {
    const rect = box.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, ((event.clientY - rect.top) / Math.max(1, rect.height) * 100 - TOP) / SPAN));
    return { frame: Math.round(x * duration), value: info.max - y * range };
  };
  const yOf = (value: number) => TOP + (1 - (value - info.min) / range) * SPAN;
  const commit = (next: AutomationPoint[]) => setPoints(normalizePoints(next, info.min, info.max));
  const eraseReach = () => { const width = box.current?.getBoundingClientRect().width ?? 1000; return Math.max(1, Math.round(6 / width * duration)); };

  const start = (event: React.PointerEvent, next: Gesture) => {
    event.preventDefault(); event.stopPropagation(); box.current!.setPointerCapture(event.pointerId);
    gesture.current = next; beginEdit();
  };
  const onDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    const point = at(event), base = points.map(item => ({ ...item }));
    if (tool === 'pointer') {
      // Add a point where you click, then keep dragging it.
      const next = normalizePoints([...base, point], info.min, info.max), index = next.findIndex(item => item.frame === point.frame);
      start(event, { pointerId: event.pointerId, base: next, tool, index }); setActive(index); commit(next); return;
    }
    if (tool === 'pencil') { start(event, { pointerId: event.pointerId, base, tool, samples: [point] }); return; }
    if (tool === 'line') { start(event, { pointerId: event.pointerId, base, tool, anchor: point }); return; }
    start(event, { pointerId: event.pointerId, base, tool, lo: point.frame, hi: point.frame });
    commit(erasePoints(base, point.frame - eraseReach(), point.frame + eraseReach()));
  };
  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    const point = at(event);
    if (g.tool === 'pointer' && g.index !== undefined) {
      const next = g.base.map(item => ({ ...item })), index = Math.min(g.index, next.length - 1); if (index < 0) return;
      const frame = Math.max(next[index - 1] ? next[index - 1]!.frame + 1 : 0, Math.min(next[index + 1] ? next[index + 1]!.frame - 1 : duration, point.frame));
      next[index] = { ...next[index]!, frame, value: point.value }; commit(next); return;
    }
    if (g.tool === 'pencil') {
      g.samples!.push(point);
      const samples = normalizePoints(g.samples!, info.min, info.max); if (samples.length < 2) return;
      const lo = samples[0]!.frame, hi = samples.at(-1)!.frame;
      // Freehand: the stroke replaces whatever was under it; dense samples are simplified to a few editable points.
      commit(spliceCurve(g.base, lo, hi, simplifyPoints(samples, range).map((item, i) => i ? { ...item, curve: 'linear' as const } : item), info.neutral, info.min, info.max)); return;
    }
    if (g.tool === 'line') {
      const a = g.anchor!, lo = Math.min(a.frame, point.frame), hi = Math.max(a.frame, point.frame); if (hi === lo) return;
      const first = a.frame <= point.frame ? a : point, last = a.frame <= point.frame ? point : a;
      commit(spliceCurve(g.base, lo, hi, [{ frame: first.frame, value: first.value }, { frame: last.frame, value: last.value, curve: 'linear' }], info.neutral, info.min, info.max)); return;
    }
    g.lo = Math.min(g.lo!, point.frame); g.hi = Math.max(g.hi!, point.frame);
    commit(erasePoints(g.base, g.lo - eraseReach(), g.hi + eraseReach()));
  };
  const onUp = (cancel: boolean) => (event: React.PointerEvent<HTMLDivElement>) => {
    const g = gesture.current; if (!g || g.pointerId !== event.pointerId) return;
    if (!cancel && g.tool === 'pencil' && g.samples!.length === 1) commit([...g.base.filter(item => item.frame !== g.samples![0]!.frame), g.samples![0]!]);
    gesture.current = null; setActive(null); endEdit(cancel);
  };
  const pointDown = (event: React.PointerEvent, index: number) => {
    if (disabled || event.button !== 0) return;
    if (tool === 'eraser') { event.stopPropagation(); event.preventDefault(); beginEdit(); commit(points.filter((_, i) => i !== index)); endEdit(false); return; }
    if (tool !== 'pointer') return; // pencil and line strokes may start on a point
    start(event, { pointerId: event.pointerId, base: points.map(item => ({ ...item })), tool: 'pointer', index }); setActive(index);
  };

  const steps = Math.min(900, Math.max(120, points.length * 24));
  const path = points.length ? Array.from({ length: steps + 1 }, (_, i) => { const f = i / steps * duration;
    return `${i ? 'L' : 'M'}${(f / duration * 1000).toFixed(2)},${yOf(curveValue(points, f, info.neutral, info.min, info.max)).toFixed(2)}`; }).join(' ')
    : `M0,${yOf(info.neutral)} L1000,${yOf(info.neutral)}`;
  return <div ref={box} className={`automation-overlay tool-${tool} ${points.length ? 'has-points' : ''}`} style={tone ? { ['--auto-tone' as string]: tone } : undefined}
    onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp(false)} onPointerCancel={onUp(true)}
    title={`${info.label} · ${automationTools.find(item => item.id === tool)!.help}`}>
    <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true"><path className="auto-fill" d={`${path} L1000,100 L0,100 Z`} /><path className="auto-line" d={path} vectorEffect="non-scaling-stroke" /></svg>
    {!points.length ? <span className="auto-empty">{info.label} · {info.format(info.neutral)} · {tool === 'pencil' ? 'draw to automate' : tool === 'line' ? 'drag a ramp' : tool === 'eraser' ? 'nothing to erase' : 'click to add a point'}</span> : null}
    {points.map((point, index) => <button key={`${point.frame}-${index}`} className={`auto-point ${active === index ? 'dragging' : ''}`} disabled={disabled}
      style={{ left: `${point.frame / duration * 100}%`, top: `${yOf(point.value)}%` }} aria-label={`${info.label} ${info.format(point.value)} at frame ${point.frame}`}
      onPointerDown={event => pointDown(event, index)}
      onDoubleClick={event => { event.stopPropagation(); beginEdit(); commit(points.filter((_, i) => i !== index)); endEdit(false); }}
      onClick={event => { event.stopPropagation(); if (tool === 'pointer') seek(point.frame); }}><span className="auto-point-value">{info.format(point.value)}</span></button>)}
  </div>;
}
