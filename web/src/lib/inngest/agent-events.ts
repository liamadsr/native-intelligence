import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import { findUnroutedPeople, recordAgentEvents } from '@/lib/agent-events/record'
import { routeAgentEvents, routerLogLine } from '@/lib/agent-events/router'
import { defaultRouterDeps } from '@/lib/agent-events/router-deps'
import { AGENT_EVENT_CREATED, agentEventKey, type AgentEventCreatedData } from '@/lib/agent-events/types'
import { DIGEST_LOCAL_HOUR, digestLogLine, findDigestCandidates, planDigestFor, type DigestCandidate, type DigestRequest, type DigestSkip } from '@/lib/agent-events/digest'
import { CHECK_IN_SLOTS, isCheckInSlot } from '@/lib/chat/home-turn'
import { lookAheadSlotAt } from '@/lib/look-ahead/candidates'
import { LOOK_AHEAD_SLOT_HOURS, lookAheadPlanLogLine, planLookAheadFor, type LookAheadRequest, type LookAheadSkip } from '@/lib/look-ahead/run'
import { checkInLogLine, planCheckInFor, type CheckInRequest, type CheckInSkip } from '@/lib/now/check-in'
import { prepLogLine, type PrepStartResult } from '@/lib/agent-events/meeting-prep'
import { MEETING_PEOPLE_PAGE, MEETING_PEOPLE_PAGES, findMeetingPeople, type MeetingPerson } from '@/lib/agent-events/upcoming-meetings'
import { mapPool, meetingPassFor, perWorkspace, type MeetingPassResult } from '@/lib/agent-events/meeting-pass'
import { captureLiveFollowups } from '@/lib/agent-events/live-followups'
import { isFirstRunCapture } from '@/lib/onboarding/getting-started'
import { readAgentPausedState, routerPaused } from '@/lib/work/agent-paused'
import { workspaceIsDormant } from './flow-functions'
import { startServerHelper } from '@/lib/chat/start-helper'
import { autoArchiveRequest } from './email-auto-archive'

/** People planned per digest step (each takes a few small reads). */
export const DIGEST_PLAN_CHUNK = 50
/** At most this many people per digest pass (the rest are skipped this hour). */
export const DIGEST_MAX_PEOPLE = 2000
/** A digest skip that also stops the morning tidy: nowhere to say it, or the agent may not act. */
const TIDY_SKIPS: ReadonlySet<DigestSkip> = new Set(['no_home_thread', 'paused', 'dormant'])

/**
 * The agent's inbox on Inngest (A6 slices 1 and 3; migration 336,
 * src/lib/agent-events/*):
 *   • agentEventCaptureProcessed: flow/capture.processed → one
 *     `capture.processed` event for the capture's owner;
 *   • agentEventMeetingSoon: every 5 minutes, for everyone with a home
 *     thread, one calendar read of the next 30 minutes
 *     (agent-events/meeting-pass.ts): a `meeting.soon` event per meeting
 *     starting within 30 minutes ("prep ready" its own row), and a background
 *     prep helper for each meeting starting in 5 to 30 minutes with someone
 *     else invited and no prep (the full prep with someone from outside, a
 *     lighter one for an internal meeting, none for a solo block; no daily
 *     cap, migration 355), so prep lands about 30 minutes before the
 *     meeting; then a sweep that wakes the router for anyone with rows
 *     left `new` for over 5 minutes;
 *   • agentEventRoute: agent/event.created → (debounced 60 s per person, one
 *     pass at a time) → the router;
 *   • agentEventDigest (slice 4): hourly, the daily digest for everyone whose
 *     local hour is 8 → home/turn.requested (reason 'digest'), and beside it
 *     the morning tidy's request (./email-auto-archive.ts); and, from the
 *     same scan, the Now file's check-in at 10, 12, 14 and 16 local when
 *     something it tracks is due (reason 'check_in').
 */

/** People per meeting step (each takes one calendar read and a few small reads). */
export const MEETING_PASS_CHUNK = 25
/** People read at once inside a step. */
export const MEETING_PASS_POOL = 5

/**
 * flow/capture.processed → one `capture.processed` event in the capture
 * OWNER's inbox, beside the "Meeting processed" log line
 * (agent-log-capture.ts), with the same skips: a reconciler re-fire, a demo
 * or archived capture, an ownerless row. The dedupe key (one per capture)
 * makes a reprocess a no-op. A read that fails throws inside its step, so
 * Inngest retries it.
 *
 * The live chat → main agent bridge: the live agent's chat (now in the HUD)
 * goes away with the call, so the event carries what it left open, as counts
 * (agent-events/live-followups.ts): its questions nobody answered and the
 * proposals it staged that still wait. With either, the router makes it a
 * home turn, so the main agent picks them up after the call. So does an
 * owner's first capture while getting started (`firstRun`,
 * docs/plans/getting-started-skill.md): the agent shows them what it pulled out.
 */
export const agentEventCaptureProcessed = inngest.createFunction(
  {
    id: 'agent-event-capture-processed',
    retries: 2,
    triggers: [{ event: 'flow/capture.processed' }],
  },
  async ({ event, step }) => {
    const data = event.data as { workspace_id?: string; capture_id?: string; processed_at?: string; reconciled?: boolean }
    if (data.reconciled === true) return { status: 'skipped', reason: 'reconciled_refire' }
    if (!data.workspace_id || !data.capture_id) return { status: 'skipped', reason: 'bad_event' }
    const workspaceId = data.workspace_id
    const captureId = data.capture_id

    const capture = await step.run('load-capture', async () => {
      const { data: row, error } = await getServiceClient()
        .from('captures')
        .select('id, title, user_id, batch_processed_at, metadata, status, is_eval')
        .eq('id', captureId)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (error) throw new Error(`capture read failed: ${error.message}`)
      if (!row) return null
      return {
        title: (row.title as string | null) ?? null,
        userId: (row.user_id as string | null) ?? null,
        processedAt: (row.batch_processed_at as string | null) ?? null,
        isDemo: (row.metadata as { demo?: unknown } | null)?.demo === true,
        isArchived: row.status === 'archived',
        // Eval fixtures never reach the inbox (docs/plans/evals.md §5.2).
        isEval: (row as { is_eval?: unknown }).is_eval === true,
      }
    })
    if (!capture) return { status: 'skipped', reason: 'missing_capture' }
    if (capture.isDemo) return { status: 'skipped', reason: 'demo_capture' }
    if (capture.isEval) return { status: 'skipped', reason: 'eval_capture' }
    if (capture.isArchived) return { status: 'skipped', reason: 'archived_capture' }
    const ownerUserId = capture.userId
    if (!ownerUserId) return { status: 'skipped', reason: 'no_owner' }

    const followups = await step.run('live-followups', () => captureLiveFollowups(getServiceClient(), { workspaceId, captureId }))
    // Its owner's first capture while getting started
    // (docs/plans/getting-started-skill.md): the router makes it a turn. A
    // failed read is false: an ordinary event.
    const firstRun = await step.run('getting-started', () => isFirstRunCapture(getServiceClient(), { workspaceId, userId: ownerUserId, captureId }))
    await step.run('record-event', () =>
      recordAgentEvents([
        {
          workspaceId,
          userId: ownerUserId,
          kind: 'capture.processed',
          priority: 1,
          occursAt: data.processed_at ?? capture.processedAt,
          refType: 'capture',
          refId: captureId,
          facts: { title: capture.title ?? 'Untitled meeting', ...followups, ...(firstRun ? { firstRun: true } : {}) },
          dedupeKey: agentEventKey.captureProcessed(captureId),
        },
      ]),
    )
    return { status: 'recorded', captureId }
  },
)

/**
 * Every 5 minutes, for everyone with a home thread
 * (agent-events/meeting-pass.ts): one calendar read each for the next 30
 * minutes, the meeting-soon rows for what starts within them, and a prep
 * helper for each meeting starting in 5 to 30 minutes with an outsider and no
 * prep yet.
 *
 * WHY A 5-MINUTE SWEEP (not a sleep per meeting): prep should land about 30
 * minutes before each meeting (Liam, 2026-10-15), for the meeting's CURRENT
 * time. Reading the live calendar every pass handles a moved, cancelled or
 * late-added meeting with no per-meeting state to cancel, and the prep's
 * idempotency key (meeting key + start) keeps it to one per occurrence. The
 * cost is flat: one bounded calendar read per person per pass, whatever their
 * day holds, and none for a paused or dormant workspace. Gates read once per
 * workspace per pass. Several passes see a meeting inside its window; the
 * dedupe key writes it once.
 */
export const agentEventMeetingSoon = inngest.createFunction(
  {
    id: 'agent-event-meeting-soon',
    retries: 1,
    // Never two passes at once: a slow pass makes the next tick skip, not pile up.
    singleton: { mode: 'skip' },
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ step }) => {
    const results: MeetingPassResult[] = []
    let people = 0
    // Everyone with a home thread, page by page (never silently cut at a cap
    // short of MEETING_PEOPLE_PAGES pages).
    for (let page = 0; page < MEETING_PEOPLE_PAGES; page++) {
      const batch = (await step.run(`find-people-${page}`, () => findMeetingPeople(getServiceClient(), page))) as MeetingPerson[]
      people += batch.length
      for (let i = 0; i < batch.length; i += MEETING_PASS_CHUNK) {
        const chunk = batch.slice(i, i + MEETING_PASS_CHUNK)
        const out = (await step.run(`meetings-${page}-${i / MEETING_PASS_CHUNK}`, async () => {
          const supabase = getServiceClient()
          const deps = {
            pausedState: perWorkspace(readAgentPausedState),
            isDormant: perWorkspace(dormant),
            startHelper: startServerHelper,
          }
          return mapPool(chunk, MEETING_PASS_POOL, (person) => meetingPassFor(supabase, person, deps))
        })) as MeetingPassResult[]
        results.push(...out)
      }
      if (batch.length < MEETING_PEOPLE_PAGE) break
    }
    const preps: PrepStartResult[] = results.flatMap((r) => r.preps)
    const meetings = results.reduce((n, r) => n + r.meetings, 0)
    const recorded = results.reduce((n, r) => n + r.recorded, 0)
    const changed = results.reduce((n, r) => n + (r.changed ?? 0), 0)
    if (preps.length) console.info(prepLogLine({ meetings, results: preps }))
    if (changed) console.info(`[meeting-changes] ${changed} meeting ${changed === 1 ? 'change' : 'changes'} recorded`)
    // The sweep: people whose rows the router never routed (a lost wake-up) are woken again.
    const unrouted = await step.run('find-unrouted', () => findUnroutedPeople(getServiceClient()))
    if (unrouted.length) {
      await step.sendEvent(
        'wake-router',
        unrouted.map((data) => ({ name: AGENT_EVENT_CREATED, data })),
      )
    }
    return { status: 'done', people, meetings, recorded, preps: preps.length, ...(changed ? { changed } : {}), ...(unrouted.length ? { woken: unrouted.length } : {}) }
  },
)

/**
 * agent/event.created → (debounced 60 s per person; one pass per person at a
 * time) → the router (agent-events/router.ts). The debounce keeps the LAST
 * event, so the pass never trusts its payload for what to route: it reads
 * every `new` row the person has. `timeout` bounds how long a steady stream
 * can hold the pass back. One `[agent-router]` line per pass.
 */
export const agentEventRoute = inngest.createFunction(
  {
    id: 'agent-event-route',
    retries: 2,
    debounce: { key: 'event.data.personKey', period: '60s', timeout: '5m' },
    concurrency: [{ limit: 1, key: 'event.data.personKey' }],
    triggers: [{ event: AGENT_EVENT_CREATED }],
  },
  async ({ event, step }) => {
    const data = event.data as Partial<AgentEventCreatedData>
    if (!data?.workspaceId || !data.userId) return { status: 'skipped', reason: 'bad_event' }
    const person = { workspaceId: data.workspaceId, userId: data.userId }
    const result = await step.run('route', () => routeAgentEvents(getServiceClient(), person, defaultRouterDeps()))
    console.info(routerLogLine(person, result))
    return { status: 'done', ...result }
  },
)

const dormant = (supabase: Parameters<typeof routerPaused>[0], workspaceId: string) =>
  workspaceIsDormant(supabase as Parameters<typeof workspaceIsDormant>[0], workspaceId)

/**
 * Hourly: the daily digest (agent-events/digest.ts) and the Now file's
 * check-in (src/lib/now/check-in.ts), from ONE member scan. Everyone whose
 * stored zone reads 8 o'clock gets one `home/turn.requested` (reason
 * 'digest'), unless they have no home thread, already had today's, autonomy
 * is off, the workspace is dormant or there is nothing to say. Everyone whose
 * zone reads a check-in slot (10, 12, 14 or 16) gets one with reason
 * 'check_in' only when something their note tracks is due (planCheckInFor:
 * every skip in code, no model call). The Inngest event ids
 * (`home-turn-digest:<conversation>:<local date>`,
 * `home-turn-check-in:<conversation>:<local date>:<hour>`) and the home
 * turn's own keys (`digest:<local date>`, `check_in:<local date>:<hour>`) each
 * make a retry send nothing twice.
 *
 * At 19 o'clock local (tomorrow morning) and 8 o'clock (later today), one
 * `look-ahead/requested` per person whose zone is their own
 * (planLookAheadFor, src/lib/look-ahead/run.ts: every skip in code, no model
 * call): the look-ahead (docs/plans/look-ahead-heartbeat.md), run per person
 * by ./look-ahead.ts.
 *
 * Beside the digests, one morning tidy request per person
 * (email/auto-archive.requested, ./email-auto-archive.ts) whatever their
 * digest planned, except where it found no home thread, autonomy off or a
 * dormant workspace: the tidy archives the day's receipts and notifications
 * even on a day with nothing else to say.
 */
export const agentEventDigest = inngest.createFunction(
  {
    id: 'agent-event-digest',
    retries: 1,
    triggers: [{ cron: '0 * * * *' }],
  },
  async ({ step }) => {
    const found = (await step.run('find-candidates', () => findDigestCandidates(getServiceClient(), Date.now(), [...new Set([DIGEST_LOCAL_HOUR, ...CHECK_IN_SLOTS, LOOK_AHEAD_SLOT_HOURS.morning, LOOK_AHEAD_SLOT_HOURS.evening])]))) as DigestCandidate[]
    // The digest's hour first: a pass that hits the cap keeps the digests.
    const candidates = found.filter((c) => (c.hour ?? DIGEST_LOCAL_HOUR) === DIGEST_LOCAL_HOUR).slice(0, DIGEST_MAX_PEOPLE)
    const checkIns = found.filter((c): c is DigestCandidate & { hour: number } => isCheckInSlot(c.hour)).slice(0, DIGEST_MAX_PEOPLE)
    const skips: Partial<Record<DigestSkip, number>> = {}
    const requests: DigestRequest[] = []
    const tidies: Array<ReturnType<typeof autoArchiveRequest>> = []
    for (let i = 0; i < candidates.length; i += DIGEST_PLAN_CHUNK) {
      const chunk = candidates.slice(i, i + DIGEST_PLAN_CHUNK)
      const planned = await step.run(`plan-${i / DIGEST_PLAN_CHUNK}`, async () => {
        const supabase = getServiceClient()
        const out: Array<{ request?: DigestRequest; skip?: DigestSkip }> = []
        for (const c of chunk) {
          const r = await planDigestFor(supabase, c, { pausedState: readAgentPausedState, isDormant: dormant })
          out.push(r.ok ? { request: r.request } : { skip: r.reason })
        }
        return out
      })
      planned.forEach((p, j) => {
        if (p.request) requests.push(p.request as DigestRequest)
        else if (p.skip) skips[p.skip] = (skips[p.skip] ?? 0) + 1
        if (!p.skip || !TIDY_SKIPS.has(p.skip)) tidies.push(autoArchiveRequest(chunk[j]))
      })
    }
    if (requests.length) await step.sendEvent('request-digests', requests)
    if (tidies.length) await step.sendEvent('request-auto-archive', tidies)
    const result = { candidates: candidates.length, sent: requests.length, tidies: tidies.length, skips }
    console.info(digestLogLine(result))

    // The check-ins (docs/plans/now-file.md "The check-in"), each skip in code.
    const checkInSkips: Partial<Record<CheckInSkip, number>> = {}
    const checkInRequests: CheckInRequest[] = []
    for (let i = 0; i < checkIns.length; i += DIGEST_PLAN_CHUNK) {
      const chunk = checkIns.slice(i, i + DIGEST_PLAN_CHUNK)
      const planned = await step.run(`check-in-${i / DIGEST_PLAN_CHUNK}`, async () => {
        const supabase = getServiceClient()
        const out: Array<{ request?: CheckInRequest; skip?: CheckInSkip }> = []
        for (const c of chunk) {
          const r = await planCheckInFor(supabase, c, { pausedState: readAgentPausedState, isDormant: dormant })
          out.push(r.ok ? { request: r.request } : { skip: r.reason })
        }
        return out
      })
      for (const p of planned) {
        if (p.request) checkInRequests.push(p.request as CheckInRequest)
        else if (p.skip) checkInSkips[p.skip] = (checkInSkips[p.skip] ?? 0) + 1
      }
    }
    if (checkInRequests.length) await step.sendEvent('request-check-ins', checkInRequests)
    const checkIn = { candidates: checkIns.length, sent: checkInRequests.length, skips: checkInSkips }
    if (checkIns.length) console.info(checkInLogLine(checkIn))

    // The look-ahead (docs/plans/look-ahead-heartbeat.md): 19:00 for tomorrow morning, 08:00 for later today, each skip in code.
    const lookAheads = found.filter((c) => lookAheadSlotAt(c.hour) !== null).slice(0, DIGEST_MAX_PEOPLE)
    const lookAheadSkips: Partial<Record<LookAheadSkip, number>> = {}
    const lookAheadRequests: LookAheadRequest[] = []
    for (let i = 0; i < lookAheads.length; i += DIGEST_PLAN_CHUNK) {
      const chunk = lookAheads.slice(i, i + DIGEST_PLAN_CHUNK)
      const planned = await step.run(`look-ahead-${i / DIGEST_PLAN_CHUNK}`, async () => {
        const supabase = getServiceClient()
        const out: Array<{ request?: LookAheadRequest; skip?: LookAheadSkip }> = []
        for (const c of chunk) {
          const r = await planLookAheadFor(supabase, c, lookAheadSlotAt(c.hour)!, { pausedState: readAgentPausedState, isDormant: dormant })
          out.push(r.ok ? { request: r.request } : { skip: r.reason })
        }
        return out
      })
      for (const p of planned) {
        if (p.request) lookAheadRequests.push(p.request as LookAheadRequest)
        else if (p.skip) lookAheadSkips[p.skip] = (lookAheadSkips[p.skip] ?? 0) + 1
      }
    }
    if (lookAheadRequests.length) await step.sendEvent('request-look-aheads', lookAheadRequests)
    const lookAhead = { candidates: lookAheads.length, sent: lookAheadRequests.length, skips: lookAheadSkips }
    if (lookAheads.length) console.info(lookAheadPlanLogLine(lookAhead))
    return { status: 'done', ...result, checkIn, lookAhead }
  },
)
