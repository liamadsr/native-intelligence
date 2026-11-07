/**
 * GET /api/cron/prospecting-prune — weekly retention sweep for the prospecting
 * candidate ledger (spec §3, retention).
 *
 * WHAT IS DELETED AND WHAT IS NOT. Only `prospect_run_candidate` rows, and
 * only those belonging to a run that is TERMINAL and finished more than
 * {@link RETENTION_DAYS} days ago. Nothing else in the feature is touched:
 *
 *   * `prospect_list_entry` is the user's work — a saved account, a considered
 *     dismissal — and outlives every run that produced it. A dismissal in
 *     particular is load-bearing forever: `dismissed_global` reads it to keep
 *     a competitor suppressed in lists that do not exist yet.
 *   * `prospecting_run` is the history the list header shows and the row the
 *     monthly ceiling sums. Deleting a run would make a month's spend appear
 *     to shrink, which is the one number that must never be wrong downward.
 *   * A LIVE or recently-finished run keeps its whole ledger, so "17 skipped →
 *     show me why" works for as long as anyone is plausibly still asking.
 *
 * The ledger is the right thing to age out because it is the only table that
 * grows with what the search SAW rather than with what the user kept: one
 * discover round records every suppressed and invalid candidate, so it
 * outgrows the entries it produced by an order of magnitude, and its whole
 * value is the audit trail of a run someone is currently looking at.
 *
 * Native Inngest cron triggers are BANNED in this codebase — the mandated
 * pattern is vercel.json cron → route (see cron/crm-sync). There is no
 * `inngest.send` here at all: a bounded DELETE is the entire job.
 *
 * BATCHED, and the batching is not cosmetic. A single unbounded
 * `DELETE ... WHERE run_id IN (<every stale run>)` on a table whose whole
 * purpose is to be large is a long lock on the hot path of any live run
 * writing its ledger. Instead the sweep resolves a bounded page of stale runs
 * and deletes their candidates a chunk of runs at a time, stopping at
 * {@link MAX_DELETES_PER_TICK}. Weekly at a bounded rate still drains any
 * backlog; the sweep is idempotent, so whatever this tick leaves behind the
 * next one takes.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireCronSecret } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/admin'
import { PROSPECTING_RUN_STATUSES } from '@/lib/prospecting/types'
import type { ProspectingRunStatus } from '@/lib/prospecting/types'

export const maxDuration = 60

/** §3: the ledger is kept for 90 days after its run finishes. */
const RETENTION_DAYS = 90

/**
 * The statuses at which a run is over and will never write to its ledger
 * again. Derived from {@link PROSPECTING_RUN_STATUSES} by SUBTRACTING the live
 * ones rather than by listing the terminal ones, so a status added to the
 * vocabulary later is treated as terminal-until-proven-live by a compiler
 * error here, not silently excluded from retention forever.
 *
 * `canceling` is live: the engine still owns the row and writes the terminal
 * status itself, and pruning under it would delete the partial results a
 * cancel exists to preserve.
 */
const LIVE_STATUSES = ['queued', 'running', 'needs_input', 'canceling'] as const satisfies
  readonly ProspectingRunStatus[]

const TERMINAL_STATUSES: ProspectingRunStatus[] = PROSPECTING_RUN_STATUSES.filter(
  (s): s is ProspectingRunStatus => !(LIVE_STATUSES as readonly string[]).includes(s),
)

/** How many stale runs one tick RESOLVES. Bounds the query and the response,
 *  but NOT the deleting — see {@link MAX_DELETES_PER_TICK}. */
const RUN_PAGE = 500

/** How many runs' candidates go into one DELETE. Small enough that the
 *  statement is short, large enough that a backlog drains in a few ticks. */
const RUN_CHUNK = 50

/**
 * Ceiling on DELETE statements per tick, and the LIVE bound on the work.
 *
 * Deliberately below `ceil(RUN_PAGE / RUN_CHUNK)` (10), so it binds rather
 * than sitting slack behind the page size: the tick deletes 8 chunks — 400
 * runs' candidates — and reports `truncated: true` for the rest, which the
 * next tick takes. A ceiling that can never be hit is not a guard, it is a
 * comment, and the first bump of RUN_PAGE would silently promote it into the
 * real limit having never once been exercised.
 *
 * Under it the ledger of a very large `prospect_run_candidate` table drains at
 * a bounded rate instead of in one long-locking sweep, which is the whole
 * reason the deletes are chunked at all.
 */
const MAX_DELETES_PER_TICK = 8

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = getServiceClient()

  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString()

  // Which runs are stale. `finished_at` is the retention clock, NOT
  // `created_at`: a run that queued in March and ran in June is 90 days past
  // being useful in September, not in June. `.not('finished_at','is',null)`
  // also drops the pathological row that is terminal with no finish stamp —
  // there is no clock for it, so it is left alone rather than guessed at.
  const { data: runs, error: runsError } = await supabase
    .from('prospecting_run')
    .select('id')
    .in('status', TERMINAL_STATUSES)
    .not('finished_at', 'is', null)
    .lt('finished_at', cutoff)
    // Oldest first: the rows that have waited longest are pruned first, so a
    // backlog drains from the far end rather than churning the recent tail.
    .order('finished_at', { ascending: true })
    .limit(RUN_PAGE)

  if (runsError) {
    console.error('[prospecting-prune] stale run query failed:', runsError)
    return NextResponse.json({ error: runsError.message }, { status: 500 })
  }

  const runIds = ((runs ?? []) as Array<{ id: string }>).map((r) => r.id)
  if (runIds.length === 0) {
    // Same summary shape as the main return — a caller reading the response
    // should not have to special-case the nothing-to-do tick.
    return NextResponse.json({
      ok: true,
      cutoff,
      stale_runs: 0,
      runs_pruned: 0,
      candidates_deleted: 0,
      batches: 0,
      truncated: false,
    })
  }

  let deleted = 0
  let batches = 0
  let runsPruned = 0
  let failed = false

  for (let i = 0; i < runIds.length; i += RUN_CHUNK) {
    if (batches >= MAX_DELETES_PER_TICK) break
    const chunk = runIds.slice(i, i + RUN_CHUNK)

    // `.select('id')` on a DELETE returns the deleted rows, which is the only
    // way to COUNT what was removed — without it the response would report a
    // number nobody measured.
    const { data, error } = await supabase
      .from('prospect_run_candidate')
      .delete()
      .in('run_id', chunk)
      .select('id')

    batches++
    if (error) {
      // One bad chunk does not abandon the tick: the remaining chunks are
      // independent, and the sweep is idempotent, so the next run retries this
      // one anyway. Logged and reported rather than swallowed.
      console.error('[prospecting-prune] delete batch failed:', error)
      failed = true
      continue
    }
    deleted += ((data ?? []) as unknown[]).length
    runsPruned += chunk.length
  }

  return NextResponse.json({
    ok: !failed,
    cutoff,
    stale_runs: runIds.length,
    runs_pruned: runsPruned,
    candidates_deleted: deleted,
    batches,
    // More stale runs than one tick handles. Weekly at this rate still drains
    // a backlog; the flag says so rather than leaving it to be inferred.
    truncated: runIds.length === RUN_PAGE || runsPruned < runIds.length,
  })
}
