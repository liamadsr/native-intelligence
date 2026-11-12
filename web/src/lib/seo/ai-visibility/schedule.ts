/**
 * The schedule's clock: the cron route (src/app/api/cron/seo-ai-visibility)
 * calls runDueTrackers every hour. For each tracker whose next check is due:
 *
 *   1. ADVANCE next_run_at with a compare-and-set on the value it read, so
 *      two overlapping ticks can't both start the same due time (and the
 *      check's own unique index on (tracker, due time) holds it a second
 *      time). Advancing first means a tracker that is refused or busy moves
 *      on instead of staying due every hour.
 *   2. GATE: may the schedule spend (./gate.ts)? A refusal is written on the
 *      tracker as last_skip_reason, and no check is created.
 *   3. START: the check and its answers are written and the lane's event
 *      sent (./runs.ts). The check spends as the workspace (userId null).
 *
 * The next time keeps the schedule's anchor (computeNextCheckAt): a weekly
 * tracker due Monday that ran Wednesday is next due Monday.
 */
import { computeNextCheckAt } from '@/lib/seo/shared/rank-tracking'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { scheduledRunGate, type GateResult } from './gate'
import { getLiveRun, TRACKER_FIELDS, type TrackerRow } from './queries'
import { createRun, dispatchRun, failIfStuck, type RunDeps } from './runs'
import type { AiSkipReason } from './view'

/** Trackers handled per tick; the rest stay due for the next one. */
export const DUE_PER_TICK = 25
/** Stop starting new checks after this long, inside the route's time limit. */
const TICK_BUDGET_MS = 45_000

export interface ScheduleDeps extends RunDeps {
  gate?: (tracker: TrackerRow) => Promise<GateResult>
}

export interface DueOutcome {
  due: number
  started: Array<{ tracker_id: string; run_id: string }>
  skipped: Array<{ tracker_id: string; reason: string }>
}

async function recordSkip(
  svc: SupabaseClient,
  trackerId: string,
  reason: AiSkipReason | null,
) {
  const { error } = await svc
    .from('seo_ai_tracker')
    .update({ last_skip_reason: reason })
    .eq('id', trackerId)
  if (error)
    console.error('[seo-ai] schedule: skip reason not written', error.message)
}

/** Move a due tracker's next time on, if no other tick did first. Returns whether this tick owns the due time. */
export async function advanceDueTracker(
  svc: SupabaseClient,
  tracker: Pick<TrackerRow, 'id' | 'next_run_at' | 'schedule_interval'>,
  now: Date,
): Promise<boolean> {
  if (!tracker.next_run_at || tracker.schedule_interval === 'off') return false
  const next = computeNextCheckAt(
    tracker.schedule_interval,
    tracker.next_run_at,
  )
  const { data, error } = await svc
    .from('seo_ai_tracker')
    .update({ next_run_at: next, updated_at: now.toISOString() })
    .eq('id', tracker.id)
    .eq('next_run_at', tracker.next_run_at)
    .select('id')
  if (error) throw new Error(`seo ai schedule advance failed: ${error.message}`)
  return (data ?? []).length > 0
}

export async function runDueTrackers(
  svc: SupabaseClient,
  deps: ScheduleDeps = {},
): Promise<DueOutcome> {
  const now = deps.now?.() ?? new Date()
  const started = Date.now()
  const { data, error } = await svc
    .from('seo_ai_tracker')
    .select(TRACKER_FIELDS)
    .lte('next_run_at', now.toISOString())
    .eq('paused', false)
    .neq('schedule_interval', 'off')
    .order('next_run_at', { ascending: true })
    .limit(DUE_PER_TICK)
  if (error)
    throw new Error(`seo ai due trackers read failed: ${error.message}`)
  const due = (data ?? []) as TrackerRow[]
  const out: DueOutcome = { due: due.length, started: [], skipped: [] }
  const gate =
    deps.gate ?? ((tracker: TrackerRow) => scheduledRunGate(svc, tracker))

  for (const tracker of due) {
    if (Date.now() - started > TICK_BUDGET_MS) break
    const skip = async (reason: string, record: AiSkipReason | null) => {
      out.skipped.push({ tracker_id: tracker.id, reason })
      if (record) await recordSkip(svc, tracker.id, record)
    }
    try {
      if (!(await advanceDueTracker(svc, tracker, now))) {
        out.skipped.push({
          tracker_id: tracker.id,
          reason: 'claimed_elsewhere',
        })
        continue
      }
      const allowed = await gate(tracker)
      if (!allowed.ok) {
        await skip(
          allowed.reason,
          allowed.reason === 'paused' || allowed.reason === 'schedule_off'
            ? null
            : allowed.reason,
        )
        continue
      }
      const live = await getLiveRun(svc, tracker.workspace_id, tracker.id)
      if (live && !(await failIfStuck(svc, live, now))) {
        await skip('run_in_progress', 'run_in_progress')
        continue
      }
      const created = await createRun(svc, tracker, {
        trigger: 'scheduled',
        startedBy: null,
        scheduledFor: tracker.next_run_at,
        runId: deps.newId?.() ?? crypto.randomUUID(),
      })
      if (!created.ok) {
        const reason: AiSkipReason =
          created.code === 'NO_PROMPTS'
            ? 'no_prompts'
            : created.code === 'RUN_IN_PROGRESS'
              ? 'run_in_progress'
              : 'start_failed'
        await skip(reason, reason)
        continue
      }
      if (!(await dispatchRun(svc, created.run, tracker.workspace_id, deps))) {
        await skip('start_failed', 'start_failed')
        continue
      }
      await recordSkip(svc, tracker.id, null)
      out.started.push({ tracker_id: tracker.id, run_id: created.run.id })
    } catch (err) {
      console.error('[seo-ai] schedule: tracker failed', {
        trackerId: tracker.id,
        err,
      })
      out.skipped.push({ tracker_id: tracker.id, reason: 'error' })
    }
  }
  return out
}
