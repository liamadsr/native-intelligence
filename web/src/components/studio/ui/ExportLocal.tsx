import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { EditorJob } from '@/lib/studio/engine/api';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { isDesktopApp } from '@/lib/platform';
import { studioLocalExport, type StudioExportDestination } from '@/lib/tauri-bridge';
import { Icon } from './icons';
import {
  LOCAL_WORDS, capabilityFor, destinationOf, emptyRunner, foldEvents, localView, readLocalCapability, revealLabel, sizeWords,
  type LocalCapability, type LocalView, type RunnerState,
} from './local-export';

/*
 * The Export dialog's parts for an export on the person's own computer (./local-export.ts): where it will run and be
 * saved, the first-time download, the export while it runs (or waits for this computer), and where it was saved. The
 * Export dialog (./ExportDialog.tsx) places them; styles are its section of studio.css (`xd-local`).
 */

/** What this computer can do, asked of the desktop app once per page and read again after a first-time download. */
let probe: Promise<LocalCapability> | null = null;
export function forgetLocalCapability(): void { probe = null; }
function askCapability(): Promise<LocalCapability> {
  probe ??= readLocalCapability(isDesktopApp() ? studioLocalExport : null);
  return probe;
}

/** The capability for this video (null while the app is asked). */
export function useLocalCapability(project: EditorProject, again = 0): LocalCapability | null {
  const [capability, setCapability] = useState<LocalCapability | null>(null);
  useEffect(() => {
    let alive = true;
    void askCapability().then(found => { if (alive) setCapability(found); });
    return () => { alive = false; };
  }, [again]);
  return capability ? capabilityFor(capability, project) : null;
}

/** The app's events for one export: caught up from what it already said, then live. */
export function useRunner(jobId: string | null): { runner: RunnerState; openedAt: number; now: number } {
  const [runner, setRunner] = useState<RunnerState>(emptyRunner);
  const [openedAt] = useState(() => Date.now());
  const [now, setNow] = useState(openedAt);
  const seq = useRef(-1);
  useEffect(() => {
    if (!jobId || !isDesktopApp()) return;
    let alive = true;
    const take = (events: Parameters<typeof foldEvents>[1]) => { if (!alive) return; setRunner(state => { const next = foldEvents(state, events.filter(e => e.jobId === jobId), Date.now()); seq.current = next.seq; return next; }); };
    const stop = studioLocalExport.onProgress(event => take([event]));
    void studioLocalExport.events(jobId, 0).then(take, () => undefined);
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => { alive = false; stop(); clearInterval(tick); };
  }, [jobId]);
  return { runner, openedAt, now };
}

/**
 * Before Export: where it runs and where it is saved. On this computer: the file it saves to, and Change (the save
 * panel). Not here: why, in one sentence (the export then runs on our server). A first-time download: its size, and
 * the choice of downloading or exporting on our server instead. A browser: nothing (the dialog's own note says where).
 */
export function LocalWhere({ capability, destination, choose, downloading, received, useServer }: {
  capability: LocalCapability | null; destination: StudioExportDestination | null; choose: () => void;
  downloading: boolean; received: { bytes: number; total: number } | null; useServer: () => void;
}) {
  if (!capability || capability.kind === 'browser') return null;
  if (capability.kind === 'unavailable') return <p className="xd-local xd-local-server" role="status"><Icon name="warning" size={16} /><span>{capability.reason}</span></p>;
  if (capability.kind === 'prepare') {
    const percent = received && received.total > 0 ? Math.round(Math.min(1, received.bytes / received.total) * 100) : 0;
    return <div className="xd-local xd-local-prepare" role="group" aria-label="Exporting on this computer">
      <div className="xd-local-text"><strong>Export on this computer</strong>
        <span>{downloading ? 'Downloading what this computer needs to make videos. This happens once.' : `This computer needs a one-time download of ${sizeWords(capability.bytes)} to make videos. After that, exports run here and save where you choose.`}</span></div>
      {downloading ? <><div className="xd-progress" role="progressbar" aria-label="One-time download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${Math.max(2, percent)}%` }} /></div>
        <span className="xd-local-meta">{received ? `${sizeWords(received.bytes)} of ${sizeWords(received.total)}` : 'Starting the download…'}</span></> : null}
      <Button variant="ghost" size="sm" className="st-app-button xd-local-instead" onClick={useServer}>Export on our server instead</Button>
    </div>;
  }
  return <p className="xd-local xd-local-here"><Icon name="saveTo" size={16} />
    <span>Exports on this computer. {destination ? <>Saves to <strong className="xd-file">{destination.name}</strong>.</> : 'You choose where to save it.'}</span>
    <Button variant="ghost" size="sm" className="st-app-button" onClick={choose}>{destination ? 'Change…' : 'Choose…'}</Button></p>;
}

/** The export while it runs on this computer, or waits for it. */
export function LocalRunning({ view, job, actions, platform }: {
  view: Extract<LocalView, { kind: 'rendering' | 'stalled' | 'elsewhere' | 'uploading' | 'failed' }>; job: EditorJob; platform: 'macos' | 'windows' | 'other';
  actions: { cancel: () => void; stopping: boolean; close: () => void; continueHere: () => void; finishOnServer: () => void; exportOnServer: () => void; working: boolean; error: string | null };
}) {
  const destination = destinationOf(job.id);
  const percent = 'progress' in view ? Math.round(Math.max(0, Math.min(1, view.progress)) * 100) : 100;
  const error = actions.error ? <p className="xd-error" role="alert"><Icon name="warning" size={14} /><span>{actions.error}</span></p> : null;
  if (view.kind === 'failed') return <div className="xd-running">
    <div className="xd-banner xd-banner-warn" role="alert"><Icon name="warning" /><div><strong>The export did not finish on this computer</strong><span>{view.message}</span></div></div>
    {error}
    <div className="xd-foot xd-foot-split"><Button variant="ghost" className="st-app-button" onClick={actions.close}>Close</Button><Button className="st-app-button" data-autofocus="" disabled={actions.working} onClick={actions.exportOnServer}>Export on our server instead</Button></div>
  </div>;
  if (view.kind === 'uploading') return <div className="xd-running">
    <SavedHere name={view.savedName ?? destination?.name ?? null} destinationId={destination?.destinationId ?? null} platform={platform} />
    <div className="xd-progress-head"><span className="xd-progress-label" role="status">Uploading for sharing…</span></div>
    <p className="xd-note">You can close this. It is also kept in the Studio for 30 days when the upload is done.</p>
    <div className="xd-foot"><Button variant="secondary" className="st-app-button" data-autofocus="" onClick={actions.close}>Keep editing</Button></div>
  </div>;
  if (view.kind === 'elsewhere') return <div className="xd-running">
    <div className="xd-progress-head"><span className="xd-progress-label" role="status">{actions.stopping ? 'Stopping the export…' : 'Exporting on another computer'}</span><span className="xd-progress-value">{percent}%</span></div>
    <div className={cn('xd-progress', actions.stopping && 'xd-progress-stopping')} role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${Math.max(2, percent)}%` }} /></div>
    <p className="xd-note">{LOCAL_WORDS.elsewhere}</p>
    {error}
    <div className="xd-foot xd-foot-split">
      <Button variant="ghost" className="st-app-button" disabled={actions.stopping || actions.working} onClick={actions.cancel}>Cancel export</Button>
      <Button variant="ghost" className="st-app-button" disabled={actions.stopping || actions.working} onClick={actions.finishOnServer}>Finish on the server</Button>
      <Button variant="secondary" className="st-app-button" data-autofocus="" onClick={actions.close}>Keep editing</Button>
    </div>
  </div>;
  if (view.kind === 'stalled') return <div className="xd-running">
    <div className="xd-banner xd-banner-warn" role="alert"><Icon name="warning" /><div><strong>The export is waiting for this computer</strong><span>{LOCAL_WORDS.stalled} Carry on here, or let our server finish it.</span></div></div>
    {error}
    <div className="xd-foot xd-foot-split"><Button variant="ghost" className="st-app-button" disabled={actions.working} onClick={actions.finishOnServer}>Finish on the server</Button><Button className="st-app-button" data-autofocus="" disabled={actions.working} onClick={actions.continueHere}>Continue on this computer</Button></div>
  </div>;
  return <div className="xd-running">
    <div className="xd-progress-head"><span className="xd-progress-label" role="status">{actions.stopping ? 'Stopping the export…' : view.waiting ? 'Starting on this computer' : 'Exporting on this computer'}</span><span className="xd-progress-value">{percent}%</span></div>
    <div className={cn('xd-progress', actions.stopping && 'xd-progress-stopping')} role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${Math.max(2, percent)}%` }} /></div>
    {destination ? <p className="xd-running-what">Saves to <strong className="xd-file">{destination.name}</strong></p> : null}
    {error}
    <p className="xd-note">You can keep editing. Keep the app open until it is done: if the computer sleeps, the export waits for it.</p>
    <div className="xd-foot xd-foot-split">
      <Button variant="ghost" className="st-app-button" disabled={actions.stopping} onClick={actions.cancel}>Cancel export</Button>
      <Button variant="secondary" className="st-app-button" data-autofocus="" onClick={actions.close}>Keep editing</Button>
    </div>
  </div>;
}

/** "Saved to <name>", with the button that shows the file in Finder or Explorer. */
export function SavedHere({ name, destinationId, platform }: { name: string | null; destinationId: string | null; platform: 'macos' | 'windows' | 'other' }) {
  const [error, setError] = useState<string | null>(null);
  if (!name) return null;
  return <p className="xd-saved xd-saved-here" role="status"><Icon name="check" size={14} /><span>Saved to <strong className="xd-file">{name}</strong></span>
    {destinationId ? <Button size="sm" variant="ghost" className="st-app-button" onClick={() => { setError(null); void studioLocalExport.reveal(destinationId).catch(() => setError('The file could not be shown. It may have been moved.')); }}>{revealLabel(platform)}</Button> : null}
    {error ? <span className="xd-saved-error">{error}</span> : null}</p>;
}

/** A finished export made on this computer: where it was saved, and whether it is also in the Studio. */
export function LocalDone({ view, job, platform }: { view: Extract<LocalView, { kind: 'done' }>; job: EditorJob; platform: 'macos' | 'windows' | 'other' }) {
  const destination = destinationOf(job.id);
  return <>
    <SavedHere name={view.savedName ?? destination?.name ?? null} destinationId={destination?.destinationId ?? null} platform={platform} />
    <p className="xd-note">{view.uploaded ? 'Also in the Studio, kept for 30 days, to share or save again.' : 'Kept on this computer only: nothing was uploaded.'}</p>
  </>;
}

/** The platform for "Show in Finder" and "Show in Explorer". */
export const platformOf = (capability: LocalCapability | null): 'macos' | 'windows' | 'other' => capability?.kind === 'ready' ? capability.platform : /Windows/i.test(typeof navigator === 'undefined' ? '' : navigator.userAgent) ? 'windows' : /Mac/i.test(typeof navigator === 'undefined' ? '' : navigator.userAgent) ? 'macos' : 'other';
export { localView };
