/**
 * One person's meeting pass (A6 slices 1, 3 and 5), run every 5 minutes by
 * the Inngest cron (src/lib/inngest/agent-events.ts agentEventMeetingSoon)
 * for everyone with a home thread:
 *
 *   1. a paused workspace (the kill switch, failing closed) or a dormant one
 *      → nothing (no calendar read at all);
 *   2. one calendar read for the next 24 hours (./upcoming-meetings.ts
 *      readMeetingWindow): the meeting-changes watch (./meeting-changes.ts:
 *      a meeting cancelled, gone or moved → a `meeting.changed` event) sees
 *      all of it; the steps below see only the next 30 minutes of it;
 *   3. each meeting's prep, by its idempotency key (meeting-soon.ts
 *      prepStatusFor);
 *   4. meetings in (5 min, 30 min] with someone else invited (not the
 *      person's guests: their People tab's calendar addresses, read once per
 *      pass) and no prep → Jev's check (meeting-prep.ts prepNeeded,
 *      meeting.needs_prep: a lunch or a drive is skipped, 'not_needed', and
 *      takes no slot), then a prep helper each (the full prep when someone
 *      from outside is invited, the lighter one for an internal meeting; none
 *      for a solo block or a guests-only event), past the kill switch (fail
 *      closed), so each prep lands about 30 minutes before its meeting. At
 *      most one start attempt per person per pass (one prep works at a
 *      time): their zone is read once, and once a prep starts, or the slot is
 *      busy (SERVER_LIVE), the rest are 'deferred' to the next pass, unasked,
 *      and count as coming;
 *   5. the heads-ups due (meeting-soon.ts): one `meeting.soon` row per
 *      meeting within 30 minutes, "prep ready" when it is, plain when no prep
 *      is coming; one whose prep is coming (step 4 started it or will retry
 *      it, or one is working) waits for it, until 15 minutes before.
 *
 * Never throws: a failed step leaves the meeting for the next pass.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentPausedState } from '@/lib/work/agent-paused'
import { trustedGuestEmails } from '@/lib/guests/store'
import type { RecordAgentEventsDeps } from './record'
import { meetingsStartingSoon, prepStatusFor, recordMeetingsSoon, recordedPrepSkips } from './meeting-soon'
import {
  PREP_LEAD_MS,
  inPrepWindow,
  meetingsNeedingPrep,
  prepCheckLine,
  prepNeeded,
  startMeetingPrep,
  type DecidePrepNeed,
  type PrepStartDeps,
  type PrepStartResult,
} from './meeting-prep'
import { readMemberTimeZone } from './member-time-zone'
import { MEETING_WATCH_WINDOW_MS, watchMeetingChanges } from './meeting-changes'
import { meetingAttendance, readMeetingWindow, type MeetingPerson, type UpcomingMeetingDeps } from './upcoming-meetings'

export interface MeetingPassDeps extends Omit<PrepStartDeps, 'pausedState' | 'isDormant'> {
  pausedState: (supabase: SupabaseClient, workspaceId: string) => Promise<AgentPausedState>
  isDormant: (supabase: SupabaseClient, workspaceId: string) => Promise<boolean>
  listAccount?: UpcomingMeetingDeps['listAccount']
  memberEmails?: (workspaceId: string, emails: string[]) => Promise<Set<string>>
  /** The person's guests' calendar addresses (default: trustedGuestEmails, on this service client). */
  trustedGuests?: (supabase: SupabaseClient, ownerUserId: string) => Promise<Set<string>>
  /** Jev's meeting.needs_prep (default: runDecision, live); tests pass a stub. */
  decidePrep?: DecidePrepNeed
  record?: RecordAgentEventsDeps
  /** The person's zone, read once per pass (default: readMemberTimeZone; UTC as the last fallback). */
  personTimeZone?: (supabase: SupabaseClient, person: MeetingPerson) => Promise<string>
  /** The meeting-changes watch (default: watchMeetingChanges); tests pass a stub. */
  watchChanges?: typeof watchMeetingChanges
}

export interface MeetingPassResult {
  meetings: number
  soon: number
  recorded: number
  /** `meeting.changed` events that newly landed. */
  changed?: number
  preps: PrepStartResult[]
  skipped?: 'dormant' | 'paused'
}

/** Run `fn` over `items`, at most `limit` at a time, results in order. Never rejects for one item (fn must not throw). */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker))
  return out
}

/** A per-pass memo: one read per workspace for a gate that every person of it shares. */
export function perWorkspace<T>(read: (supabase: SupabaseClient, workspaceId: string) => Promise<T>): (supabase: SupabaseClient, workspaceId: string) => Promise<T> {
  const seen = new Map<string, Promise<T>>()
  return (supabase, workspaceId) => {
    let p = seen.get(workspaceId)
    if (!p) {
      p = read(supabase, workspaceId)
      seen.set(workspaceId, p)
    }
    return p
  }
}

/**
 * A prep start that means a prep is coming for the meeting (internal or
 * external alike): started, queued or the same run again (not one that
 * failed), refused only because another prep is working (one at a time: the
 * next pass retries it), deferred to the next pass for the same reason, or a
 * CALL_ID_CONFLICT whose run couldn't be read (a run holds the key). Any
 * other refusal (usage, autonomy, a SERVER_DAY_BUDGET from a database still
 * without migration 355) is no prep coming: the plain heads-up goes out now.
 * Pure.
 */
export function prepIsComing(r: PrepStartResult): boolean {
  if (r.status !== 'skipped') return true
  if (r.reason === 'deferred') return true
  return r.reason === 'refused' && (r.code === 'SERVER_LIVE' || r.code === 'CALL_ID_CONFLICT')
}

/** The person's one prep slot is taken after this result: no more starts for them this pass. Pure. */
function slotTaken(r: PrepStartResult): boolean {
  return r.status === 'started' || r.status === 'queued' || (r.status === 'skipped' && r.reason === 'refused' && r.code === 'SERVER_LIVE')
}

async function defaultPersonTimeZone(supabase: SupabaseClient, person: MeetingPerson): Promise<string> {
  return (await readMemberTimeZone(supabase, person)).timeZone
}

/** One person's pass (see the header). Never throws. */
export async function meetingPassFor(
  supabase: SupabaseClient,
  person: MeetingPerson,
  deps: MeetingPassDeps,
  nowMs: number = Date.now(),
): Promise<MeetingPassResult> {
  const result: MeetingPassResult = { meetings: 0, soon: 0, recorded: 0, preps: [] }
  try {
    // Paused: no notice would go out and no prep may start, so nothing is read.
    if ((await deps.pausedState(supabase, person.workspaceId).catch(() => 'unknown' as const)) !== 'active') return { ...result, skipped: 'paused' }
    if (await deps.isDormant(supabase, person.workspaceId).catch(() => false)) return { ...result, skipped: 'dormant' }
    // A `text` read: each event's place and words kept, for prep's check (still timed events only).
    const window = await readMeetingWindow(
      supabase,
      person,
      { fromMs: nowMs, toMs: nowMs + MEETING_WATCH_WINDOW_MS },
      { nowMs, ...(deps.listAccount ? { listAccount: deps.listAccount } : {}) },
      { text: true },
    )
    const changed = await (deps.watchChanges ?? watchMeetingChanges)(supabase, person, window, { ...(deps.record ? { record: deps.record } : {}) }, nowMs)
    if (changed) result.changed = changed
    // Prep and heads-ups: the next 30 minutes only (the read is oldest first, so the cap never cuts them).
    const meetings = window.meetings.filter((m) => Date.parse(m.startIso) <= nowMs + PREP_LEAD_MS)
    result.meetings = meetings.length
    if (!meetings.length) return result
    const prep = await prepStatusFor(supabase, person, meetings)

    // Only the meetings that could still get a prep (none yet, in its window) need the attendee check.
    const open = meetings.filter((m) => !prep.get(m.meetingKey)?.exists && inPrepWindow(m.startIso, nowMs))
    // The person's guests aren't "other people": an event with only them on it gets no prep. Read
    // once, and only when one of these meetings invites someone besides the person (meetingAttendance).
    const readTrusted = () => (deps.trustedGuests ?? trustedGuestEmails)(supabase, person.userId)
    const attendance = await meetingAttendance(supabase, person, open, { ...(deps.memberEmails ? { memberEmails: deps.memberEmails } : {}), trusted: readTrusted })
    const audiences = new Map([...attendance].map(([key, a]) => [key, a.audience]))
    const coming = new Set<string>()
    const skipped = new Set<string>()
    const candidates = meetingsNeedingPrep(person, open, audiences, prep, nowMs)
    // Read once per pass, and only when there is something to prep.
    const zone = candidates.length
      ? await (deps.personTimeZone ?? defaultPersonTimeZone)(supabase, person).catch(() => 'UTC')
      : 'UTC'
    // A skip sticks per meeting and start: its plain heads-up row says so (meeting-prep.ts header).
    const recordedSkips = candidates.length ? await recordedPrepSkips(supabase, person, candidates) : new Set<string>()
    let taken = false
    for (const c of candidates) {
      // One prep works at a time: once the slot is taken, the rest wait for the next pass (no RPC, no reads, no check).
      if (taken) {
        result.preps.push({ status: 'skipped', reason: 'deferred' })
        coming.add(c.meetingKey)
        continue
      }
      // Skipped on an earlier pass for this start: still skipped, never asked again (a later check that fails can't start it).
      if (recordedSkips.has(c.meetingKey)) {
        console.info(prepCheckLine(c, 'skip', 'recorded'))
        result.preps.push({ status: 'skipped', reason: 'not_needed' })
        skipped.add(c.meetingKey)
        continue
      }
      // Jev's check (live): a skip starts nothing, takes no slot, and leaves the meeting its plain heads-up.
      if ((await prepNeeded(c, attendance.get(c.meetingKey), zone, deps.decidePrep)) === 'skip') {
        result.preps.push({ status: 'skipped', reason: 'not_needed' })
        skipped.add(c.meetingKey)
        continue
      }
      const started = await startMeetingPrep(supabase, c, {
        pausedState: deps.pausedState,
        isDormant: deps.isDormant,
        startHelper: deps.startHelper,
        timeZone: async () => zone,
        ...(deps.send ? { send: deps.send } : {}),
      })
      result.preps.push(started)
      if (slotTaken(started)) taken = true
      if (prepIsComing(started)) coming.add(c.meetingKey)
    }

    // One heads-up per meeting: a meeting whose prep is coming waits for it; a skipped one goes plain now, marked skipped.
    const soon = meetingsStartingSoon(meetings, prep, nowMs, coming, skipped)
    result.soon = soon.length
    if (soon.length) result.recorded = await recordMeetingsSoon(supabase, soon, deps.record ?? {})
  } catch (err) {
    console.warn('[meeting-pass] skipped:', err instanceof Error ? err.message : err)
  }
  return result
}
