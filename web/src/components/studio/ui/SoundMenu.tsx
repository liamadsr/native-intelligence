import { fitMenu } from '../studio-env';
import React, { useEffect, useRef, useState } from 'react';
import { request } from './client';

/** Sound kinds a person can drop at the playhead (earshot kit roles of the launch preset). */
const kinds: { id: string; label: string; help: string }[] = [
  { id: 'pop', label: 'Pop', help: 'Soft rounded pop — chips, cards, rows arriving' },
  { id: 'whoosh.short', label: 'Whoosh', help: 'Fast air whoosh — whips, slides, titles flying in' },
  { id: 'whoosh.long', label: 'Big whoosh', help: 'Low whoosh landing with a thump — reveals' },
  { id: 'hit', label: 'Hit', help: 'Short punchy cut hit' },
  { id: 'land', label: 'Land', help: 'Round low thump — something lands' },
  { id: 'click', label: 'Click', help: 'A real-sounding mouse/trackpad click' },
  { id: 'click.confirm', label: 'Ding', help: 'Notification ding' },
  { id: 'tick', label: 'Tick', help: 'Airy tiny tick' },
  { id: 'riser', label: 'Riser', help: 'Short dark riser leading into the playhead' },
  { id: 'swell', label: 'Reverse swell', help: 'Swells into the playhead' },
  { id: 'bell', label: 'Bell', help: 'Glockenspiel note — logo, success' },
  { id: 'snap', label: 'Shutter', help: 'Camera shutter — snap zooms, screenshots' },
];

type Job = { id: string; status: string; progress: number; logs: string[]; error?: string; result?: Record<string, any> };
export type ListenReport = { critique?: { verdict?: string; score?: number; text?: string }; timeline?: { summary?: string; text?: string }; sheet?: { png?: string }; folder?: string };

/** ♪ Sound ▾ — the automatic sound pass, single sounds at the playhead, and earshot listening to the mix. */
export function SoundMenu({ projectId, at, disabled, notify }: { projectId: string; at: number; disabled: boolean; notify?: (text: string, error?: boolean) => void }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState<{ label: string; progress: number; note: string } | null>(null), [report, setReport] = useState<ListenReport | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (!open) return; const close = (e: PointerEvent) => { if (!(e.target as HTMLElement).closest('.sound-menu')) setOpen(false); }; window.addEventListener('pointerdown', close); return () => window.removeEventListener('pointerdown', close); }, [open]);
  const run = async (label: string, path: string, body: unknown) => {
    setOpen(false); setBusy({ label, progress: 0, note: 'Starting…' });
    try {
      const { job } = await request<{ job: Job }>(`/api/account/studio/projects/${encodeURIComponent(projectId)}/${path}`, body);
      for (;;) { await new Promise(done => setTimeout(done, 900)); if (!alive.current) return null;
        const { job: now } = await request<{ job: Job }>(`/api/account/studio/jobs/${job.id}`);
        if (now.status === 'completed') { setBusy(null); return now; }
        if (now.status !== 'running') throw new Error(now.error ?? now.status);
        setBusy({ label, progress: now.progress, note: now.logs.at(-1) ?? '' }); }
    } catch (error) { setBusy(null); notify?.(error instanceof Error ? error.message : String(error), true); return null; }
  };
  const pass = async () => { const done = await run('Sound design', 'sound-pass', {}); if (done) { const n = done.result?.placed?.length ?? 0; notify?.(`${n} sound${n === 1 ? '' : 's'} placed on the Sound effects track · double-click one to remove it`); } };
  const one = async (kind: string, label: string) => { const done = await run(label, 'sounds', { sounds: [{ at, kind, label }] }); if (done) notify?.(`${label} added at ${at.toFixed(2)} s`); };
  const listen = async () => { const done = await run('Listening', 'listen', {}); if (done) setReport(done.result as ListenReport); };
  return <div className="tl-menu sound-menu">
    <button aria-expanded={open} disabled={disabled || !!busy} onClick={() => setOpen(!open)} title="Sound effects made in code (earshot), placed on the picture's moments">{busy ? `♪ ${busy.label} ${Math.round(busy.progress * 100)}%` : '♪ Sound ▾'}</button>
    {open ? <div className="tl-menu-list" role="menu" ref={fitMenu}>
      <button role="menuitem" onClick={() => void pass()}><b>Sound the whole video</b><small>A sound for every entrance, transition and click — replaces the last automatic pass</small></button>
      <button role="menuitem" onClick={() => void listen()}><b>Listen &amp; check</b><small>earshot hears the mix: sync to every moment, loudness, a launch-film scorecard</small></button>
      <div className="tl-menu-sep">At the playhead</div>
      {kinds.map(kind => <button key={kind.id} role="menuitem" onClick={() => void one(kind.id, kind.label)}><b>{kind.label}</b><small>{kind.help}</small></button>)}
    </div> : null}
    {busy ? <span className="sound-busy" title={busy.note}>{busy.note}</span> : null}
    {report ? <div className="listen-report" role="dialog" aria-label="What earshot heard">
      <header><b>What earshot heard</b>{report.critique?.verdict ? <span className={`verdict v-${report.critique.verdict.replace(/\W+/g, '-')}`}>{report.critique.verdict}</span> : null}<button onClick={() => setReport(null)} aria-label="Close">✕</button></header>
      {report.sheet?.png && report.folder ? <img src={`/api/account/studio/listen/${encodeURIComponent(report.folder.split('/').pop()!)}/sheet.png`} alt="Annotated listening sheet: events, spectrogram, loudness, sync markers" /> : null}
      {report.critique?.text ? <pre>{report.critique.text}</pre> : null}
      {report.timeline?.text ? <details><summary>Listening transcript</summary><pre>{report.timeline.text}</pre></details> : null}
    </div> : null}
  </div>;
}
