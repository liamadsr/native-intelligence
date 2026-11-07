/**
 * The meeting-soon producer (A6 slices 1 and 3), run every 5 minutes by an
 * Inngest cron (src/lib/inngest/agent-events.ts agentEventMeetingSoon) beside
 * the meeting prep, over the same calendar read (./upcoming-meetings.ts: the
 * person's calendar events, the desktop's local ones and any pending capture).
 *
 * ONE HEADS-UP PER MEETING OCCURRENCE (PROD audit, 2026-10-15). Each meeting
 * starting within the next 30 minutes with someone else in it (or a prep of
 * its own) gets one `meeting.soon` row, expiring at the start, which the
 * router turns into one "starts in N min" notice (router.ts), with or without
 * prep:
 *   • its prep is ready → the "prep ready" row (`…:<start>:prep`), the notice
 *     saying the prep is ready;
 *   • a prep is coming (one is working, or the pass just started or will
 *     retry one) → nothing yet: the heads-up waits for the prep, until
 *     PREP_HOLD_MS before the start, then goes out plain (`…:<start>`);
 *   • no prep is coming (one first seen under 5 minutes ahead, a prep that
 *     failed or was refused, an event with only the person's guests on it,
 *     or one Jev's meeting.needs_prep check skipped: a lunch, a drive) → the
 *     plain row now, never held for a prep that won't come. Internal
 *     meetings get a (lighter) prep too since 2026-10-17, so they wait for it
 *     like the rest; a solo block gets neither prep nor heads-up.
 * Before, a meeting without prep was routed quiet (no heads-up at all: one
 * person got none for their 7 meetings while local events had no prep), and
 * a prep finishing later wrote a second row and retired the first.
 *
 * A prep that finishes after its plain heads-up went out still lands its
 * "prep ready" row (from the next pass, or at once from the recorder through
 * recordPrepReadyForRun, which needs the plain row for its title): a second
 * notice, saying the prep is now ready. A plain row nobody was told about yet
 * (still `new`, or routed quiet while paused or dormant) is retired then; one
 * that notified is left as it is.
 *
 * "Prep ready": the meeting's prep helper (meeting-prep.ts, found by its
 * idempotency key, prepFireKey) has a work item that finished or waits on
 * review, for every source (a desktop calendar event included).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordAgentEvents, type AgentEventInput, type RecordAgentEventsDeps } from './record'
import { MEETING_SOON_WINDOW_MS, agentEventKey, type AgentEventFacts } from './types'
import type { MeetingPerson, UpcomingMeeting } from './upcoming-meetings'

/** The idempotency key's scope for a meeting prep (startServerHelper). */
export const PREP_SCOPE = 'meeting-prep'
/** The call part: the meeting's start, so a rescheduled meeting is a new prep. */
export function prepCallId(startIso: string): string {
  return `prep-${Date.parse(startIso)}`
}
/**
 * The agent_run.fire_key start_chat_helper gives a meeting's prep (migrations
 * 332/337: `chat-helper:<conversation>:session:<scope>:turn:<subject>:call:<call>`,
 * the subject being the meeting key). Pure.
 */
export function prepFireKey(conversationId: string, m: Pick<UpcomingMeeting, 'meetingKey' | 'startIso'>): string {
  return `chat-helper:${conversationId}:session:${PREP_SCOPE}:turn:${m.meetingKey}:call:${prepCallId(m.startIso)}`
}
/** The meeting key and start (ms) a prep's fire key names, or null. Pure. */
export function parsePrepFireKey(fireKey: unknown): { meetingKey: string; startMs: number } | null {
  if (typeof fireKey !== 'string') return null
  const m = /:session:meeting-prep:turn:([0-9a-f]{40}):call:prep-([0-9]{1,15})$/.exec(fireKey)
  if (!m) return null
  const startMs = Number(m[2])
  return Number.isSafeInteger(startMs) ? { meetingKey: m[1], startMs } : null
}

/**
 * A heads-up waits for a coming prep until this close to the start, then goes
 * out plain ("starts in 15 min"): things change up to about 15 minutes before
 * a call (Liam, 2026-10-15), and a prep usually takes a minute or two.
 */
export const PREP_HOLD_MS = 15 * 60_000

/** A ledger row in one of these is a prep that is ready. */
const PREP_READY_STATUSES: ReadonlySet<string> = new Set(['done', 'needs_review'])
/** A run in one of these is a prep that won't become ready (not started again for that start). */
const PREP_DEAD_STATUSES: ReadonlySet<string> = new Set(['failed', 'canceled', 'canceling'])

export interface PrepStatus {
  /** A prep run exists for this meeting and start. */
  exists: boolean
  ready: boolean
  /** It failed or was stopped. */
  dead: boolean
}

/**
 * Each meeting's prep, by its idempotency key (meetingKey → status). A failed
 * read knows of no prep (the meeting is still an event; a prep start would be
 * the RPC's own idempotent call). Never throws.
 */
export async function prepStatusFor(
  supabase: SupabaseClient,
  person: Pick<MeetingPerson, 'workspaceId' | 'conversationId'>,
  meetings: readonly Pick<UpcomingMeeting, 'meetingKey' | 'startIso'>[],
): Promise<Map<string, PrepStatus>> {
  const out = new Map<string, PrepStatus>()
  if (!meetings.length) return out
  try {
    const byKey = new Map(meetings.map((m) => [prepFireKey(person.conversationId, m), m.meetingKey]))
    const { data: runs, error } = await supabase
      .from('agent_run')
      .select('id, status, fire_key')
      .eq('workspace_id', person.workspaceId)
      .in('fire_key', [...byKey.keys()])
    if (error) return out
    const runRows = (runs as Array<{ id?: unknown; status?: unknown; fire_key?: unknown }> | null) ?? []
    if (!runRows.length) return out
    const { data: jobs, error: jobError } = await supabase
      .from('tracked_job')
      .select('agent_run_id, status')
      .in('agent_run_id', runRows.map((r) => r.id as string))
    const jobStatus = new Map(jobError ? [] : ((jobs as Array<{ agent_run_id?: unknown; status?: unknown }> | null) ?? []).map((j) => [j.agent_run_id, j.status]))
    for (const r of runRows) {
      const key = byKey.get(r.fire_key as string)
      if (!key) continue
      const job = jobStatus.get(r.id)
      out.set(key, {
        exists: true,
        ready: typeof job === 'string' && PREP_READY_STATUSES.has(job),
        dead: (typeof r.status === 'string' && PREP_DEAD_STATUSES.has(r.status)) || job === 'failed' || job === 'canceled',
      })
    }
  } catch {
    // No prep known.
  }
  return out
}

export interface MeetingSoonCandidate {
  ref: UpcomingMeeting['ref']
  id: string
  meetingKey: string
  workspaceId: string
  userId: string
  title: string | null
  startIso: string
  prepReady: boolean
  captureId?: string | null
  /** Jev's check skipped its prep for this start: said on the row, so the skip sticks. */
  prepSkipped?: boolean
}

/**
 * The heads-ups due now: the meetings in `meetings` that start in
 * (now, now + 30 min] with someone else in it (two attendees or more, or a
 * pending capture) or with a prep of their own (a run `prep` knows, or one
 * `coming` names: the prep's audience check counts someone the attendee count
 * can miss, so its "prep ready" never goes unsaid), with whether their prep is
 * ready. A meeting whose prep is coming (`prep` knows a run that is neither
 * ready nor dead, or `coming` names it: this pass started one or will retry
 * it) waits until PREP_HOLD_MS before its start, then is due plain. A
 * meeting whose prep Jev's check skipped (`skipped`: it had someone else
 * invited, by the prep's own audience check) is due plain at once, its row
 * marked `prepSkipped` so the skip sticks for the next passes. Pure.
 */
export function meetingsStartingSoon(
  meetings: readonly UpcomingMeeting[],
  prep: ReadonlyMap<string, PrepStatus>,
  nowMs: number,
  coming: ReadonlySet<string> = new Set(),
  skipped: ReadonlySet<string> = new Set(),
): MeetingSoonCandidate[] {
  return meetings
    .filter((m) => {
      const start = Date.parse(m.startIso)
      const p = prep.get(m.meetingKey)
      const someoneElse = m.ref === 'capture' || m.attendees.length >= 2 || p?.exists === true || coming.has(m.meetingKey) || skipped.has(m.meetingKey)
      if (!(start > nowMs && start - nowMs <= MEETING_SOON_WINDOW_MS && someoneElse)) return false
      if (p?.ready) return true
      const prepComing = (p?.exists === true && !p.dead) || coming.has(m.meetingKey)
      return !prepComing || start - nowMs <= PREP_HOLD_MS
    })
    .map((m) => ({
      ref: m.ref,
      id: m.id,
      meetingKey: m.meetingKey,
      workspaceId: m.workspaceId,
      userId: m.userId,
      title: m.title,
      startIso: m.startIso,
      prepReady: prep.get(m.meetingKey)?.ready === true,
      captureId: m.captureId,
      ...(skipped.has(m.meetingKey) ? { prepSkipped: true } : {}),
    }))
}

/**
 * The meetings (of these) whose prep Jev's check already skipped for their
 * current start: their plain heads-up row says `prepSkipped` (meetingKey →
 * yes). A skip sticks per meeting and start: a rescheduled meeting is a new
 * row, asked again. A failed read knows of none (the meeting is asked again,
 * as a first answer). Never throws.
 */
export async function recordedPrepSkips(
  supabase: SupabaseClient,
  person: Pick<MeetingPerson, 'workspaceId' | 'userId'>,
  meetings: readonly Pick<UpcomingMeeting, 'meetingKey' | 'startIso'>[],
): Promise<Set<string>> {
  const out = new Set<string>()
  if (!meetings.length) return out
  try {
    const byKey = new Map(meetings.map((m) => [agentEventKey.meetingSoon(m.meetingKey, m.startIso, false), m.meetingKey]))
    const { data, error } = await supabase
      .from('agent_event')
      .select('dedupe_key, facts')
      .eq('workspace_id', person.workspaceId)
      .eq('user_id', person.userId)
      .in('dedupe_key', [...byKey.keys()])
    if (error) return out
    for (const row of (data as Array<{ dedupe_key?: unknown; facts?: AgentEventFacts | null }> | null) ?? []) {
      const key = typeof row.dedupe_key === 'string' ? byKey.get(row.dedupe_key) : undefined
      if (key && row.facts?.prepSkipped === true) out.add(key)
    }
  } catch {
    // None known: asked again.
  }
  return out
}

/** The event a meeting starting soon is (its prep-ready twin when `prepReady`). Pure. */
export function meetingSoonEvent(m: MeetingSoonCandidate): AgentEventInput {
  const refIsCapture = m.ref === 'capture' || !!m.captureId
  return {
    workspaceId: m.workspaceId,
    userId: m.userId,
    kind: 'meeting.soon',
    priority: 2,
    occursAt: m.startIso,
    expiresAt: m.startIso,
    // The notice deep-links the capture when one stands for the meeting.
    refType: refIsCapture ? 'capture' : m.ref,
    refId: refIsCapture ? (m.captureId ?? m.id) : m.id,
    facts: { title: m.title ?? 'Untitled meeting', prepReady: m.prepReady, meetingRef: m.ref, prepKey: m.meetingKey, ...(m.prepSkipped ? { prepSkipped: true } : {}) },
    dedupeKey: agentEventKey.meetingSoon(m.meetingKey, m.startIso, m.prepReady),
  }
}

/**
 * Retire the plain row of meetings whose "prep ready" row now exists (state
 * expired, fenced on not delivered and on nobody told yet: still `new`, or
 * routed quiet), so the meeting is said once. A plain row that notified stays
 * as it was (its notice is a fact). Never throws.
 */
export async function retireNoPrepRows(
  supabase: SupabaseClient,
  rows: ReadonlyArray<{ workspaceId: string; userId: string; meetingKey: string; startIso: string }>,
): Promise<void> {
  for (const r of rows) {
    try {
      const retire = () =>
        supabase
          .from('agent_event')
          .update({ state: 'expired', outcome: 'ignore', routed_at: new Date().toISOString() })
          .eq('workspace_id', r.workspaceId)
          .eq('user_id', r.userId)
          .eq('dedupe_key', agentEventKey.meetingSoon(r.meetingKey, r.startIso, false))
          .is('delivered_at', null)
      await retire().eq('state', 'new')
      await retire().eq('state', 'routed').eq('outcome', 'quiet')
    } catch {
      // It expires at the start anyway.
    }
  }
}

/**
 * Record the meeting-soon events for these candidates (and retire the "no
 * prep" rows a "prep ready" one replaces). Returns how many rows newly
 * landed. Never throws.
 */
export async function recordMeetingsSoon(
  supabase: SupabaseClient,
  candidates: readonly MeetingSoonCandidate[],
  deps: RecordAgentEventsDeps = {},
): Promise<number> {
  if (!candidates.length) return 0
  const landed = await recordAgentEvents(candidates.map(meetingSoonEvent), supabase, deps)
  await retireNoPrepRows(supabase, candidates.filter((c) => c.prepReady))
  return landed
}

/**
 * A meeting prep just became ready (its work item reached review or done):
 * if its meeting starts within the next 30 minutes and its plain heads-up
 * already went out (the prep ran past PREP_HOLD_MS), record the "prep ready"
 * row now rather than at the next pass, from that plain row (its title and
 * pointer). Nothing when the run isn't a meeting prep, the meeting is further
 * out or already started, or has no row yet: the usual case, a heads-up
 * waiting for its prep, which the next pass (within 5 minutes) records ready.
 * Never throws.
 */
export async function recordPrepReadyForRun(
  supabase: SupabaseClient,
  args: { workspaceId: string; agentRunId: string; nowMs?: number },
  deps: RecordAgentEventsDeps = {},
): Promise<boolean> {
  try {
    const nowMs = args.nowMs ?? Date.now()
    const { data: run, error } = await supabase
      .from('agent_run')
      .select('server_helper, fire_key, triggered_by')
      .eq('id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    if (error || !run) return false
    const r = run as { server_helper?: unknown; fire_key?: unknown; triggered_by?: unknown }
    if (r.server_helper !== 'meeting_prep' || typeof r.triggered_by !== 'string') return false
    const parsed = parsePrepFireKey(r.fire_key)
    if (!parsed) return false
    if (parsed.startMs <= nowMs || parsed.startMs - nowMs > MEETING_SOON_WINDOW_MS) return false
    const startIso = new Date(parsed.startMs).toISOString()
    const { data: base, error: baseError } = await supabase
      .from('agent_event')
      .select('ref_type, ref_id, facts')
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', r.triggered_by)
      .eq('dedupe_key', agentEventKey.meetingSoon(parsed.meetingKey, startIso, false))
      .maybeSingle()
    if (baseError || !base) return false
    const b = base as { ref_type?: unknown; ref_id?: unknown; facts?: AgentEventFacts | null }
    const facts = b.facts ?? {}
    const landed = await recordAgentEvents(
      [
        {
          workspaceId: args.workspaceId,
          userId: r.triggered_by,
          kind: 'meeting.soon',
          priority: 2,
          occursAt: startIso,
          expiresAt: startIso,
          refType: typeof b.ref_type === 'string' ? b.ref_type : null,
          refId: typeof b.ref_id === 'string' ? b.ref_id : null,
          facts: { ...facts, prepReady: true, prepKey: parsed.meetingKey },
          dedupeKey: agentEventKey.meetingSoon(parsed.meetingKey, startIso, true),
        },
      ],
      supabase,
      deps,
    )
    await retireNoPrepRows(supabase, [{ workspaceId: args.workspaceId, userId: r.triggered_by, meetingKey: parsed.meetingKey, startIso }])
    return landed > 0
  } catch (err) {
    console.warn('[meeting-soon] prep-ready record skipped:', err instanceof Error ? err.message : err)
    return false
  }
}
