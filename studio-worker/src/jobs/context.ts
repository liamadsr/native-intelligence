/**
 * What a job handler is given: its job, a scratch folder of its own (removed
 * afterwards, whatever happens), the app, the asset cache, a signal that aborts
 * when the job is cancelled or the worker stops, and a way to say how far along
 * it is. Handlers never talk to the job routes themselves: the runner
 * (../runner.ts) reports, heartbeats, completes and fails.
 */
import type { AppClient } from '../app-client.ts'
import type { AssetCache } from '../cache.ts'
import type { WorkerConfig } from '../config.ts'
import type { Renderer } from '../render.ts'
import type { ClaimedJob, StudioJobIO, StudioJobKind } from '../../../web/src/lib/studio/server/job-contract.ts'

export interface JobContext<K extends StudioJobKind = StudioJobKind> {
  job: ClaimedJob<K>
  config: WorkerConfig
  client: AppClient
  cache: AssetCache
  renderer: Renderer
  /** The job's own folder, empty at the start, removed at the end. */
  scratch: string
  /** Aborts when the job is cancelled or the worker stops: every child process and render listens to it. */
  signal: AbortSignal
  /** How far along (0 to 1); sent at most every few seconds, and at least every 15 s by the heartbeat. */
  progress(fraction: number): void
  /** A line for the job's log (sent with the next progress report) and the worker's own. */
  log(line: string): void
}

export type JobHandler<K extends StudioJobKind> = (ctx: JobContext<K>) => Promise<StudioJobIO[K]['result']>

/** An error whose message is meant for the person, as it is. */
export class JobError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'JobError'
  }
}

/**
 * A spend that may have been charged though nothing came back to show for it (a provider call that failed or timed
 * out half way). Its sentence says to look in the provider's account and never asks to try again: the runner reports
 * it as it is, even when the job was stopped meanwhile.
 */
export class SpendUnknown extends JobError {
  constructor(message: string) {
    super(message)
    this.name = 'SpendUnknown'
  }
}

/** Map a stage's own 0..1 into its share of the whole job. */
export function stage(ctx: Pick<JobContext, 'progress'>, from: number, to: number): (fraction: number) => void {
  return (f) => ctx.progress(from + (to - from) * Math.max(0, Math.min(1, Number.isFinite(f) ? f : 0)))
}

/** Stop here when the job was cancelled or the worker is stopping. */
export function checkAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new JobError(signal.reason instanceof Error ? signal.reason.message : String(signal.reason ?? 'Cancelled'))
}
