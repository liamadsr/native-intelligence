import React, { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { request } from './client';

type Job = { id: string; status: string; progress: number; logs: string[]; error?: string; result?: MotionReport };
export type MotionReport = { text?: string; name?: string; offsetSeconds?: number; summary?: Record<string, unknown>;
  pictures?: Record<string, string>; handoffs?: { start: number; end: number; kind: string; picture?: string }[];
  compare?: { score: number; text: string; issues: { label: string; ours: number; refs: number[]; fix: string }[] } | null };

/** Motion check — the Studio worker renders the picture and watches it: how alive it is, how moves start and settle, how beats hand
 *  off, against reference launch films. Shows the timeline strip, what to fix first, and filmstrips of the handoffs. */
export function MotionCheck({ projectId, disabled, notify }: { projectId: string; disabled: boolean; notify?: (text: string, error?: boolean) => void }) {
  const [busy, setBusy] = useState<{ progress: number; note: string } | null>(null), [report, setReport] = useState<MotionReport | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const check = async () => {
    setBusy({ progress: 0, note: 'Starting…' });
    try {
      const { job } = await request<{ job: Job }>(`/api/account/studio/projects/${encodeURIComponent(projectId)}/motion`, {});
      for (;;) { await new Promise(done => setTimeout(done, 1000)); if (!alive.current) return;
        const { job: now } = await request<{ job: Job }>(`/api/account/studio/jobs/${job.id}`);
        if (now.status === 'completed') { setBusy(null); setReport(now.result ?? null); return; }
        if (now.status !== 'running') throw new Error(now.error ?? now.status);
        setBusy({ progress: now.progress, note: now.logs.at(-1) ?? '' }); }
    } catch (error) { setBusy(null); notify?.(error instanceof Error ? error.message : String(error), true); }
  };
  const img = (file: string) => `/api/account/studio/motion/${encodeURIComponent(report!.name!)}/${encodeURIComponent(file)}`;
  const score = report?.compare ? Math.round(report.compare.score * 100) : null;
  return <div className="tl-menu motion-check">
    <button disabled={disabled || !!busy} onClick={() => void check()} title="Watches the picture: how alive it is, how moves start and settle, how beats hand off, compared with reference launch videos">
      <Icon name="motionCheck" size={14}/>{busy ? `Watching ${Math.round(busy.progress * 100)}%` : 'Motion check'}</button>
    {busy ? <span className="sound-busy" title={busy.note}>{busy.note}</span> : null}
    {report ? <div className="listen-report" role="dialog" aria-label="What the motion check saw">
      <header><b>What the motion check saw</b>{score !== null ? <span className={`verdict ${score >= 75 ? 'v-launch-grade' : score >= 50 ? 'v-close' : 'v-needs-work'}`}>{score}% in range</span> : null}<button onClick={() => setReport(null)} aria-label="Close" title="Close"><Icon name="close"/></button></header>
      {report.pictures?.timeline && report.name ? <img src={img('timeline.png')} alt="Thumbnails over the motion curve, moves, holds and handoffs" /> : null}
      {report.compare?.text ? <pre>{report.compare.text}</pre> : null}
      {report.handoffs?.filter(h => h.kind !== 'transform' && h.picture).length ? <details><summary>Handoffs to rework</summary>
        {report.handoffs.filter(h => h.kind !== 'transform' && h.picture).map(h => <figure key={h.start}><figcaption>{(h.start + (report.offsetSeconds ?? 0)).toFixed(2)} s · {h.kind}</figcaption><img src={img(h.picture!)} alt={`Filmstrip of the ${h.kind} at ${h.start.toFixed(2)} s`} /></figure>)}</details> : null}
      {report.text ? <details><summary>Every move</summary><pre>{report.text}</pre></details> : null}
    </div> : null}
  </div>;
}

type ReviewReport = { text?: string; name?: string; issues?: { at: number; end: number; kind: string; text: string; severity: number }[]; scenes?: number;
  against?: { in_range: number; of: number; references: string[] } };

/** Review — the whole video as a viewer sees it: scenes with what's on screen, what's said, motion and sound, and where
 *  someone would get lost or bored. Click an issue to jump there. */
export function ReviewVideo({ projectId, disabled, notify, seek }: { projectId: string; disabled: boolean; notify?: (text: string, error?: boolean) => void; seek?: (seconds: number) => void }) {
  const [busy, setBusy] = useState<{ progress: number; note: string } | null>(null), [report, setReport] = useState<ReviewReport | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const go = async () => {
    setBusy({ progress: 0, note: 'Starting…' });
    try {
      const { job } = await request<{ job: Job }>(`/api/account/studio/projects/${encodeURIComponent(projectId)}/review`, {});
      for (;;) { await new Promise(done => setTimeout(done, 1000)); if (!alive.current) return;
        const { job: now } = await request<{ job: Job & { result?: ReviewReport } }>(`/api/account/studio/jobs/${job.id}`);
        if (now.status === 'completed') { setBusy(null); setReport((now.result ?? null) as ReviewReport | null); return; }
        if (now.status !== 'running') throw new Error(now.error ?? now.status);
        setBusy({ progress: now.progress, note: now.logs.at(-1) ?? '' }); }
    } catch (error) { setBusy(null); notify?.(error instanceof Error ? error.message : String(error), true); }
  };
  const img = (file: string) => `/api/account/studio/review/${encodeURIComponent(report!.name!)}/${file}`;
  const n = report?.issues?.length ?? 0;
  return <div className="tl-menu motion-check">
    <button disabled={disabled || !!busy} onClick={() => void go()} title="Watch the whole video like a viewer: scenes, on-screen text, what's said, motion and sound, and where someone gets lost or bored">
      <Icon name="review" size={14}/>{busy ? `Reviewing ${Math.round(busy.progress * 100)}%` : 'Review'}</button>
    {busy ? <span className="sound-busy" title={busy.note}>{busy.note}</span> : null}
    {report ? <div className="listen-report" role="dialog" aria-label="Video review">
      <header><b>Video review</b><span className={`verdict ${n === 0 ? 'v-launch-grade' : n <= 3 ? 'v-close' : 'v-needs-work'}`}>{n === 0 ? 'Nothing flagged' : `${n} to look at`}</span><button onClick={() => setReport(null)} aria-label="Close" title="Close"><Icon name="close"/></button></header>
      {report.issues?.length ? <ul className="review-issues">{report.issues.map((i, k) => <li key={k}><button onClick={() => seek?.(i.at)} title="Jump there">{i.at.toFixed(1)} s</button> <b>{i.kind}</b> {i.text}</li>)}</ul> : null}
      {report.name ? <img src={img('scenes.png')} alt="Every scene: keyframes, timing, how it enters, how alive it is, and its flags" /> : null}
      {report.text ? <details><summary>Scene by scene</summary><pre>{report.text}</pre></details> : null}
    </div> : null}
  </div>;
}
