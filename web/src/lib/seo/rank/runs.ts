/**
 * Starting and stopping rank checks: the one core behind the rank routes,
 * the agent's tools and the schedule's cron.
 *
 *   - A manual check is a person's request, so it goes through the SEO
 *     area's access check first (the server has search data, the person is
 *     a full member and not on the free plan, a person is actually there:
 *     ../access.ts). One estimated above CONFIRM_ABOVE_USD needs `confirmed`
 *     (the person saw the cost and said yes); without it the answer is
 *     NEEDS_GO_AHEAD with the estimate (./view.ts goAheadRefusal) and nothing
 *     starts. Its searches are metered against the workspace's monthly
 *     ceiling and written to the ledger in the person's name.
 *   - A scheduled check is nobody's turn: the cron starts it after the
 *     schedule's own gate (./gate.ts), never through the access check.
 *   - One live check per tracker: a second start while one is queued or
 *     running is refused with the live one, not queued behind it (a unique
 *     index keyed on the tracker holds it). A live check far past any real
 *     check's length is stuck: the next start (a person's, or the
 *     schedule's) fails it, tells the lane to stop it, and goes ahead.
 *   - The start only writes the run row and sends the event. The check runs
 *     in the background lane (src/lib/inngest/seo-rank-functions.ts).
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import {
  inngest,
  SEO_RANK_CHECK_CANCEL,
  SEO_RANK_CHECK_REQUESTED,
} from '@/lib/inngest/client'
import { checkSeoDataAccess, type SeoDataAccess } from '@/lib/seo/access'
import type { SeoRefusalCode } from '@/lib/seo/spend-view'
import {
  devicesCount,
  estimateRankCheckUsd,
} from '@/lib/seo/shared/rank-tracking'
import {
  nextMonthStart,
  readMonthlySeoSpend,
  SEO_MONTHLY_CAP_DOLLARS,
} from '@/lib/seo/spend'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import {
  CONFIRM_ABOVE_USD,
  STUCK_QUEUED_AFTER_MS,
  STUCK_RUN_AFTER_MS,
} from './limits'
import {
  getLiveRankRun,
  getRankRun,
  getTrackerRow,
  readTrackerKeywords,
  RUN_FIELDS,
  runView,
  type RunRow,
  type TrackerRow,
} from './queries'
import {
  estimateView,
  goAheadRefusal,
  isLiveRankRun,
  roundUsd,
  type RankGoAheadRefusal,
  type RankRunView,
} from './view'

export type SendEvent = (event: {
  name: string
  data: Record<string, unknown>
}) => Promise<unknown>

const defaultSend: SendEvent = (event) => inngest.send(event)

export interface RunDeps {
  send?: SendEvent
  /** The workspace's search data spend this month, in USD (tests stub it). */
  monthlySpend?: (workspaceId: string) => Promise<number>
  /** The access check (tests stub it). */
  access?: (who: {
    userId: string | null
    workspaceId?: string | null
    unattended?: boolean
  }) => Promise<SeoDataAccess>
  now?: () => Date
}

export type InsertRunResult =
  | { ok: true; run: RunRow }
  | { ok: false; reason: 'live' | 'due_time_taken' | 'error'; message?: string }

/**
 * Write a queued run for a tracker. The two unique indexes of migration 594
 * answer the races: `live` when the tracker already has a queued or running
 * check, `due_time_taken` when a scheduled check for this due time exists.
 */
export async function insertRun(
  svc: SupabaseClient,
  tracker: Pick<TrackerRow, 'id' | 'workspace_id' | 'devices' | 'serp_depth'>,
  input: {
    trigger: 'manual' | 'scheduled'
    startedBy: string | null
    scheduledFor: string | null
    keywords: readonly string[]
  },
): Promise<InsertRunResult> {
  const { costUsd } = estimateRankCheckUsd(
    input.keywords,
    tracker.devices,
    tracker.serp_depth,
  )
  const { data, error } = await svc
    .from('seo_rank_run')
    .insert({
      tracker_id: tracker.id,
      workspace_id: tracker.workspace_id,
      trigger: input.trigger,
      started_by: input.startedBy,
      scheduled_for: input.scheduledFor,
      keywords_total: input.keywords.length,
      checks_total: input.keywords.length * devicesCount(tracker.devices),
      estimate_usd: roundUsd(costUsd),
    })
    .select(RUN_FIELDS)
    .single()
  if (!error && data) return { ok: true, run: data as RunRow }
  const text = `${error?.message ?? ''} ${(error as { details?: string } | null)?.details ?? ''}`
  if (error?.code === '23505' && text.includes('seo_rank_run_one_per_due_time'))
    return { ok: false, reason: 'due_time_taken' }
  if (error?.code === '23505') return { ok: false, reason: 'live' }
  return { ok: false, reason: 'error', message: error?.message }
}

/** Write a run failed, unless it already ended. Returns whether this call ended it. */
export async function failRunIfLive(
  svc: SupabaseClient,
  runId: string,
  code: string,
  message: string,
): Promise<boolean> {
  const now = new Date().toISOString()
  const { data, error } = await svc
    .from('seo_rank_run')
    .update({
      status: 'failed',
      error_code: code,
      error_detail: message.slice(0, 2000),
      completed_at: now,
      updated_at: now,
    })
    .eq('id', runId)
    .in('status', ['queued', 'running'])
    .select('id')
  if (error) throw new Error(`seo rank run fail failed: ${error.message}`)
  return (data ?? []).length > 0
}

/** Whether a live run is far past any real check's length. */
export function isStuckRun(
  run: Pick<RunRow, 'status' | 'created_at' | 'started_at'>,
  now: Date,
): boolean {
  if (run.status === 'running') {
    const since = new Date(run.started_at ?? run.created_at).getTime()
    return now.getTime() - since > STUCK_RUN_AFTER_MS
  }
  if (run.status === 'queued')
    return (
      now.getTime() - new Date(run.created_at).getTime() > STUCK_QUEUED_AFTER_MS
    )
  return false
}

/**
 * The tracker's live check, after failing it if it is stuck (and telling the
 * lane to stop it, so a stuck instance can't post paid searches later). Null
 * when there is none, or the one there was stuck and is now failed. Used by a
 * person's start and by the schedule's cron, so a stuck check never blocks a
 * tracker for good.
 */
export async function liveRunAfterReap(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
  deps: RunDeps = {},
): Promise<RunRow | null> {
  const live = await getLiveRankRun(svc, workspaceId, trackerId)
  if (!live) return null
  return (await reapIfStuck(svc, live, deps)) ? null : live
}

/** Fail a live check that is stuck and tell the lane to stop it. True when it was stuck. */
export async function reapIfStuck(
  svc: SupabaseClient,
  live: Pick<RunRow, 'id' | 'status' | 'created_at' | 'started_at'>,
  deps: RunDeps = {},
): Promise<boolean> {
  if (!isStuckRun(live, deps.now?.() ?? new Date())) return false
  await failRunIfLive(
    svc,
    live.id,
    'STUCK',
    'The check did not finish. Run it again.',
  )
  await (deps.send ?? defaultSend)({
    name: SEO_RANK_CHECK_CANCEL,
    data: { runId: live.id },
  }).catch((err) =>
    console.error('[seo-rank] stuck run: cancel event failed', err),
  )
  return true
}

/** Send a queued run to the background lane; a send that fails writes the run failed so it never sits at "queued". */
export async function dispatchRun(
  svc: SupabaseClient,
  run: RunRow,
  send: SendEvent = defaultSend,
): Promise<boolean> {
  try {
    await send({
      name: SEO_RANK_CHECK_REQUESTED,
      data: {
        runId: run.id,
        workspaceId: run.workspace_id,
        trackerId: run.tracker_id,
      },
    })
    return true
  } catch (err) {
    console.error('[seo-rank] start: event send failed', err)
    await failRunIfLive(
      svc,
      run.id,
      'START_FAILED',
      'The check could not be started. Run it again.',
    ).catch(() => {})
    return false
  }
}

export type StartCheckResult =
  | { ok: true; run: RankRunView }
  | {
      ok: false
      code: SeoRefusalCode
      message: string
      refusal: true
    }
  | RankGoAheadRefusal
  | { ok: false; code: 'ALREADY_RUNNING'; message: string; run: RankRunView }
  | {
      ok: false
      code: 'NOT_FOUND' | 'NO_KEYWORDS' | 'START_FAILED' | 'SPEND_LIMIT_REACHED'
      message: string
    }

/** Start a check of every keyword of a tracker now, on a person's request. It spends: see the file header. */
export async function startRankCheck(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string },
  trackerId: string,
  opts: { unattended?: boolean; confirmed?: boolean } = {},
  deps: RunDeps = {},
): Promise<StartCheckResult> {
  const access = await (deps.access ?? checkSeoDataAccess)({
    userId: who.userId,
    workspaceId: who.workspaceId,
    unattended: opts.unattended,
  })
  if (!access.ok)
    return {
      ok: false,
      code: access.code,
      message: access.message,
      refusal: true,
    }

  const tracker = await getTrackerRow(svc, who.workspaceId, trackerId)
  if (!tracker)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That rank tracker doesn’t exist.',
    }
  const keywords = (
    await readTrackerKeywords(svc, who.workspaceId, trackerId)
  ).map((k) => k.keyword)
  if (keywords.length === 0)
    return {
      ok: false,
      code: 'NO_KEYWORDS',
      message: 'The tracker has no keywords yet. Add some first.',
    }

  // The check's own first step holds its estimate against the month too;
  // asking here answers the person now instead of with a check that fails a
  // moment later.
  const { costUsd } = estimateRankCheckUsd(
    keywords,
    tracker.devices,
    tracker.serp_depth,
  )
  const spent = await (
    deps.monthlySpend ?? ((ws: string) => readMonthlySeoSpend(svc, ws))
  )(who.workspaceId)
  if (spent + costUsd > SEO_MONTHLY_CAP_DOLLARS) {
    return {
      ok: false,
      code: 'SPEND_LIMIT_REACHED',
      message: `This check could cost up to $${roundUsd(costUsd).toFixed(2)}, more than this workspace has left of its search data limit this month. It starts over on ${nextMonthStart(
        deps.now?.() ?? new Date(),
      )
        .toISOString()
        .slice(0, 10)}.`,
    }
  }
  if (roundUsd(costUsd) > CONFIRM_ABOVE_USD && opts.confirmed !== true)
    return goAheadRefusal(
      'check',
      estimateView({
        keywords,
        devices: tracker.devices,
        serp_depth: tracker.serp_depth,
        schedule: 'manual',
      }),
    )

  // Two tries: once, and once more after failing a stuck live check.
  for (let attempt = 0; attempt < 2; attempt++) {
    const inserted = await insertRun(svc, tracker, {
      trigger: 'manual',
      startedBy: who.userId,
      scheduledFor: null,
      keywords,
    })
    if (inserted.ok) {
      if (!(await dispatchRun(svc, inserted.run, deps.send)))
        return {
          ok: false,
          code: 'START_FAILED',
          message: 'Could not start the check just now. Try again in a moment.',
        }
      return { ok: true, run: runView(inserted.run) }
    }
    if (inserted.reason === 'error') {
      console.error('[seo-rank] start: insert failed', inserted.message)
      return {
        ok: false,
        code: 'START_FAILED',
        message: 'Could not start the check just now. Try again in a moment.',
      }
    }
    const live = await liveRunAfterReap(svc, who.workspaceId, trackerId, deps)
    if (live)
      return {
        ok: false,
        code: 'ALREADY_RUNNING',
        message:
          'A check of this tracker is already running. Nothing new was started or charged.',
        run: runView(live),
      }
  }
  return {
    ok: false,
    code: 'START_FAILED',
    message: 'Could not start the check just now. Try again in a moment.',
  }
}

export type CancelCheckResult =
  | { ok: true; run: RankRunView }
  | { ok: false; code: 'NOT_FOUND' | 'NOT_RUNNING'; message: string }

/**
 * Stop a queued or running check. Searches already bought are paid for; a
 * canceled check's partial results don't count as a check (the latest
 * positions stay those of the last completed one).
 */
export async function cancelRankCheck(
  svc: SupabaseClient,
  who: { workspaceId: string },
  runId: string,
  deps: RunDeps = {},
): Promise<CancelCheckResult> {
  const run = await getRankRun(svc, who.workspaceId, runId)
  if (!run)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'That check doesn’t exist.',
    }
  if (!isLiveRankRun(run.status))
    return {
      ok: false,
      code: 'NOT_RUNNING',
      message: 'That check already ended.',
    }
  // The status first: a paid batch in flight reads it before posting
  // (seo_rank_post_begin), and the lane's own steps stop at the event.
  const now = new Date().toISOString()
  const { error } = await svc
    .from('seo_rank_run')
    .update({ status: 'canceled', completed_at: now, updated_at: now })
    .eq('id', runId)
    .eq('workspace_id', who.workspaceId)
    .in('status', ['queued', 'running'])
  if (error) throw new Error(`seo rank run cancel failed: ${error.message}`)
  await (deps.send ?? defaultSend)({
    name: SEO_RANK_CHECK_CANCEL,
    data: { runId },
  }).catch((err) =>
    // The status alone already stops it from posting more.
    console.error('[seo-rank] cancel: event send failed', err),
  )
  const settled = await getRankRun(svc, who.workspaceId, runId)
  return { ok: true, run: settled ?? { ...run, status: 'canceled' } }
}

/**
 * Stop the live check of a tracker: any (before it is deleted), or only a
 * scheduled one (when its schedule is paused or turned off; a check a person
 * started stays theirs to stop).
 */
export async function cancelLiveRunsForTracker(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
  deps: RunDeps = {},
  only: { trigger?: 'manual' | 'scheduled' } = {},
): Promise<void> {
  const live = await getLiveRankRun(svc, workspaceId, trackerId)
  if (!live || (only.trigger && live.trigger !== only.trigger)) return
  await cancelRankCheck(svc, { workspaceId }, live.id, deps)
}
