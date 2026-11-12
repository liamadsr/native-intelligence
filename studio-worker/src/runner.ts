/**
 * Running one claimed job: its scratch folder, its progress reports and
 * heartbeat, its cancellation, and its end (complete or fail).
 *
 *   - Progress goes to the app at most every PROGRESS_MIN_MS, with the log lines
 *     gathered since the last report, and at least every HEARTBEAT_MS while the
 *     job runs, so the app never takes a long render for a stale job.
 *   - Every answer says whether someone asked to cancel: the job's signal aborts,
 *     which kills its FFmpeg and stops its render, and the job is failed as cancelled.
 *   - `stop(reason)` (SIGTERM) aborts the job the same way, with that reason.
 *   - A progress answer saying this worker no longer holds the job (409
 *     NOT_HELD: it went quiet and the job was claimed again) aborts it too, and
 *     nothing more is reported for it: the job is another worker's now.
 *   - A paid job (a shot, a narration) that returned after spending is
 *     COMPLETED whatever happened meanwhile (a cancel, SIGTERM, the job taken
 *     back): its answer carries the provider's job and the charge, and losing it
 *     would lose the charge and invite a second spend. Taken back, its
 *     completion is still sent once. If the app refuses it, the job fails with a
 *     sentence that names the charge, never one that asks to try again.
 *   - The scratch folder is removed whatever happened.
 */
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { AppError, type AppClient } from './app-client.ts'
import type { AssetCache } from './cache.ts'
import type { WorkerConfig } from './config.ts'
import { JobError, SpendUnknown, type JobContext, type JobHandler } from './jobs/context.ts'
import type { Renderer } from './render.ts'
import type { ClaimedJob, StudioJobKind } from '../../web/src/lib/studio/server/job-contract.ts'

export const HEARTBEAT_MS = 10_000
export const PROGRESS_MIN_MS = 2_000

export type Handlers = { [K in StudioJobKind]: JobHandler<K> }

/** True when the app answered that this worker no longer holds the job (it was taken back). Pure. */
export function lostJob(err: unknown): boolean {
  return err instanceof AppError && err.status === 409 && err.code === 'NOT_HELD'
}

/** What a job that was taken back logs as it stops. */
export const TAKEN_BACK = 'This worker no longer holds the job (it was taken back): stopping'

/**
 * Whether a job's answer says money was spent: a narration's always (the provider answered audio, or an undelivered
 * charge), a shot's unless nothing was spent (`refused`). Pure.
 */
export function spentResult(kind: StudioJobKind, result: unknown): boolean {
  if (!result || typeof result !== 'object') return false
  if (kind === 'narration') return true
  if (kind === 'shot') return (result as { outcome?: unknown }).outcome !== 'refused'
  return false
}

/** What a spent answer cost, in words, for a failure that must not lose it. Pure. */
export function chargeOf(kind: StudioJobKind, result: unknown): string {
  const r = (result ?? {}) as { providerJobId?: string; quote?: { credits?: number; model?: string }; characters?: number; providerRequestId?: string }
  if (kind === 'shot') return `Higgsfield job ${r.providerJobId ?? 'unknown'} (${r.quote?.credits ?? '?'} credits on ${r.quote?.model ?? 'unknown'})`
  return `ElevenLabs request ${r.providerRequestId ?? 'unknown'} (${r.characters ?? '?'} characters)`
}

/** The message a failed job gets: a job's own sentence as it is, anything else with what it was. Pure. */
export function failureMessage(err: unknown, cancelled: string | null): string {
  // A spend that may have been charged says so as it is, even when the job was stopped meanwhile.
  if (err instanceof SpendUnknown) return cancelled ? `${err.message} (${cancelled.replace(/[.;]? *try again\.?$/i, '')})` : err.message
  if (cancelled) return cancelled
  if (err instanceof JobError) return err.message
  const msg = err instanceof Error ? err.message : String(err)
  return (msg || 'The studio worker failed without a message').slice(0, 4000)
}

export class JobRun {
  readonly job: ClaimedJob
  private readonly deps: { config: WorkerConfig; client: AppClient; cache: AssetCache; renderer: Renderer; handlers: Handlers }
  private readonly abort = new AbortController()
  private fraction = 0
  private sentAt = 0
  private lines: string[] = []
  private sending: Promise<void> | null = null
  private cancelled: string | null = null
  /** The app took the job back: it is stopped and nothing more is reported for it. */
  private lost = false
  readonly startedAt = Date.now()

  constructor(job: ClaimedJob, deps: JobRun['deps']) {
    this.job = job
    this.deps = deps
  }

  get progressFraction(): number {
    return this.fraction
  }

  /** Abort the job with a sentence for its log and its failure. */
  stop(reason: string): void {
    if (this.abort.signal.aborted) return
    this.cancelled = reason
    this.abort.abort(new JobError(reason))
  }

  private say(line: string): void {
    console.info(`[studio-worker] job=${this.job.id} ${this.job.kind}: ${line}`)
    this.lines.push(line)
  }

  /** Send progress now if it is due (or `force`); one report at a time. */
  private report(force = false): Promise<void> {
    if (this.sending) return this.sending
    if (!force && Date.now() - this.sentAt < PROGRESS_MIN_MS) return Promise.resolve()
    const lines = this.lines.splice(0)
    const log = lines.length ? lines.join('\n').slice(-2000) : undefined
    this.sentAt = Date.now()
    this.sending = this.deps.client
      .progress(this.job.id, this.fraction, log)
      .then(({ cancelRequested }) => {
        if (cancelRequested) this.stop('Cancelled')
      })
      .catch((err) => {
        if (lostJob(err)) {
          this.lost = true
          this.stop(TAKEN_BACK)
          return
        }
        // Kept for the next report: the job goes on whatever the app said.
        if (log) this.lines.unshift(...lines)
        console.warn(`[studio-worker] job=${this.job.id} progress not sent: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        this.sending = null
      })
    return this.sending
  }

  /**
   * Complete a job whose answer carries a spend, whatever happened meanwhile: stopped or not, held or not. Taken
   * back, the completion is still sent once (the app records a charge that arrives that way). Refused, the job fails
   * with a sentence naming the charge.
   */
  private async completeSpent(result: unknown, heartbeat: NodeJS.Timeout): Promise<'completed' | 'failed'> {
    const { client } = this.deps
    clearInterval(heartbeat)
    if (this.abort.signal.aborted) this.say(`Stopped after spending (${this.cancelled ?? 'cancelled'}): completing with what was paid for`)
    await this.sending
    if (this.lines.length && !this.lost) await this.report(true)
    try {
      await client.complete(this.job.id, result)
      console.info(`[studio-worker] job=${this.job.id} ${this.job.kind}: completed after spending in ${((Date.now() - this.startedAt) / 1000).toFixed(1)} s`)
      return 'completed'
    } catch (err) {
      const charge = chargeOf(this.job.kind, result)
      console.warn(`[studio-worker] job=${this.job.id} ${this.job.kind}: the completion of a spend was not taken (${err instanceof Error ? err.message : String(err)}): ${charge}`)
      if (this.lost || lostJob(err)) return 'failed'
      const message = `This was paid for (${charge}) but the result could not be filed: ${err instanceof Error ? err.message.slice(0, 300) : String(err)}. Look for it in your provider account; it is not made again on its own.`
      await client.fail(this.job.id, message).catch((e) => console.warn(`[studio-worker] job=${this.job.id} failure not reported: ${e instanceof Error ? e.message : String(e)}`))
      return 'failed'
    }
  }

  /** Run the job to its end. Never throws: the outcome is reported to the app. */
  async run(): Promise<'completed' | 'failed'> {
    const { config, client, cache, renderer, handlers } = this.deps
    const scratch = join(config.workDir, 'jobs', this.job.id)
    const heartbeat = setInterval(() => void this.report(true), HEARTBEAT_MS)
    try {
      await rm(scratch, { recursive: true, force: true })
      await mkdir(scratch, { recursive: true })
      const ctx: JobContext = {
        job: this.job,
        config,
        client,
        cache,
        renderer,
        scratch,
        signal: this.abort.signal,
        progress: (f) => {
          if (Number.isFinite(f)) this.fraction = Math.max(this.fraction, Math.min(1, Math.max(0, f)))
          void this.report()
        },
        log: (line) => this.say(line),
      }
      this.say(`started (attempt ${this.job.attempts})`)
      await this.report(true)
      const handler = handlers[this.job.kind] as JobHandler<StudioJobKind>
      const result = await handler(ctx)
      if (spentResult(this.job.kind, result)) return await this.completeSpent(result, heartbeat)
      if (this.abort.signal.aborted) throw this.abort.signal.reason
      if (this.lost) throw new JobError(TAKEN_BACK)
      clearInterval(heartbeat)
      await this.sending
      if (this.lines.length) await this.report(true)
      await client.complete(this.job.id, result)
      console.info(`[studio-worker] job=${this.job.id} ${this.job.kind}: completed in ${((Date.now() - this.startedAt) / 1000).toFixed(1)} s`)
      return 'completed'
    } catch (err) {
      clearInterval(heartbeat)
      if (lostJob(err)) this.lost = true
      const message = failureMessage(err, this.cancelled)
      console.warn(`[studio-worker] job=${this.job.id} ${this.job.kind}: failed: ${message}`)
      if (!(err instanceof JobError) && err instanceof Error && err.stack) console.warn(err.stack.split('\n').slice(0, 6).join('\n'))
      await this.sending
      if (this.lost) return 'failed'
      if (this.lines.length) await this.report(true)
      await client.fail(this.job.id, message).catch((e) => console.warn(`[studio-worker] job=${this.job.id} failure not reported: ${e instanceof Error ? e.message : String(e)}`))
      return 'failed'
    } finally {
      clearInterval(heartbeat)
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      await cache.trim().catch(() => undefined)
    }
  }
}
