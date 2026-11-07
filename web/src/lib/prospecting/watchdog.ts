/**
 * The stale-run watchdog: settles a live run whose engine went silent.
 *
 * Every terminal status is written by the engine (spec §9), and the engine is
 * an Inngest step. That is right for every run the engine actually executes
 * — and leaves no one to write the ending when it does not: the Inngest app
 * unreachable or unsynced, the local Inngest dev server not running, a step
 * killed at the invocation cap and then cancelled so it never retried, a
 * `cancelOn` that fired between `claim-run` and `execute-run`. In each case
 * the row sits at `queued` / `running` / `canceling` forever, and the page —
 * which treats all three as live — shows "Finding companies…" or
 * "Cancelling…" for good, with Find disabled and the nav dot lit. That is what
 * Liam saw and asked about (2026-09-05).
 *
 * THE HEARTBEAT is `progress.updated_at`: the engine writes it after every
 * paid unit and at every phase boundary (`BaseRunState.write`). Before the
 * first write the clock is `started_at` (set by the claim) and before that
 * `created_at`. A live run cannot be silent for long: `execute-run` is one
 * step inside one Vercel invocation capped at 300 s (`api/inngest/route.ts`),
 * so a unit boundary — and a heartbeat — must arrive within five minutes or
 * the invocation dies; Inngest then retries ONCE (`PROSPECTING_INNGEST_RETRIES`)
 * after a short backoff. Fifteen minutes of silence is therefore well past
 * "still working" and past "retry in flight": the engine is gone.
 *
 * WHAT IT WRITES: `canceling` → `canceled` (the user asked; results kept,
 * `error` untouched), `queued` / `running` → `failed` with a message the
 * outcome banner shows verbatim next to its Retry button. Every write is a
 * compare-and-set on the status the sweep observed, so a run that settles
 * between the read and the write keeps the engine's own ending.
 *
 * The one thing this deliberately does NOT do is decide the engine is dead
 * early. A row flipped to `canceled` while the engine is merely slow would
 * make `isCanceling()` read false at the next boundary — the engine would
 * carry on and later overwrite the ending with `completed`. Fifteen minutes
 * against a five-minute invocation cap is the margin that makes that
 * impossible.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProspectingRunStatus } from './types'
import { settleProspectingWorkByRun } from '@/lib/work/prospecting-run-mirror'

/** Silence after which a live run is presumed dead. See the header for why
 *  fifteen minutes against a 300 s invocation cap. */
export const STALE_RUN_MS = 15 * 60_000

/** What the outcome banner says for a run the watchdog failed. */
export const STALE_RUN_ERROR = 'The run stopped reporting progress'

/** The statuses the sweep may settle — the page's "live" set minus
 *  `needs_input`, which v1 never parks a run at. */
export const WATCHDOG_STATUSES = ['queued', 'running', 'canceling'] as const satisfies
  readonly ProspectingRunStatus[]

/** Rows per sweep. Bounds the read; a backlog drains over successive ticks. */
const SWEEP_PAGE = 200

export interface StaleCandidateRow {
  id: string
  workspace_id: string
  status: string
  progress: unknown
  started_at: string | null
  created_at: string
}

function parseMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : null
}

/**
 * When the engine last said anything about this run: the latest of the
 * progress heartbeat, the claim time and the row's creation. Never null —
 * a row with an unparseable `created_at` is treated as born now, which
 * defers it rather than failing it on bad data.
 */
export function lastHeartbeatMs(row: StaleCandidateRow, now: Date): number {
  const progress = row.progress as { updated_at?: unknown } | null
  const stamps = [
    parseMs(progress && typeof progress === 'object' ? progress.updated_at : null),
    parseMs(row.started_at),
    parseMs(row.created_at),
  ].filter((ms): ms is number => ms !== null)
  return stamps.length > 0 ? Math.max(...stamps) : now.getTime()
}

export function isStaleRun(row: StaleCandidateRow, now: Date): boolean {
  return now.getTime() - lastHeartbeatMs(row, now) >= STALE_RUN_MS
}

/** The ending a stale row gets, by the status it was stuck at. */
export function staleOutcome(status: string): {
  status: 'canceled' | 'failed'
  error: string | null
} {
  return status === 'canceling'
    ? { status: 'canceled', error: null }
    : { status: 'failed', error: STALE_RUN_ERROR }
}

export interface WatchdogSweepResult {
  scanned: number
  stale: number
  failed: number
  canceled: number
  /** Rows the CAS refused — they settled on their own between read and write. */
  skipped: number
}

/**
 * One sweep. Reads a bounded page of live rows old enough to possibly be
 * stale (the `created_at` pre-filter keeps the query off every fresh run),
 * decides staleness per row from the heartbeat, and settles each stale row
 * with a status-conditional update.
 */
export async function sweepStaleRuns(
  supabase: SupabaseClient,
  now: Date = new Date(),
): Promise<WatchdogSweepResult> {
  const result: WatchdogSweepResult = { scanned: 0, stale: 0, failed: 0, canceled: 0, skipped: 0 }
  const cutoff = new Date(now.getTime() - STALE_RUN_MS).toISOString()

  const { data, error } = await supabase
    .from('prospecting_run')
    .select('id, workspace_id, status, progress, started_at, created_at')
    .in('status', WATCHDOG_STATUSES as unknown as string[])
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(SWEEP_PAGE)
  if (error) throw new Error(`prospecting_run watchdog read failed: ${error.message}`)

  const rows = (data ?? []) as StaleCandidateRow[]
  result.scanned = rows.length

  for (const row of rows) {
    if (!isStaleRun(row, now)) continue
    result.stale += 1
    const outcome = staleOutcome(row.status)
    const patch: Record<string, unknown> = {
      status: outcome.status,
      finished_at: now.toISOString(),
    }
    // A cancelled run keeps whatever `error` it had (normally null); a failed
    // one gets the message the banner shows.
    if (outcome.status === 'failed') patch.error = outcome.error

    const { data: written, error: writeError } = await supabase
      .from('prospecting_run')
      .update(patch)
      .eq('id', row.id)
      .eq('workspace_id', row.workspace_id)
      // CAS on the status the sweep saw: an engine that settled the row in
      // the meantime wins, always.
      .eq('status', row.status)
      .select('id')
    if (writeError) {
      console.error('[prospecting-watchdog] settle failed:', row.id, writeError.message)
      continue
    }
    if (((written ?? []) as unknown[]).length === 0) {
      result.skipped += 1
      continue
    }
    if (outcome.status === 'canceled') result.canceled += 1
    else result.failed += 1
    // The run's Activity row follows the write that won (Sequence row 6).
    await settleProspectingWorkByRun(supabase, row.id, { status: outcome.status, error: outcome.error })
  }

  return result
}
