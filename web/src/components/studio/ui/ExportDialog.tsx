import React, { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { EditorJob } from '@/lib/studio/engine/api';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import { exportPresets } from '@/lib/studio/engine/formats';
import { request } from './client';
import { Modal, StudioSelect } from './controls';
import { Icon } from './icons';
import { studioWorkspaceId } from '../studio-env';
import { exportFileName, saveExport, saveWay, type SaveResult, type SaveWay } from './save-export';

/*
 * The Export dialog: what will be made and how big, then the render's progress, then the finished video and a way to
 * put it on the computer.
 *
 * Setting up leads with what the export makes (an MP4: its size, frame rate, length, codec, shape), then the one
 * choice that changes it (the resolution), then the other formats (each one makes a new video, reframed, which opens
 * when it is made), and says where the video goes before the person presses Export. The video is rendered on the
 * server and kept there for 30 days; from the finished state the person saves a copy where they choose
 * (./save-export.ts). Styles: the "Export dialog" section of studio.css (`xd-`).
 */

/** What the editor knows about the export it started (the job alone does not carry the title or size). */
export type ExportReceipt = { jobId: string; projectId: string; title: string; width: number; height: number; fps: number; durationFrames: number };

/**
 * Which of the editor's export job is this video's. The editor keeps one export job whichever video is open; the
 * dialog shows its progress or its result only on the video it was made from (the job names it; an unsaved draft's
 * export is known by the receipt the editor took when it started it). Another video's export still rendering is
 * said in one line instead.
 */
export function exportFor(job: EditorJob | null, receipt: ExportReceipt | null, projectId: string): { job: EditorJob | null; other: { title: string | null; progress: number } | null } {
  if (!job || job.kind !== 'export') return { job: null, other: null };
  const videoId = job.videoId ?? (receipt?.jobId === job.id ? receipt.projectId : null);
  if (videoId === projectId) return { job, other: null };
  return { job: null, other: job.status === 'running' ? { title: receipt?.jobId === job.id ? receipt.title : null, progress: job.progress } : null };
}
type Props = {
  project: EditorProject;
  /** This video's export job (exportFor), or null. */
  job: EditorJob | null;
  /** What arriving to download this export said (./export-arrival.ts): shown at the top. */
  notice?: { tone: 'ok' | 'warn'; text: string } | null;
  /** Another video's export still rendering (exportFor). */
  otherExport?: { title: string | null; progress: number } | null;
  receipt: ExportReceipt | null;
  /** 'native' or '1080'. */
  size: string;
  setSize: (size: string) => void;
  /** The size the export will have with the chosen resolution. */
  output: { width: number; height: number };
  /** The edit's length, in frames at its fps. */
  durationFrames: number;
  /** Something else is going on in the editor (saving, opening): Export waits. */
  busy: boolean;
  start: () => void;
  /** Ask the running export to stop; false when the request failed (the dialog says so). */
  cancel: () => Promise<boolean>;
  close: () => void;
  /** Save the edit before the server makes a format from it; false when the save failed. */
  beforeServerEdit: () => Promise<boolean>;
  /** Open a video the dialog made (another format). */
  openVideo: (projectId: string) => void;
  say: (text: string, error?: boolean) => void;
};

const clock = (seconds: number) => { const s = Math.max(0, Math.round(seconds)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const megabytes = (bytes: unknown) => { const n = Number(bytes); return Number.isFinite(n) && n > 0 ? `${n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : Math.max(0.1, Math.round(n / 1e5) / 10) + ' MB'}` : null; };
const ratio = (w: number, h: number) => { const g = (a: number, b: number): number => b ? g(b, a % b) : a, d = g(w, h); const r = `${w / d}:${h / d}`; return ['16:9', '9:16', '4:5', '1:1', '4:3', '3:4'].includes(r) ? r : (w / h).toFixed(2).replace(/\.?0+$/, '') + ':1'; };
/** An outline of a shape, `w` by `h`, fitted in a `box` px square. */
const Shape = ({ w, h, box = 16 }: { w: number; h: number; box?: number }) => { const s = box / Math.max(w, h); return <span className="xd-shape-box" style={{ width: box, height: box }} aria-hidden="true"><span className="xd-shape" style={{ width: Math.max(4, Math.round(w * s)), height: Math.max(4, Math.round(h * s)) }} /></span>; };

/** Where the video goes, in words, for this page's way of saving (the desktop app's depends on the size, not known yet). */
function whereItGoes(): string {
  const way = saveWay();
  return way === 'downloads' ? 'When it is ready, you download it here. Your browser puts it in its downloads folder. We keep it for 30 days.'
    : way === 'picker' ? 'When it is ready, you choose where to save it on your computer. We keep it for 30 days.'
    : 'When it is ready, you save it to your computer from here. We keep it for 30 days.';
}
/** What saving does, said before the person presses Save, for the way this file goes. */
function howItSaves(way: SaveWay): string {
  return way === 'downloads' ? 'Your browser saves it to its downloads folder, unless you set it to ask where.'
    : way === 'desktop' ? 'You pick the folder and the name.'
    : way === 'desktop-browser' ? 'It is too large to save from the app. Your browser opens the Studio and downloads it; you may need to sign in there once.'
    : 'You pick the folder and the name.';
}

/** A finished export, as `GET projects/:id/exports` lists them (lib/studio/server/jobs.ts videoExports). */
type FinishedExport = EditorJob & { title: string; finishedAt: string; /** Its file is still within the 30 days it is kept (worked out as it is read). */ kept?: boolean };

export function ExportDialog(props: Props) {
  const job = props.job?.kind === 'export' ? props.job : null;
  // "Export again" from the finished state shows the setup until the next export starts.
  const [again, setAgain] = useState(false);
  useEffect(() => setAgain(false), [job?.id]);
  // This video's finished exports, from the server: they stay reachable after the dialog closes, another export
  // starts, fails or is cancelled, and after a reload. Read again whenever an export ends.
  const [finished, setFinished] = useState<FinishedExport[] | null>(null), [listError, setListError] = useState(false), [reads, setReads] = useState(0);
  useEffect(() => {
    let alive = true;
    void request<{ exports: FinishedExport[] }>(`/api/account/studio/projects/${encodeURIComponent(props.project.id)}/exports`)
      .then(answer => { if (!alive) return; const now = Date.now(); setFinished((answer.exports ?? []).map(item => ({ ...item, kept: Date.parse(item.finishedAt) > now - KEPT_MS }))); setListError(false); })
      .catch(() => { if (alive) setListError(true); });
    return () => { alive = false; };
  }, [props.project.id, job?.id, job?.status, reads]);
  const view = job?.status === 'running' ? 'running' : job?.status === 'completed' && !again ? 'done' : 'setup';
  // The finished export the dialog is showing is not listed again under it.
  const others = (finished ?? []).filter(item => view !== 'done' || item.id !== job?.id);
  const list = listError ? <p className="xd-error xd-list-error" role="alert"><Icon name="warning" size={14} /><span>Your finished exports could not be loaded.</span><Button size="sm" variant="ghost" className="st-app-button" onClick={() => setReads(n => n + 1)}>Try again</Button></p>
    : others.length ? <FinishedList items={others} projectId={props.project.id} heading={view === 'done' ? 'Earlier exports' : 'Ready to save'} /> : null;
  const ended = !again && (job?.status === 'failed' || job?.status === 'cancelled') ? job : null;
  return <Modal title="Export video" description={<>“{props.project.title || 'Untitled video'}”</>} close={props.close} className="xd-dialog">
    {props.notice ? <p className={cn('xd-notice', props.notice.tone === 'ok' ? 'xd-saved' : 'xd-error')} role="status"><Icon name={props.notice.tone === 'ok' ? 'check' : 'warning'} size={14} /><span>{props.notice.text}</span></p> : null}
    {view === 'running' && job ? <Running {...props} job={job} list={list} /> : view === 'done' && job ? <Done {...props} job={job} list={list} again={() => setAgain(true)} /> : <Setup {...props} ended={ended} list={list} />}
  </Modal>;
}

/** Saving one finished export onto the computer: the button, then where it went (or why it did not). */
function SaveExport({ job, title, projectId, big }: { job: EditorJob; title: string; projectId: string; big?: boolean }) {
  const url = job.downloadUrl!, bytes = Number((job.result as { bytes?: unknown } | undefined)?.bytes) || null, way = saveWay(bytes);
  const [saving, setSaving] = useState(false), [saved, setSaved] = useState<SaveResult | null>(null), [error, setError] = useState<string | null>(null);
  const save = () => {
    if (saving) return;
    setSaving(true); setError(null);
    // Straight from the click: the browser's save picker opens only from one.
    void saveExport({ url, fileName: exportFileName(url, title), bytes, arrival: { videoId: job.videoId ?? projectId, jobId: job.id, workspaceId: studioWorkspaceId() } }).then(answer => { if (answer.kind !== 'cancelled') setSaved(answer); })
      .catch(cause => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setSaving(false));
  };
  const label = saving ? (way === 'desktop' ? 'Getting the video…' : way === 'desktop-browser' ? 'Opening your browser…' : 'Saving…')
    : way === 'downloads' ? (big ? 'Download MP4' : 'Download') : way === 'desktop-browser' ? (big ? 'Open in your browser to download' : 'Open in browser…')
    : big ? (saved ? 'Save another copy…' : 'Save to your computer…') : 'Save…';
  const said = saved ? <p className="xd-saved" role="status"><Icon name="check" size={14} /><span>{saved.kind === 'saved' ? (way === 'desktop' ? <>Saved to <code>{saved.where}</code></> : <>Saved as <code>{saved.where}</code> in the folder you chose.</>)
    : saved.kind === 'downloads' ? <>Sent to your browser’s downloads folder as <code>{saved.name}</code>.</>
    : saved.kind === 'browser' ? <>Opened in your browser. The download starts there, in its downloads folder, once you are signed in.</> : null}</span></p> : null;
  const failed = error ? <p className="xd-error" role="alert"><Icon name="warning" size={14} /><span>{error}</span></p> : null;
  const icon = way === 'downloads' || way === 'desktop-browser' ? 'download' : 'saveTo';
  return big
    ? <><Button size="lg" className="st-app-button xd-save" data-autofocus="" disabled={saving} onClick={save}><Icon name={icon} />{label}</Button>{said}{failed}<p className="xd-note">{howItSaves(way)} We keep the video for 30 days, so you can save another copy until then.</p></>
    : <><Button size="sm" variant="outline" className="st-app-button xd-row-save" disabled={saving} onClick={save} title={howItSaves(way)}><Icon name={icon} />{label}</Button>{said || failed ? <div className="xd-row-said">{said}{failed}</div> : null}</>;
}

/** What a finished export is: size, length, file size. */
function exportFacts(job: EditorJob, receipt?: ExportReceipt | null): string[] {
  const result = (job.result ?? {}) as Record<string, unknown>;
  const width = receipt?.width ?? Number(result.width), height = receipt?.height ?? Number(result.height);
  const seconds = receipt ? receipt.durationFrames / receipt.fps : Number(result.durationSeconds);
  return [width > 0 && height > 0 ? `${width} × ${height}` : null, Number.isFinite(seconds) && seconds > 0 ? clock(seconds) : null, megabytes(result.bytes)].filter(Boolean) as string[];
}
/** How long an export's file is kept (lib/studio/server/sweep.ts). */
const KEPT_MS = 30 * 24 * 3600 * 1000;
const when = (iso: string) => { const at = new Date(iso); return Number.isNaN(at.getTime()) ? '' : at.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };

/** This video's finished exports, newest first, each with Save. */
function FinishedList({ items, projectId, heading }: { items: FinishedExport[]; projectId: string; heading: string }) {
  return <section className="xd-finished" aria-label={heading}>
    <h3 className="xd-section">{heading}<span>Kept for 30 days</span></h3>
    <ul>{items.map(item => <li key={item.id}>
      <span className="xd-row-icon" aria-hidden="true"><Icon name="clip" size={16} /></span>
      <div className="xd-row-text"><span className="xd-row-title">{item.title}</span><span className="xd-facts">{[when(item.finishedAt), ...exportFacts(item)].filter(Boolean).map(fact => <span key={fact}>{fact}</span>)}</span></div>
      {item.downloadUrl && item.kept !== false ? <SaveExport job={item} title={item.title} projectId={projectId} /> : <span className="xd-row-gone">No longer kept</span>}
    </li>)}</ul>
  </section>;
}

function Setup(props: Props & { ended: EditorJob | null; list: React.ReactNode }) {
  const { project, output } = props, fps = project.output.fps, seconds = props.durationFrames / fps;
  const native = props.size === 'native', resolutionId = React.useId();
  return <div className="xd-setup">
    {props.ended ? <div className="xd-banner xd-banner-warn" role="alert"><Icon name="warning" /><div><strong>{props.ended.status === 'cancelled' ? 'The export was cancelled' : 'The export did not finish'}</strong><span>{props.ended.status === 'cancelled' ? 'Nothing new was made. Your finished exports are still here.' : props.ended.error ?? 'Something went wrong while rendering. Try again.'}</span></div></div> : null}
    {props.otherExport ? <p className="xd-other" role="status"><Icon name="export" size={14} /><span>{props.otherExport.title ? `“${props.otherExport.title}”` : 'Another video'} is exporting ({Math.round(Math.max(0, Math.min(1, props.otherExport.progress)) * 100)}%). You can export this one too.</span></p> : null}
    {props.list}
    <div className="xd-product" aria-label="What the export makes">
      <span className="xd-product-icon" aria-hidden="true"><Icon name="clip" size={20} /></span>
      <div className="xd-product-text">
        <span className="xd-product-kind">MP4 video</span>
        <span className="xd-product-size">{output.width} × {output.height}</span>
        <span className="xd-facts"><span>{fps} fps</span><span>{clock(seconds)}</span><span>H.264</span></span>
      </div>
      <span className="xd-product-shape" title={`Shape ${ratio(output.width, output.height)}`}><Shape w={output.width} h={output.height} box={28} />{ratio(output.width, output.height)}</span>
    </div>

    <div className="xd-field">
      <div className="xd-field-text"><span className="xd-field-name" id={resolutionId}>Resolution</span><span className="xd-field-help">{native ? 'The size you edited at.' : 'Smaller file, same shape.'} The shape of the video stays as it is.</span></div>
      <StudioSelect size="normal" aria-labelledby={resolutionId} value={props.size} onChange={props.setSize} className="xd-select">
        <option value="native">Original · {project.output.width} × {project.output.height}</option>
        <option value="1080">1080p · {Math.max(64, Math.round(project.output.width * Math.min(1080, project.output.height) / project.output.height / 2) * 2)} × {Math.min(1080, project.output.height)}</option>
      </StudioSelect>
    </div>

    <OtherFormats {...props} />

    <p className="xd-where"><Icon name="saveTo" size={16} /><span>{whereItGoes()}</span></p>
    <div className="xd-foot">
      <Button variant="ghost" className="st-app-button" onClick={props.close}>Cancel</Button>
      <Button className="st-app-button" data-autofocus="" disabled={props.busy} onClick={props.start}><Icon name="export" />Export MP4</Button>
    </div>
  </div>;
}

/** The other formats: each one is made into a new video of its own, reframed for that shape, and opened. */
function OtherFormats({ project, beforeServerEdit, openVideo, say }: Props) {
  const [presets, setPresets] = useState<{ id: string; label: string }[]>([]), [making, setMaking] = useState<string | null>(null);
  useEffect(() => { void request<{ presets: { id: string; label: string }[] }>('/api/account/studio/formats').then(r => setPresets(r.presets ?? [])).catch(() => setPresets([])); }, []);
  const make = async (id: string) => {
    if (!await beforeServerEdit()) return;
    setMaking(id);
    try {
      const out = await request<{ projectId: string; warnings: string[] }>(`/api/account/studio/projects/${encodeURIComponent(project.id)}/formats`, { preset: id });
      const notes = out.warnings.filter(w => !/check the length/.test(w));
      say(notes.length ? `Made the version. Before posting: ${notes.join(' · ')}` : 'Made the version. It opens now.', notes.length > 0);
      openVideo(out.projectId);
    } catch (error) { say(error instanceof Error ? error.message : String(error), true); }
    finally { setMaking(null); }
  };
  if (!presets.length) return null;
  return <details className="xd-formats">
    <summary><span className="xd-formats-title">Other formats</span><span className="xd-formats-help">Each one becomes its own video, reframed for that shape. It opens when it is made.</span><Icon name="chevron" /></summary>
    <div className="xd-format-grid" role="group" aria-label="Make a video in another format">
      {presets.map(preset => {
        const known = exportPresets.find(p => p.id === preset.id), name = preset.label.replace(/\s*\(.*\)$/, ''), shape = known ? ratio(known.width, known.height) : (/\(([^)]+)\)/.exec(preset.label)?.[1] ?? '');
        return <button type="button" key={preset.id} className={cn('xd-format', making === preset.id && 'xd-format-busy')} disabled={!!making} onClick={() => void make(preset.id)}>
          {known ? <Shape w={known.width} h={known.height} /> : null}<span className="xd-format-name">{making === preset.id ? 'Making…' : name}</span><span className="xd-format-ratio">{shape}</span>
        </button>;
      })}
    </div>
  </details>;
}

function Running({ job, receipt, cancel, close, list }: Props & { job: EditorJob; list: React.ReactNode }) {
  const percent = Math.round(Math.max(0, Math.min(1, job.progress)) * 100), mine = receipt?.jobId === job.id ? receipt : null;
  // Asked to stop: the worker stops at its next step, which takes a moment; until then it says so.
  const [stopping, setStopping] = useState(false), [stopFailed, setStopFailed] = useState(false);
  const stop = () => { setStopping(true); setStopFailed(false); void cancel().then(asked => { if (!asked) { setStopping(false); setStopFailed(true); } }); };
  return <div className="xd-running">
    <div className="xd-progress-head"><span className="xd-progress-label" role="status">{stopping ? 'Stopping the export…' : percent ? 'Rendering your video' : 'Starting the render'}</span><span className="xd-progress-value">{percent}%</span></div>
    <div className={cn('xd-progress', stopping && 'xd-progress-stopping')} role="progressbar" aria-label="Export progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: `${Math.max(2, percent)}%` }} /></div>
    {stopFailed ? <p className="xd-error" role="alert"><Icon name="warning" size={14} /><span>The export could not be stopped. It is still rendering. Try again.</span></p> : null}
    <p className="xd-running-what">{mine ? <>An MP4 video · {mine.width} × {mine.height} · {clock(mine.durationFrames / mine.fps)}</> : 'An MP4 video of your saved edit'}</p>
    <p className="xd-note">You can close this and keep editing. The Export button shows how far it is. If you leave the Studio before it is done, you get a note in For you.</p>
    <p className="xd-where"><Icon name="saveTo" size={16} /><span>{whereItGoes()}</span></p>
    {list}
    <div className="xd-foot xd-foot-split">
      <Button variant="ghost" className="st-app-button" disabled={stopping} onClick={stop}>Cancel export</Button>
      <Button variant="secondary" className="st-app-button" data-autofocus="" onClick={close}>Keep editing</Button>
    </div>
  </div>;
}

function Done(props: Props & { job: EditorJob; again: () => void; list: React.ReactNode }) {
  const { job, receipt, close, again, list } = props;
  const mine = receipt?.jobId === job.id ? receipt : null, result = (job.result ?? {}) as Record<string, unknown>;
  const facts = exportFacts(job, mine), title = mine?.title ?? (typeof result.title === 'string' ? result.title : 'video');
  return <div className="xd-done">
    <div className="xd-done-head">
      <span className="xd-done-icon" aria-hidden="true"><Icon name="done" size={22} /></span>
      <div><strong>{mine ? 'Your video is ready' : 'Your last export is ready'}</strong>{mine ? null : <span>The video from your last export.</span>}{facts.length ? <span className="xd-facts">{facts.map(fact => <span key={fact}>{fact}</span>)}</span> : null}</div>
    </div>
    {job.downloadUrl ? <SaveExport job={job} title={title} projectId={props.project.id} big /> : <p className="xd-note">This export’s file is no longer kept. Exports are kept for 30 days. Export the video again.</p>}
    {list}
    <div className="xd-foot xd-foot-split">
      <Button variant="ghost" className="st-app-button" onClick={again}>Change settings and export again</Button>
      <Button variant="secondary" className="st-app-button" onClick={close}>Done</Button>
    </div>
  </div>;
}
