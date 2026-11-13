import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import { inngest } from '@/lib/inngest/client'
import { computeNextRun } from '@/lib/flows/schedule'
import { computeNextCalendarRun, decideCalendarAction } from '@/lib/flows/schedule-calendar'
import { ageOutStaleProposals, groomExpiredAttentionCards } from '@/lib/flows/proposal-age-out'
import { expireStaleSuggestions, purgeResolvedSuggestions } from '@/lib/suggestions/sweep'
import { reapStaleWork, type ReapOutcome } from '@/lib/work/reaper'
import { readSettledRunDigests } from '@/lib/attention/read-digest'
import { runReminderPass } from '@/lib/reminders/dispatch'
import type { CalendarEventTriggerConfig, FlowAction, ScheduleTriggerConfig } from '@/lib/flows/types'

// Recurring hygiene horizon: the automatic cron ages out proposals older than
// this. Deliberately LONGER than the E1 supervised drain's 30d, so the ongoing
// sweep never races ahead of a user still working their queue. The one-time
// bulk drain (older, bigger backlog) is the admin route, run with a human.
const CRON_AGE_OUT_DAYS = 45
// Per-tick cap so a single 5-minute tick can never churn thousands of rows —
// the backlog drains over several ticks; the admin route does the bulk clear.
const CRON_AGE_OUT_LIMIT = 200

export const maxDuration = 60

/**
 * GET /api/cron/flow-schedule — the loop engine's clock (every 5 minutes,
 * vercel.json). Vercel cron is the ONLY tick for time-driven flows —
 * deliberately NOT an Inngest cron, whose registration has silently failed
 * before (see /api/cron/weave); Vercel's scheduler is independent of Inngest
 * app-sync state.
 *
 * Two passes, both keyed on flow.next_run_at and both firing via the same
 * `flow/schedule.due` event (the dispatcher accepts schedule + calendar_event):
 *
 *   SCHEDULE PASS — scans due schedule flows (next_run_at <= now), CAS-forwards
 *   next_run_at (the double-fire guard), and fires the winner. next occurrence
 *   is pure cadence math (computeNextRun), computed from NOW so a flow that was
 *   due while the tick was down fires once and re-anchors — no catch-up burst.
 *   A once-schedule's fire CAS-sets next_run_at NULL and enabled false in one
 *   write (claimOnceFire): it runs one time and then reads as finished.
 *
 *   CALENDAR PASS (GEN-136) — scans ALL enabled calendar_event flows (not just
 *   due ones) because a calendar flow's next_run_at is derived from synced
 *   calendar data that CHANGES: a meeting can move earlier/later or be
 *   cancelled after next_run_at was set. Each pass recomputes the true next
 *   fire from live calendar data (computeNextCalendarRun) and:
 *     - FIRES if the stored next_run_at has arrived (<= now), then CAS-advances
 *       to the recomputed next occurrence (always strictly > now → no re-fire);
 *     - RE-ANCHORS (CAS-updates next_run_at) if the recomputed value drifted
 *       from what's stored but is still in the future (the meeting moved);
 *     - GOES DORMANT (CAS next_run_at -> null) if there's no upcoming occurrence
 *       or the calendar cache is stale.
 *   The CAS guard (`WHERE next_run_at = <seen>`) makes every write idempotent
 *   under overlapping ticks exactly as the schedule pass.
 *
 *   REMINDER PASS — the same clock also fires per-user "remind me" reminders
 *   (public.reminder). Same shape as the schedule pass: due-scan, CAS-claim,
 *   emit, roll back on failure — except the "emit" is a direct notification
 *   INSERT rather than an Inngest event.
 *
 * The due-scan is intentionally cross-workspace — this is the global
 * scheduler; every per-flow write below is still pinned to the flow's own
 * workspace_id.
 *
 * Vercel cron issues GET with `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: NextRequest) {
  // Fails CLOSED on an unset secret (see requireCronSecret). This pass performs
  // WRITES (the E1 hygiene sweep), so a fail-open gate would let an
  // unauthenticated request drive dismissals.
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = getServiceClient()
  const now = new Date()

  const schedule = await runSchedulePass(supabase, now)
  const calendar = await runCalendarPass(supabase, now)
  const reminders = await runReminderPass(supabase, now)
  const hygiene = await runQueueHygienePass(supabase, now)
  const work = await runWorkReaperPass(supabase, now)

  return NextResponse.json({ ok: true, schedule, calendar, reminders, hygiene, work })
}

/**
 * Work-ledger reaper pass (ACTIVITY-AND-REVIEW-DESIGN §3.5): a ledger row that
 * is still queued/running past its deadline stopped reporting — fail it with
 * "no report back" so a dead engine looks dead (NORTH-STAR invariant 4).
 * Best-effort: never fails the tick.
 */
async function runWorkReaperPass(
  supabase: ReturnType<typeof getServiceClient>,
  now: Date,
): Promise<ReapOutcome> {
  try {
    return await reapStaleWork(supabase, { nowIso: now.toISOString() })
  } catch (e) {
    console.error('flow-schedule: work reaper failed:', e)
    return { failed: 0, extended: 0, expired: 0, questionsReconciled: 0, questionsExpired: 0 }
  }
}

/**
 * Queue-hygiene pass (loop-closure E1) — keep the proposal queue and the
 * attention rail from becoming graveyards. Bounded, terminal sweeps:
 *   • age out pending proposals older than CRON_AGE_OUT_DAYS (capped per tick),
 *   • expire pending suggestions in a document, a chat or a run past their
 *     expires_at, and purge dismissed and expired rows long after they
 *     resolved (src/lib/suggestions/sweep.ts, migration 313; capture
 *     proposals keep the age-out above),
 *   • expire pending attention cards past their TTL (the migration-165 grooming),
 *   • read the digest of a run whose cards all settled with no click (migration
 *     352's triggers, the grooming above: src/lib/attention/read-digest.ts),
 *     as a person's settle of its last card does.
 * Best-effort: a failure here never fails the tick's scheduling work.
 */
async function runQueueHygienePass(
  supabase: ReturnType<typeof getServiceClient>,
  now: Date,
): Promise<{
  agedOut: number
  suggestionsExpired: number
  suggestionsPurged: number
  cardsExpired: number
  digestsRead: number
}> {
  let agedOut = 0
  let suggestionsExpired = 0
  let suggestionsPurged = 0
  let cardsExpired = 0
  try {
    const res = await ageOutStaleProposals(supabase, {
      olderThanDays: CRON_AGE_OUT_DAYS,
      limit: CRON_AGE_OUT_LIMIT,
    })
    agedOut = res.dismissed
  } catch (e) {
    // Non-fatal (never fail the tick's scheduling), but LOG it — a silently
    // failing sweep would let the graveyard regrow with no signal.
    console.error('flow-schedule hygiene: age-out failed:', e)
  }
  try {
    suggestionsExpired = (await expireStaleSuggestions(supabase, now)).expired
  } catch (e) {
    console.error('flow-schedule hygiene: suggestion expiry failed:', e)
  }
  try {
    suggestionsPurged = (await purgeResolvedSuggestions(supabase, now)).purged
  } catch (e) {
    console.error('flow-schedule hygiene: suggestion purge failed:', e)
  }
  try {
    const res = await groomExpiredAttentionCards(supabase, now)
    cardsExpired = res.expired
  } catch (e) {
    console.error('flow-schedule hygiene: card groom failed:', e)
  }
  // Never throws (it logs its own failure line); after the groom, so the cards
  // it just expired are read in this same tick.
  const digestsRead = (await readSettledRunDigests(supabase, now)).read
  return { agedOut, suggestionsExpired, suggestionsPurged, cardsExpired, digestsRead }
}

// ──────────────────────────────────────────────────────────────────
// Schedule pass — pure cadence math (unchanged behavior).
// ──────────────────────────────────────────────────────────────────

async function runSchedulePass(
  supabase: ReturnType<typeof getServiceClient>,
  now: Date,
): Promise<{ due: number; fired: number; lost: number; errored: number }> {
  const { data: due, error } = await supabase
    .from('flow')
    .select('id, workspace_id, trigger_config, next_run_at')
    .eq('trigger_type', 'schedule')
    .eq('enabled', true)
    .not('next_run_at', 'is', null)
    .lte('next_run_at', now.toISOString())
    .order('next_run_at', { ascending: true })
    .limit(200)

  if (error) {
    console.error('[flow-schedule cron] schedule due-scan failed:', error.message)
    return { due: 0, fired: 0, lost: 0, errored: 1 }
  }

  let fired = 0
  let lost = 0
  let errored = 0

  for (const flow of due ?? []) {
    try {
      const cfg = flow.trigger_config as ScheduleTriggerConfig

      // A one-time run: claim it by switching the loop off as next_run_at
      // goes NULL (one CAS), so it reads as finished and never fires again.
      if (cfg?.cadence === 'once') {
        const claimed = await claimOnceFire(supabase, flow)
        if (claimed === 'error') errored += 1
        else if (claimed === 'lost') lost += 1
        else if (await emitOnceAfterClaim(supabase, flow)) fired += 1
        else errored += 1
        continue
      }

      // NULL: a custom schedule with no run left in the search window; it
      // stays on and idle (an edit or a re-enable recomputes it).
      const next = computeNextRun(cfg, now)?.toISOString() ?? null

      // CAS: advance next_run_at only if it still holds the value we read.
      // Losing the race (0 rows) means another tick already claimed this fire.
      const won = await casNextRunAt(supabase, flow, next)
      if (won === 'error') {
        errored += 1
        continue
      }
      if (won === 'lost') {
        lost += 1
        continue
      }

      // Emit after the CAS won; rolls next_run_at back if the emit fails so the
      // fire isn't silently lost. A paused workspace's fire (autonomy off) is
      // emitted too: the dispatcher asks the kill switch and records the skip
      // (ledgerPausedFires, flow-functions.ts), so it is visible, not dropped.
      if (await emitDueAfterCas(supabase, flow, next)) fired += 1
      else errored += 1
    } catch (err) {
      // One corrupt row (computeNextRun throw, send failure) must not stall
      // the rest of the tick. It stays due and will be retried (and logged)
      // next tick — loud beats a silently-dead scheduler.
      errored += 1
      console.error(
        `[flow-schedule cron] schedule fire failed for flow ${flow.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return { due: due?.length ?? 0, fired, lost, errored }
}

/**
 * Claim a once-schedule's fire: next_run_at -> NULL and enabled -> false, only
 * if both still hold what we read (the same double-fire guard as casNextRunAt).
 */
async function claimOnceFire(
  supabase: ReturnType<typeof getServiceClient>,
  flow: DueFlow,
): Promise<'set' | 'lost' | 'error'> {
  if (flow.next_run_at === null) return 'lost'
  const { data: won, error } = await supabase
    .from('flow')
    .update({ next_run_at: null, enabled: false })
    .eq('id', flow.id)
    .eq('workspace_id', flow.workspace_id)
    .eq('enabled', true)
    .eq('next_run_at', flow.next_run_at)
    .select('id')
  if (error) {
    console.error(`[flow-schedule cron] once claim failed for flow ${flow.id}:`, error.message)
    return 'error'
  }
  return won && won.length > 0 ? 'set' : 'lost'
}

/**
 * Emit a claimed once fire; on a failed emit put the loop back as it was (on,
 * due at its time) so the next tick retries, guarded on the claim's own
 * writes so a person's edit in between is never clobbered.
 */
async function emitOnceAfterClaim(
  supabase: ReturnType<typeof getServiceClient>,
  flow: DueFlow,
): Promise<boolean> {
  try {
    await inngest.send({
      name: 'flow/schedule.due',
      data: { flow_id: flow.id, workspace_id: flow.workspace_id, scheduled_for: flow.next_run_at },
    })
    return true
  } catch (err) {
    console.error(`[flow-schedule cron] once emit failed for flow ${flow.id}, putting it back:`, err instanceof Error ? err.message : err)
    const { error } = await supabase
      .from('flow')
      .update({ next_run_at: flow.next_run_at, enabled: true })
      .eq('id', flow.id)
      .eq('workspace_id', flow.workspace_id)
      .eq('enabled', false)
      .is('next_run_at', null)
    if (error) console.error(`[flow-schedule cron] once rollback failed for flow ${flow.id}:`, error.message)
    return false
  }
}

// ──────────────────────────────────────────────────────────────────
// Calendar pass — re-anchor + fire against live calendar data (GEN-136).
// ──────────────────────────────────────────────────────────────────

async function runCalendarPass(
  supabase: ReturnType<typeof getServiceClient>,
  now: Date,
): Promise<{ scanned: number; fired: number; reanchored: number; dormant: number; lost: number; errored: number }> {
  // Scan ALL enabled calendar flows — not filtered by next_run_at, because a
  // moved meeting means the stored value may need re-anchoring even when it
  // isn't yet due. Bounded row cap keeps the tick within budget.
  const { data: flows, error } = await supabase
    .from('flow')
    .select('id, workspace_id, trigger_config, next_run_at, created_by')
    .eq('trigger_type', 'calendar_event')
    .eq('enabled', true)
    .limit(200)

  if (error) {
    console.error('[flow-schedule cron] calendar scan failed:', error.message)
    return { scanned: 0, fired: 0, reanchored: 0, dormant: 0, lost: 0, errored: 1 }
  }

  let fired = 0
  let reanchored = 0
  let dormant = 0
  let lost = 0
  let errored = 0

  for (const flow of flows ?? []) {
    try {
      const cfg = flow.trigger_config as CalendarEventTriggerConfig
      const runAsUserId = flow.created_by as string | null
      // A calendar flow with no creator can't resolve a per-user calendar —
      // it can never anchor. Park it dormant rather than error every tick.
      if (!runAsUserId) {
        if (flow.next_run_at !== null) {
          const won = await casNextRunAt(supabase, flow, null)
          if (won === 'set') dormant += 1
          else if (won === 'lost') lost += 1
          else errored += 1
        }
        continue
      }

      const { next: recomputed } = await computeNextCalendarRun(cfg, now, supabase, runAsUserId)

      const { action, advanceTo } = decideCalendarAction({
        storedNextRunAt: (flow.next_run_at as string | null) ?? null,
        recomputed,
        now,
      })

      // 'noop' — stored value already matches reality; nothing to write.
      if (action === 'noop') continue

      // Every write is CAS-guarded on the value we read (the double-fire /
      // double-write guard under overlapping ticks).
      const won = await casNextRunAt(supabase, flow, advanceTo)
      if (won === 'error') {
        errored += 1
        continue
      }
      if (won === 'lost') {
        lost += 1
        continue
      }

      if (action === 'fire') {
        // CAS won → this tick owns the fire. Advancing to `advanceTo` (the next
        // occurrence, or null) already happened; now dispatch, rolling back if
        // the emit fails so the fire isn't silently lost.
        if (await emitDueAfterCas(supabase, flow, advanceTo)) fired += 1
        else errored += 1
      } else if (action === 're-anchor') {
        reanchored += 1
      } else {
        dormant += 1
      }
    } catch (err) {
      errored += 1
      console.error(
        `[flow-schedule cron] calendar fire/re-anchor failed for flow ${flow.id}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }

  return { scanned: flows?.length ?? 0, fired, reanchored, dormant, lost, errored }
}

// ──────────────────────────────────────────────────────────────────
// Shared helpers.
// ──────────────────────────────────────────────────────────────────

interface DueFlow {
  id: string
  workspace_id: string
  next_run_at: string | null
}

/**
 * Compare-and-set flow.next_run_at from the value we read (`flow.next_run_at`)
 * to `next`. Returns 'set' (we won), 'lost' (another tick moved it first), or
 * 'error'. The `.eq('next_run_at', seen)` — including the NULL case via `.is` —
 * is the double-fire / double-write guard.
 */
async function casNextRunAt(
  supabase: ReturnType<typeof getServiceClient>,
  flow: DueFlow,
  next: string | null,
): Promise<'set' | 'lost' | 'error'> {
  let query = supabase
    .from('flow')
    .update({ next_run_at: next })
    .eq('id', flow.id)
    .eq('workspace_id', flow.workspace_id)
  // Match the exact value we read so overlapping ticks can't both win.
  query = flow.next_run_at === null
    ? query.is('next_run_at', null)
    : query.eq('next_run_at', flow.next_run_at)

  const { data: won, error } = await query.select('id')
  if (error) {
    console.error(`[flow-schedule cron] CAS failed for flow ${flow.id}:`, error.message)
    return 'error'
  }
  return won && won.length > 0 ? 'set' : 'lost'
}

/**
 * Emit the dispatch event for a won fire, ROLLING BACK the just-advanced
 * next_run_at if the emit fails.
 *
 * Ordering matters: the CAS-forward MUST happen before the emit (it's the
 * double-fire guard — only the CAS winner may emit). But that leaves a hole: if
 * inngest.send() throws AFTER the CAS advanced next_run_at past the fire time,
 * the flow is no longer due and the fire is silently lost forever (the next
 * tick sees a future next_run_at → noop). So on emit failure we CAS the
 * next_run_at back to the pre-fire value, guarded on the value we advanced TO
 * (`advancedTo`) so a concurrent re-anchor isn't clobbered — the flow becomes
 * due again and the next tick retries the fire.
 *
 * Returns true iff the event was emitted (the fire counts). On a failed emit +
 * successful rollback, returns false (caller counts it as errored, not fired).
 */
async function emitDueAfterCas(
  supabase: ReturnType<typeof getServiceClient>,
  flow: DueFlow,
  advancedTo: string | null,
): Promise<boolean> {
  try {
    await inngest.send({
      name: 'flow/schedule.due',
      data: {
        flow_id: flow.id,
        workspace_id: flow.workspace_id,
        scheduled_for: flow.next_run_at,
      },
    })
    return true
  } catch (err) {
    console.error(
      `[flow-schedule cron] emit failed for flow ${flow.id}, rolling next_run_at back:`,
      err instanceof Error ? err.message : err,
    )
    // Roll back to the pre-fire due value so the flow is retried. Guard on the
    // value we advanced to so we only undo OUR advance (never a concurrent
    // re-anchor / edit). Best-effort: if the rollback itself fails or loses the
    // race, we log and move on — the flow will be re-anchored by a later pass.
    const rollbackFlow: DueFlow = {
      id: flow.id,
      workspace_id: flow.workspace_id,
      next_run_at: advancedTo,
    }
    const rolled = await casNextRunAt(supabase, rollbackFlow, flow.next_run_at)
    if (rolled !== 'set') {
      console.error(
        `[flow-schedule cron] rollback CAS ${rolled} for flow ${flow.id} (advancedTo=${advancedTo}); fire may be delayed until re-anchor`,
      )
    }
    return false
  }
}
