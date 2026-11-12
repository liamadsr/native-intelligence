import { studioKeys } from '../studio-env';
import React from 'react';
import { Icon } from './icons';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { exportPresets, formatPreset } from '@/lib/studio/engine/formats';
import { request } from './client';

// The format the preview, stills and export use: the edit's own shape, or a platform (YouTube, Shorts, TikTok, Reels,
// Stories, feed, LinkedIn, X, square). Choosing one never rewrites the edit: it is a reframed view (see deliveredProject).
// A narrower format measures where the person's face is once, so crops follow it; that is stored with the format (undoable).
const groups: { label: string; ids: string[] }[] = [
  { label: 'YouTube', ids: ['youtube', 'youtube-shorts'] }, { label: 'TikTok', ids: ['tiktok'] },
  { label: 'Instagram', ids: ['instagram-reels', 'instagram-story', 'instagram-feed'] },
  { label: 'More', ids: ['facebook-feed', 'linkedin', 'x', 'square'] },
];
const ratio = (w: number, h: number) => { const g = (a: number, b: number): number => b ? g(b, a % b) : a, d = g(w, h); const r = `${w / d}:${h / d}`; return r === '16:9' || r === '9:16' || r === '4:5' || r === '1:1' ? r : (w / h).toFixed(2); };
const Shape = ({ w, h }: { w: number; h: number }) => { const s = 14 / Math.max(w, h); return <span className="format-shape" style={{ width: Math.round(w * s), height: Math.round(h * s) }} aria-hidden="true" />; };

export function FormatPicker({ project, change, disabled }: { project: EditorProject; change: (fn: (p: EditorProject) => EditorProject) => void; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false), [measuring, setMeasuring] = React.useState(false), [error, setError] = React.useState<string | null>(null), box = React.useRef<HTMLDivElement>(null);
  const current = formatPreset(project.delivery?.format), w = current?.width ?? project.output.width, h = current?.height ?? project.output.height;
  React.useEffect(() => { if (!open) return; const close = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); }, esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close); studioKeys.addEventListener('keydown', esc); return () => { document.removeEventListener('pointerdown', close); studioKeys.removeEventListener('keydown', esc); }; }, [open]);
  const choose = async (format: string) => {
    setOpen(false); setError(null);
    change(p => ({ ...p, delivery: { format, ...(p.delivery?.focus ? { focus: p.delivery.focus } : {}) } }));
    const preset = formatPreset(format);
    if (!preset || Object.keys(project.delivery?.focus ?? {}).length || preset.width / preset.height >= project.output.width / project.output.height - 0.01) return;
    setMeasuring(true);
    try { const { focus } = await request<{ focus: Record<string, { x: number; y: number }> }>(`/api/account/studio/projects/${encodeURIComponent(project.id)}/delivery/focus`, {});
      change(p => p.delivery?.format === format ? { ...p, delivery: { format, focus } } : p); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setMeasuring(false); }
  };
  const item = (id: string, label: string, pw: number, ph: number) => <button key={id} role="menuitemradio" aria-checked={(project.delivery?.format ?? 'original') === id || (!current && id === 'original')} className="format-item" onClick={() => void choose(id)}>
    <Shape w={pw} h={ph} /><span className="format-name">{label}</span><span className="format-meta">{ratio(pw, ph)} · {pw}×{ph}</span></button>;
  return <div className="format-picker" ref={box}>
    <button className="format-button" disabled={disabled} aria-haspopup="menu" aria-expanded={open} title="Format: the shape the preview and export use" onClick={() => setOpen(!open)}>
      <Shape w={w} h={h} /><span>{current ? current.label.replace(/ \(.*\)$/, '') : 'Original'}</span><span className="format-meta">{ratio(w, h)}</span>{measuring ? <span className="format-busy">Finding faces…</span> : null}<Icon name="chevron" size={14}/></button>
    {error ? <span className="format-error" title={error}>Faces not found: crops stay centred</span> : null}
    {open ? <div className="format-menu" role="menu" aria-label="Format">
      {item('original', `Original`, project.output.width, project.output.height)}
      {groups.map(g => <React.Fragment key={g.label}><div className="format-group">{g.label}</div>
        {g.ids.map(id => { const p = exportPresets.find(x => x.id === id); return p ? item(p.id, p.label.replace(/ \(.*\)$/, ''), p.width, p.height) : null; })}</React.Fragment>)}
      <p className="format-note">Switching never changes your edit: cameras and footage follow the face, screens follow the pointer, text moves inside each app's safe area.</p>
    </div> : null}
  </div>;
}

/** Where the platform draws its own buttons and captions, shaded over the preview (toggle). */
export function SafeZones({ project }: { project: EditorProject }) {
  const p = formatPreset(project.delivery?.format); if (!p) return null; const s = p.safe;
  const band = (style: React.CSSProperties) => <div className="safe-band" style={style} />;
  return <div className="safe-zones" aria-hidden="true">
    {s.top ? band({ left: 0, right: 0, top: 0, height: `${s.top * 100}%` }) : null}{s.bottom ? band({ left: 0, right: 0, bottom: 0, height: `${s.bottom * 100}%` }) : null}
    {s.left ? band({ left: 0, top: `${s.top * 100}%`, bottom: `${s.bottom * 100}%`, width: `${s.left * 100}%` }) : null}{s.right ? band({ right: 0, top: `${s.top * 100}%`, bottom: `${s.bottom * 100}%`, width: `${s.right * 100}%` }) : null}
    <span className="safe-label">{p.label.replace(/ \(.*\)$/, '')} UI</span></div>;
}
