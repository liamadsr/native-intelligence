import { studioKeys } from '../studio-env';
import React from 'react';
import { Icon, type IconName } from './icons';

export function IconButton({ icon, label, ...props }: {icon: IconName; label: string} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type="button" title={label} aria-label={label} {...props}><Icon name={icon}/></button>;
}
export function Slider({label, value, min = 0, max, step = 1, unit = '', resetValue, onChange}: {label: string; value: number; min?: number; max: number; step?: number; unit?: string; resetValue?:number; onChange: (n: number) => void}) {
  const inputId=React.useId(),reset=Math.min(max,Math.max(min,resetValue??min));
  return <div className="field"><label className="field-label" htmlFor={inputId}>{label}<output>{Math.round(value * 100) / 100}{unit}</output></label><div className="slider-row"><input id={inputId} type="range" aria-label={label} value={value} min={min} max={max} step={step} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown'].includes(e.key))e.stopPropagation();}} onChange={(e) => onChange(Number(e.target.value))}/><button type="button" className="slider-reset" title={`Reset ${label}`} aria-label={`Reset ${label}`} disabled={value===reset} onClick={()=>onChange(reset)}><Icon name="undo" size={14}/></button></div></div>;
}
export function NumberField({label, value, min = 0, max, step = .1, onChange}: {label: string; value: number; min?: number; max: number; step?: number; onChange: (n: number) => void}) {
  return <label>{label}<input type="number" aria-label={label} min={min} max={max} step={step} value={Math.round(value * 1000) / 1000} onChange={(e) => { if (e.target.value !== '') { const n = Number(e.target.value); if (Number.isFinite(n)) onChange(Math.min(max, Math.max(min, n))); } }}/></label>;
}
export function Toggle({label, checked, onChange}: {label: string; checked: boolean; onChange: (v: boolean) => void}) {
  return <label className="toggle-row">{label}<input className="toggle" type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)}/></label>;
}
export function Modal({title, close, children, wide}: {title: string; close: () => void; children: React.ReactNode; wide?: boolean}) {
  const headingId = React.useId();
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab') { const els = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]') ?? []); const first = els[0], last = els.at(-1); if (!first || !last) return; if (e.shiftKey && (document.activeElement === first || document.activeElement === ref.current)) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    };
    studioKeys.addEventListener('keydown', handle); return () => { studioKeys.removeEventListener('keydown', handle); previous?.focus(); };
  }, [close]);
  return <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}><div className={wide ? "modal modal-wide" : "modal"} ref={ref} role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}><div className="modal-heading"><h2 id={headingId}>{title}</h2><IconButton icon="close" label="Close dialog" onClick={close}/></div>{children}</div></div>;
}
export function Waveform({values}: {values: number[]}) {
  if (!values.length) return null;
  return <svg className="waveform" viewBox={`0 0 ${values.length} 32`} preserveAspectRatio="none" aria-label="Recorded audio waveform"><path d={`M0 32 ${values.map((v,i) => `L${i} ${32 - v * 29}`).join(' ')} L${values.length} 32Z`} fill="currentColor"/></svg>;
}
