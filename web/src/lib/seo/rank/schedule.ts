/**
 * The rank trackers' schedule: one pass of the cron (/api/cron/seo-rank-checks,
 * every 15 minutes). It finds the trackers whose next_check_at is due, oldest
 * first, and for each:
 *
 *   1. asks the schedule's gate (./gate.ts). An answer that can't be read
 *      leaves the tracker due for the next tick; a refusal skips this check;
 *   2. advances next_check_at by one step of the schedule with a
 *      compare-and-set on the value it read, writing the skip reason with it.
 *      Two overlapping ticks read the same value; only one write matches it,
 *      so only one tick goes on to start the check;
 *   3. writes the run (trigger scheduled, scheduled_for = the due time it
 *      read). A unique index on (tracker, scheduled_for) is the second fence:
 *      a due time starts one check, whatever happens to the first;
 *   4. sends the lane its event.
 *
 * A tracker whose previous check is still running gets its due time back
 * (the compare-and-set again, the other way), so it starts on a later tick
 * once that check ends. A previous check that is stuck (far past any real
 * check's length, ./runs.ts isStuckRun) is failed first and told to stop,
 * the same reap a person's start does, so one stuck check never blocks a
 * schedule for good: the next tick starts the check. The anchor advances in
 * whole steps from the due time it had, never from "now", so a late tick
 * doesn't drift the schedule.
 *
 * Work admitted per tick is bounded (searches, the source's admission
 * control), and so is the time a tick spends: what's left stays due and the
 * next tick takes it, oldest first.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  computeNextCheckAt,
  devicesCount,
  isScheduledRankTrackingInterval,
} from '@/lib/seo/shared/rank-tracking'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { gateDeps, scheduledCheckGate, type GateDeps } from './gate'
import { getLiveRankRun, readTrackerKeywords, type RunRow } from './queries'
import {
  dispatchRun,
  insertRun,
  reapIfStuck,
  type InsertRunResult,
  type SendEvent,
} from './runs'
import type {
  RankSkipReason,
  RankTrackingDevices,
  RankTrackingScheduleInterval,
} from './view'

/**
 * Searches (keywords times devices) started per tick. The first start of a
 * tick is always admitted, so a tracker bigger than the budget never starves.
 * Sized like the source's (500 per 5-minute tick) for our 15-minute tick: the
 * binding cost is the free task_get polling against the provider's request
 * rate limit, not money.
 */
export const SCHEDULED_SEARCH_BUDGET = 1500
/** Trackers a tick looks at. */
export const DUE_SCAN_LIMIT = 100
/** A tick stops starting checks after this long; the rest stay due. */
export const TICK_DEADLINE_MS = 3 * 60_000

export interface DueTracker {
  id: string
  workspace_id: string
  created_by: string | null
  devices: RankTrackingDevices
  serp_depth: number
  schedule_interval: RankTrackingScheduleInterval
  next_check_at: string | null
  paused: boolean
  keyword_count: number
}

export interface ScheduleStore {
  /** Unpaused scheduled trackers with next_check_at at or before now, oldest due first. */
  listDue(nowIso: string, limit: number): Promise<DueTracker[]>
  /**
   * Compare-and-set next_check_at from `observed` to `next` (and the skip
   * reason, when given). True only for the write that matched.
   */
  advance(
    tracker: Pick<DueTracker, 'id' | 'workspace_id' | 'schedule_interval'>,
    observed: string,
    next: string,
    skipReason?: RankSkipReason | null,
  ): Promise<boolean>
  keywords(tracker: Pick<DueTracker, 'id' | 'workspace_id'>): Promise<string[]>
  insertRun(
    tracker: DueTracker,
    scheduledFor: string,
    keywords: string[],
  ): Promise<InsertRunResult>
  dispatch(run: RunRow): Promise<boolean>
  /**
   * Fail the tracker's live check if it is stuck, and tell the lane to stop
   * it. True when it was stuck (the tracker is free for the next tick).
   */
  reapStuck(tracker: Pick<DueTracker, 'id' | 'workspace_id'>): Promise<boolean>
}

export interface ScheduleSummary {
  due: number
  started: number
  skipped: number
  /** Another tick advanced it first. */
  lost: number
  /** Its previous check is still running: due time given back. */
  already_running: number
  /** Of those, the previous check was stuck and is now failed: the next tick starts this one. */
  reaped: number
  /** A run for this due time already existed. */
  duplicate: number
  /** The gate couldn't read the person's standing: left due. */
  unreadable: number
  errors: number
  stopped_by_budget: boolean
  stopped_by_deadline: boolean
}

export async function runScheduledRankChecks(deps: {
  store: ScheduleStore
  gate: GateDeps
  now?: () => Date
}): Promise<ScheduleSummary> {
  const now = deps.now ?? (() => new Date())
  const startedAt = now().getTime()
  const summary: ScheduleSummary = {
    due: 0,
    started: 0,
    skipped: 0,
    lost: 0,
    already_running: 0,
    reaped: 0,
    duplicate: 0,
    unreadable: 0,
    errors: 0,
    stopped_by_budget: false,
    stopped_by_deadline: false,
  }
  const due = await deps.store.listDue(now().toISOString(), DUE_SCAN_LIMIT)
  summary.due = due.length
  let searches = 0

  for (const tracker of due) {
    if (now().getTime() - startedAt >= TICK_DEADLINE_MS) {
      summary.stopped_by_deadline = true
      break
    }
    // One bad row must not starve the rest of the tick.
    try {
      const interval = tracker.schedule_interval
      const observed = tracker.next_check_at
      if (
        !isScheduledRankTrackingInterval(interval) ||
        !observed ||
        tracker.paused
      )
        continue

      const units = tracker.keyword_count * devicesCount(tracker.devices)
      if (summary.started > 0 && searches + units > SCHEDULED_SEARCH_BUDGET) {
        summary.stopped_by_budget = true
        break
      }

      const gate = await scheduledCheckGate(
        tracker,
        tracker.keyword_count,
        deps.gate,
      )
      if (!gate.ok && gate.retry) {
        // Never move the anchor on an error: it is the schedule. Due again next tick.
        summary.unreadable++
        continue
      }
      const next = computeNextCheckAt(interval, observed)
      if (!gate.ok) {
        const reason = gate.reason === 'paused' ? null : gate.reason
        if (await deps.store.advance(tracker, observed, next, reason))
          summary.skipped++
        else summary.lost++
        continue
      }

      // Clearing the skip reason here is what lets a tracker that was being
      // skipped drop its notice once it runs again.
      if (!(await deps.store.advance(tracker, observed, next, null))) {
        summary.lost++
        continue
      }
      const keywords = await deps.store.keywords(tracker)
      const inserted = await deps.store.insertRun(tracker, observed, keywords)
      if (!inserted.ok) {
        if (inserted.reason === 'live') {
          // Nothing started: give the due time back, so a later tick starts it
          // once the running check ends. A schedule edit in between wins. A
          // stuck check is failed first, or it would hold the tracker forever.
          summary.already_running++
          if (await deps.store.reapStuck(tracker)) summary.reaped++
          await deps.store.advance(tracker, next, observed)
        } else if (inserted.reason === 'due_time_taken') {
          summary.duplicate++
        } else {
          // Leave the schedule advanced: an outage must not make every tracker due at once next tick.
          summary.errors++
          console.error('[seo-rank cron] run insert failed', {
            trackerId: tracker.id,
            message: inserted.message,
          })
        }
        continue
      }
      if (await deps.store.dispatch(inserted.run)) {
        summary.started++
        searches += units
      } else summary.errors++
    } catch (err) {
      summary.errors++
      console.error('[seo-rank cron] tracker failed', {
        trackerId: tracker.id,
        err,
      })
    }
  }
  return summary
}

/** The schedule's store over migration 594. */
export function createScheduleStore(
  svc: SupabaseClient,
  send?: SendEvent,
): ScheduleStore {
  return {
    async listDue(nowIso, limit) {
      const { data, error } = await svc
        .from('seo_rank_tracker')
        .select(
          'id, workspace_id, created_by, devices, serp_depth, schedule_interval, next_check_at, paused, keyword_count:seo_rank_keyword(count)',
        )
        .eq('paused', false)
        .neq('schedule_interval', 'manual')
        .not('next_check_at', 'is', null)
        .lte('next_check_at', nowIso)
        .order('next_check_at', { ascending: true })
        .limit(limit)
      if (error) throw new Error(`seo rank due scan failed: ${error.message}`)
      return (
        (data ?? []) as unknown as Array<
          Omit<DueTracker, 'keyword_count'> & {
            keyword_count?: Array<{ count: number }>
          }
        >
      ).map((row) => ({
        ...row,
        keyword_count: Number(row.keyword_count?.[0]?.count ?? 0),
      }))
    },

    async advance(tracker, observed, next, skipReason) {
      const patch: Record<string, unknown> = {
        next_check_at: next,
        updated_at: new Date().toISOString(),
      }
      if (skipReason !== undefined) patch.last_skip_reason = skipReason
      // Match the exact value read (and the schedule it was read under), so overlapping ticks can't both win.
      const { data, error } = await svc
        .from('seo_rank_tracker')
        .update(patch)
        .eq('id', tracker.id)
        .eq('workspace_id', tracker.workspace_id)
        .eq('schedule_interval', tracker.schedule_interval)
        .eq('paused', false)
        .eq('next_check_at', observed)
        .select('id')
      if (error)
        throw new Error(`seo rank schedule advance failed: ${error.message}`)
      return (data ?? []).length > 0
    },

    keywords: async (tracker) =>
      (await readTrackerKeywords(svc, tracker.workspace_id, tracker.id)).map(
        (k) => k.keyword,
      ),

    insertRun: (tracker, scheduledFor, keywords) =>
      insertRun(svc, tracker, {
        trigger: 'scheduled',
        startedBy: null,
        scheduledFor,
        keywords,
      }),

    dispatch: (run) => dispatchRun(svc, run, send),

    reapStuck: async (tracker) => {
      const live = await getLiveRankRun(svc, tracker.workspace_id, tracker.id)
      return live ? reapIfStuck(svc, live, { send }) : false
    },
  }
}

/** One tick against the database. */
export function runScheduledRankChecksNow(
  svc: SupabaseClient,
): Promise<ScheduleSummary> {
  return runScheduledRankChecks({
    store: createScheduleStore(svc),
    gate: gateDeps(svc),
  })
}
