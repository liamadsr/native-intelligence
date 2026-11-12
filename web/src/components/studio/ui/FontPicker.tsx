import React, { useEffect, useMemo, useRef, useState } from 'react';
import { request } from './client';
import { DEFAULT_FAMILIES, familyOf } from '@/lib/studio/engine/font-faces';

type Result = { family: string; source: 'fontshare' | 'fontsource'; category: string; mood: string; variable?: boolean };
type Installed = { family: string; weights: [number, number]; italic: boolean; variable: boolean };
const GENERIC: [string, string][] = [['sans', 'Sans'], ['display', 'Display'], ['heavy', 'Heavy'], ['serif', 'Serif'], ['mono', 'Mono']];
const GROUPS: Record<string, string> = { sans: 'Clean', display: 'Headlines', impact: 'Impact', serif: 'Serif', funky: 'Funky', mono: 'Mono', hand: 'Handwritten' };

/** Pick a typeface: the five generic choices, a shelf of video-grade type, and every family on Fontshare and Google Fonts.
 *  Picking one downloads it (once) so the preview and renders draw the real font. */
export function FontPicker({ value, onPick, onInfo }: { value?: string; onPick: (font: string) => void; onInfo?: (info: Installed | null) => void }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [results, setResults] = useState<Result[]>([]), [installed, setInstalled] = useState<Installed[]>([]);
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null), box = useRef<HTMLDivElement>(null);
  const family = familyOf(value);
  useEffect(() => { void request<{ installed: Installed[] }>('/api/account/studio/fonts').then(r => setInstalled(r.installed)).catch(() => {}); }, [busy]);
  useEffect(() => { onInfo?.(installed.find(f => f.family.toLowerCase() === family.toLowerCase()) ?? null); }, [installed, family]);
  useEffect(() => { if (!open) return; const t = setTimeout(() => { void request<{ results: Result[] }>(`/api/account/studio/fonts?q=${encodeURIComponent(query)}`).then(r => setResults(r.results ?? [])).catch(() => setResults([])); }, 180); return () => clearTimeout(t); }, [query, open]);
  useEffect(() => { if (!open) return; const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); }; document.addEventListener('mousedown', close); return () => document.removeEventListener('mousedown', close); }, [open]);
  const pick = async (font: string, download: boolean) => {
    setError(null);
    if (download) { setBusy(font); try { await request('/api/account/studio/fonts/install', { family: font }); } catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(null); return; } setBusy(null); }
    onPick(font); setOpen(false); setQuery('');
  };
  const groups = useMemo(() => { const m = new Map<string, Result[]>(); for (const r of results) { const g = query ? (r.mood === 'Fontshare' || r.mood === 'Google Fonts' ? r.mood : GROUPS[r.category] ?? r.category) : GROUPS[r.category] ?? r.category; m.set(g, [...(m.get(g) ?? []), r]); } return [...m]; }, [results, query]);
  const have = (f: string) => installed.some(i => i.family.toLowerCase() === f.toLowerCase());
  return <div className="font-picker" ref={box}>
    <button type="button" className="font-picker-current" onClick={() => setOpen(o => !o)} style={have(family) ? { fontFamily: `"${family}", Inter, sans-serif` } : undefined}>{family}<span>{value && value in DEFAULT_FAMILIES ? GENERIC.find(g => g[0] === value)?.[1] : ''} ▾</span></button>
    {open ? <div className="font-picker-menu">
      <input autoFocus placeholder="Search Fontshare and Google Fonts…" value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }} />
      {!query ? <div className="font-picker-generic">{GENERIC.map(([id, label]) => <button type="button" key={id} className={value === id ? 'active' : ''} onClick={() => void pick(id, false)}>{label}<small>{DEFAULT_FAMILIES[id as keyof typeof DEFAULT_FAMILIES]}</small></button>)}</div> : null}
      {error ? <p className="font-picker-error">{error}</p> : null}
      <div className="font-picker-list">{groups.map(([g, list]) => <section key={g}><h4>{g}</h4>{list.map(r => <button type="button" key={r.family} className={r.family === family ? 'active' : ''} disabled={!!busy} onClick={() => void pick(r.family, !have(r.family))}
        style={have(r.family) ? { fontFamily: `"${r.family}", Inter, sans-serif` } : undefined}>{busy === r.family ? 'Downloading…' : r.family}<small>{have(r.family) ? '' : '↓'}{r.variable ? ' variable' : ''}</small></button>)}</section>)}
        {!groups.length ? <p className="font-picker-empty">{query ? 'No family by that name.' : 'Loading…'}</p> : null}</div>
      <small className="font-picker-note">Fontshare fonts are free for commercial use; Google Fonts are open-licensed.</small>
    </div> : null}
  </div>;
}
