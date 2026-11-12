// Transcribing recordings in the editor. Transcription is a server job (POST /transcripts/transcribe queues a
// `transcribe` job for the Studio worker; the server files its transcript). The server queues at most one job per
// asset and none after a recording was found to hold no speech or no audio, unless the person asks again (retry).
// This hook keeps one task per request, follows its job, and attaches the transcript to the edit it was asked for
// once nothing is being edited (transcription-target.ts checks the edit still has that source).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorAsset, EditorProject, EditorTranscript } from '@/lib/studio/engine/contracts';
import type { EditorJob, LocalTranscriptionInfo } from '@/lib/studio/engine/api';
import { STUDIO_API } from '../studio-env';
import { request } from './client';
import { successfulTranscript, transcriptionJobPhase, settleCancelledStart } from './transcription-jobs';
import { attachTranscription, transcriptionTarget, transcriptionTargetStillPresent, type TranscriptionTarget } from './transcription-target';

export type TranscriptionTask = {
  id: string;
  asset: EditorAsset;
  target: TranscriptionTarget;
  job?: EditorJob;
  state: 'queued' | 'starting' | 'running' | 'finished' | 'failed' | 'cancelled';
  /** The person asked again after a failure or an empty result. */
  retry?: boolean;
  error?: string;
  attachment?: 'pending' | 'attempted' | 'held';
  reason?: string;
};

/** Who transcribes an asset. */
export type Transcriber = 'server' | 'desktop';

/**
 * Who transcribes this asset: the seam for the desktop app's on-device speech model. Today every asset is
 * transcribed by the server job. The desktop app transcribes its own new recordings on the device (wired
 * elsewhere); when it can also transcribe an imported file, answer 'desktop' here for the assets it should take
 * (for instance when the editor runs inside the desktop app and the file is local to it) and hand them to it in
 * `start` instead of queueing a server job.
 */
export function transcriberFor(asset: EditorAsset): Transcriber {
  void asset;
  return 'server';
}

/** What the server answers a transcription request. */
type TranscribeAnswer = { job: EditorJob } | { transcript: EditorTranscript } | { outcome: 'no-speech' | 'no-audio' };

/** Transcription is always ready: there is nothing to set up (GET /transcription/config answers the same). */
const READY: LocalTranscriptionInfo = { config: null, ready: true, serviceFee: 0 };

const PENDING: TranscriptionTask['state'][] = ['queued', 'starting', 'running'];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** A finished job standing for an answer that queued nothing (a transcript already there, or nothing to hear). */
function settledJob(asset: EditorAsset, answer: Exclude<TranscribeAnswer, { job: EditorJob }>): EditorJob {
  const base: EditorJob = { id: `settled-${asset.id}`, kind: 'transcribe', status: 'completed', progress: 1, logs: [], assetId: asset.id, sourceSha256: asset.sha256 };
  return 'transcript' in answer ? { ...base, outcome: 'transcribed', transcript: answer.transcript } : { ...base, outcome: answer.outcome };
}

export function useTranscription({ readProject, change, editing, notify }: { readProject: () => EditorProject | undefined; change: (fn: (p: EditorProject) => EditorProject) => void; editing: () => boolean; notify: (text: string, error?: boolean) => void }) {
  const [tasks, setTasks] = useState<TranscriptionTask[]>([]);
  const tasksRef = useRef(tasks), launching = useRef(false), cancelled = useRef(new Set<string>());
  useEffect(() => { tasksRef.current = tasks; }, [tasks]);
  const update = useCallback((id: string, patch: (task: TranscriptionTask) => Partial<TranscriptionTask>) => setTasks(all => all.map(t => t.id === id ? { ...t, ...patch(t) } : t)), []);

  /** Ask for a transcript of an asset in the open edit (or in `target`). `retry`: the person asked again. */
  const start = useCallback((asset: EditorAsset, target?: TranscriptionTarget, options: { retry?: boolean } = {}) => {
    const project = readProject(); if (!project && !target) return;
    if (!asset.hasAudio) { notify('This recording has no audio to transcribe.'); return; }
    if (transcriberFor(asset) !== 'server') return;
    let intended: TranscriptionTarget;
    try { intended = target ?? transcriptionTarget(project!, asset.id); } catch (error) { notify(message(error), true); return; }
    if (tasksRef.current.some(t => t.asset.id === asset.id && t.target.projectId === intended.projectId && PENDING.includes(t.state))) return;
    const task: TranscriptionTask = { id: crypto.randomUUID(), asset, target: intended, state: 'queued', ...(options.retry ? { retry: true } : {}) };
    tasksRef.current = [...tasksRef.current, task];
    setTasks(current => [...current, task]);
  }, [notify, readProject]);

  // Start the next queued task: one request at a time.
  useEffect(() => {
    if (launching.current || tasks.some(t => t.state === 'starting')) return;
    const next = tasks.find(t => t.state === 'queued'); if (!next) return;
    if (!transcriptionTargetStillPresent(readProject(), next.target)) {
      update(next.id, () => ({ state: 'cancelled', reason: 'The edit changed before transcription started. Select the recording again to transcribe it.' }));
      return;
    }
    launching.current = true;
    update(next.id, () => ({ state: 'starting' }));
    void (async () => {
      try {
        const answer = await request<TranscribeAnswer>(`${STUDIO_API}/transcripts/transcribe`, { assetId: next.asset.id, ...(next.retry ? { retry: true } : {}) });
        const job = 'job' in answer ? answer.job : settledJob(next.asset, answer);
        if (cancelled.current.has(next.id) && job.status === 'running') {
          const stopped = await settleCancelledStart(job, id => request<{ job: EditorJob }>(`${STUDIO_API}/jobs/${id}/cancel`, {}));
          update(next.id, () => stopped);
          return;
        }
        update(next.id, () => ({ job, state: transcriptionJobPhase(job), attachment: successfulTranscript(job) ? 'pending' : undefined }));
      } catch (error) {
        const stopped = cancelled.current.has(next.id);
        update(next.id, () => ({ state: stopped ? 'cancelled' : 'failed', error: stopped ? undefined : message(error) }));
        if (!stopped) notify(message(error), true);
      } finally { launching.current = false; }
    })();
  }, [tasks, notify, readProject, update]);

  // Follow running jobs.
  useEffect(() => {
    const running = tasks.filter(t => t.state === 'running' && t.job); if (!running.length) return;
    let alive = true;
    const timer = setTimeout(() => {
      void Promise.all(running.map(async t => {
        try {
          const { job } = await request<{ job: EditorJob }>(`${STUDIO_API}/jobs/${t.job!.id}`);
          if (alive) update(t.id, () => ({ job, state: transcriptionJobPhase(job), attachment: successfulTranscript(job) && !cancelled.current.has(t.id) ? 'pending' : undefined, error: undefined }));
        } catch (error) {
          if (alive) update(t.id, () => ({ error: `Status unavailable: ${message(error)}` }));
        }
      }));
    }, 750);
    return () => { alive = false; clearTimeout(timer); };
  }, [tasks, update]);

  // Attach finished transcripts once nothing is being edited.
  useEffect(() => {
    if (!tasks.some(t => t.attachment === 'pending')) return;
    const timer = setInterval(() => {
      if (editing()) return; const project = readProject(); if (!project) return;
      for (const task of tasksRef.current.filter(t => t.attachment === 'pending' && successfulTranscript(t.job))) {
        try {
          const attempt = attachTranscription(project, task.target, task.job!.transcript!);
          if (!attempt.reason) change(p => attachTranscription(p, task.target, task.job!.transcript!).project);
          update(task.id, () => ({ attachment: attempt.reason ? 'held' : 'attempted', reason: attempt.reason }));
        } catch (error) { update(task.id, () => ({ attachment: 'held', reason: message(error) })); }
      }
    }, 250);
    return () => clearInterval(timer);
  }, [tasks, change, editing, readProject, update]);

  const cancel = async (task: TranscriptionTask) => {
    cancelled.current.add(task.id);
    if (!task.job) { update(task.id, () => ({ state: 'cancelled' })); return; }
    try {
      const { job } = await request<{ job: EditorJob }>(`${STUDIO_API}/jobs/${task.job.id}/cancel`, {});
      update(task.id, () => ({ job, state: transcriptionJobPhase(job) }));
    } catch (error) { notify(message(error), true); }
  };

  /** Ask again after a failure, a cancel or an empty result: the server queues a new job even after "no speech". */
  const retry = (asset: EditorAsset) => start(asset, undefined, { retry: true });

  /** Attach a held result to the source as it is in the open edit now. */
  const attach = async (task: TranscriptionTask) => {
    const project = readProject(); if (!project || !successfulTranscript(task.job)) return;
    try {
      const target = transcriptionTarget(project, task.asset.id);
      if (editing()) throw new Error('Finish the current edit before attaching the transcript.');
      const attempt = attachTranscription(project, target, task.job!.transcript!);
      if (attempt.reason) throw new Error(attempt.reason);
      change(p => attachTranscription(p, target, task.job!.transcript!).project);
      update(task.id, () => ({ target, attachment: 'attempted', reason: undefined }));
    } catch (error) { notify(message(error), true); }
  };

  /** Pick up a transcription job still running when the editor opened. */
  const restore = (job: EditorJob, project: EditorProject, assets: EditorAsset[]) => {
    if (job.kind !== 'transcribe') return;
    const asset = assets.find(a => a.id === job.assetId); if (!asset) return;
    const target: TranscriptionTarget = { projectId: project.id, assetId: asset.id, sourceSha256: asset.sha256, clipIds: [], segmentIds: [], corrections: '[]' };
    setTasks(all => all.some(t => t.job?.id === job.id) ? all : [...all, { id: crypto.randomUUID(), asset, target, job, state: transcriptionJobPhase(job), attachment: successfulTranscript(job) ? 'held' : undefined, reason: 'This transcription started before the editor opened. Attach its result to the recording.' }]);
  };

  /** Point a pending or finished task of an asset at the edit as it is now (after a new edit was made from it). */
  const retarget = (asset: EditorAsset, project: EditorProject) => {
    const existing = tasksRef.current.filter(t => t.asset.id === asset.id && t.asset.sha256 === asset.sha256 && (PENDING.includes(t.state) || successfulTranscript(t.job)));
    if (!existing.length) return false;
    const target = transcriptionTarget(project, asset.id);
    setTasks(all => all.map(t => existing.some(v => v.id === t.id) ? { ...t, target, attachment: successfulTranscript(t.job) ? 'pending' : t.attachment, reason: undefined } : t));
    return true;
  };

  return { info: READY, tasks, start, retry, cancel, attach, restore, retarget };
}
export type TranscriptionController = ReturnType<typeof useTranscription>;
