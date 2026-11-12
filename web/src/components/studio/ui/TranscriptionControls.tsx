// The Transcript tab's transcription block: what is happening to the selected recording's transcript, and the one
// button that moves it on (transcribe, cancel while it runs, try again after a failure or an empty result).
// Transcription runs on the server (useTranscription.ts); there is nothing to set up here.
import React from 'react';
import type { EditorProject } from '@/lib/studio/engine/contracts';
import type { TranscriptionController, TranscriptionTask } from './useTranscription';
import { successfulTranscript } from './transcription-jobs';

type Status = { text: string; tone?: 'warning' };

/** The status line for a recording: its newest task in this edit, else whether it already has word timing. */
function statusOf(task: TranscriptionTask | undefined, hasAudio: boolean, attached: boolean): Status {
  if (!hasAudio) return { text: 'This recording has no audio to transcribe.' };
  const job = task?.job;
  if (task && (task.state === 'queued' || task.state === 'starting')) return { text: 'Starting transcription…' };
  if (task?.state === 'running') return { text: job?.logs.at(-1) && job.logs.at(-1) !== 'Waiting for the Studio worker…' ? `Transcribing… ${job.logs.at(-1)}` : job?.progress ? 'Transcribing…' : 'Waiting for the transcriber…' };
  if (task?.state === 'failed' || job?.status === 'failed') return { text: `Transcription failed: ${task?.error ?? job?.error ?? 'try again.'}`, tone: 'warning' };
  if (task?.state === 'cancelled' || job?.status === 'cancelled') return { text: task?.reason ?? 'Transcription stopped before it finished.' };
  if (job?.outcome === 'no-speech') return { text: 'No speech was found in this recording.' };
  if (job?.outcome === 'no-audio') return { text: 'This recording has no audio track, so there is nothing to transcribe.' };
  if (attached) return { text: 'Word timing is attached to this edit.' };
  if (successfulTranscript(job)) return { text: task?.reason ?? 'The transcript is ready to attach.' };
  return { text: 'Transcribe this recording to edit it by its words.' };
}

export function TranscriptionControls({ controller, project, source, busy }: { controller: TranscriptionController; project: EditorProject; source: string; busy: boolean }) {
  const asset = project.assets.find(a => a.id === source);
  const task = asset ? [...controller.tasks].reverse().find(t => t.asset.id === asset.id && t.target.projectId === project.id) : undefined;
  const job = task?.job;
  const attached = !!asset && project.transcripts.some(t => t.assetId === asset.id && t.sourceSha256 === asset.sha256);
  const status = statusOf(task, !!asset?.hasAudio, attached);
  const pending = !!task && ['queued', 'starting', 'running'].includes(task.state);
  const ended = !!task && !pending && (task.state === 'failed' || task.state === 'cancelled' || job?.status === 'failed' || job?.status === 'cancelled' || job?.outcome === 'no-speech' || job?.outcome === 'no-audio');
  const canAttach = !!asset && successfulTranscript(job) && !project.transcripts.some(t => t.id === job!.transcript!.id) && task?.attachment !== 'pending';

  return <section className="local-transcription transcription-controls" aria-label="Transcription">
    <h3>Transcription</h3>
    <p className={status.tone === 'warning' ? 'inline-warning' : 'hint'} role="status">{status.text}</p>
    {task?.state === 'running' ? <progress className="transcription-progress" aria-label={`Transcription progress for ${task.asset.name}`} value={job?.progress ?? 0} max={1} /> : null}
    {!asset ? <p className="hint">Select a clip to transcribe its recording.</p>
      : pending ? <button className="full-button" onClick={() => void controller.cancel(task!)}>Cancel transcription</button>
      : ended ? <button className="full-button" disabled={busy || !asset.hasAudio} onClick={() => controller.retry(asset)}>Try again</button>
      : attached ? null
      : <button className="full-button" disabled={busy || !asset.hasAudio} onClick={() => controller.start(asset)}>Transcribe this recording</button>}
    {canAttach ? <button className="full-button" disabled={busy} onClick={() => void controller.attach(task!)}>Attach the transcript to this recording</button> : null}
  </section>;
}
