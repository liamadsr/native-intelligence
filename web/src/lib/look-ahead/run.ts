/**
 * The look-ahead, end to end (docs/plans/look-ahead-heartbeat.md §4).
 *
 * THE PLAN (planLookAheadFor, from the hourly member scan at each slot's hour:
 * 19:00 for tomorrow morning, 08:00 for later today; all in code, cheapest
 * first):
 *   • no zone of the person's own (the scan's UTC fallback) → skip: 19:00 UTC
 *     is nobody's evening;
 *   • no home thread → skip (the message has nowhere to land);
 *   • the slot's message already there → skip (once a slot);
 *   • autonomy off (FAILS CLOSED: it spends money) or a dormant workspace →
 *     skip;
 *   • else one `look-ahead/requested` event (Inngest id per person, date and
 *     slot).
 *
 * THE RUN (gatherLookAhead inside ../inngest/look-ahead.ts, one per person):
 *   1. read the slot's span of the calendar (a `details` read: all-day
 *      events, places and descriptions) and the person's guests' addresses
 *      (trustedGuestEmails: their invites count as the person's own), and
 *      pick the candidates (./candidates.ts);
 *   2. SHADOW (only when LOOK_AHEAD_LIVE turns it off, see below): log how
 *      many candidates and why, and stop. No mail is read and no model runs;
 *   3. LIVE: the mail behind each candidate, and booking mail that names the
 *      span's date with no calendar item (Slice 4); with none of either,
 *      nothing. Then ONE model call and the checks (./facts.ts), all in one
 *      step that returns only the lines (no mail text in the step's stored
 *      output); a failed call goes out on the calendar alone;
 *   4. Dial8's template over them: the message, log line and notice
 *      (deliverLookAhead: the gather and the write in one call, whose result
 *      holds only the row and the departures' calendar keys, so no mail-derived
 *      words sit in a stored step output), then a text when their phone takes
 *      alert texts, outside quiet hours, read back from the row (./message.ts,
 *      Slice 2);
 *   5. each departure of their own in it (a flight, a train) gets a heads-up
 *      about 3 hours before (Slice 3), unless that falls in quiet hours (the
 *      evening's message already said it): a delayed `look-ahead/travel.due`
 *      event that reads the calendar again when it fires, so a moved or
 *      cancelled trip says nothing.
 *
 * WHO IS LIVE. Everyone, out of the box (Liam, 10-28: "that should just
 * work out of the box", no opt-in; the text rides the alert-text consent the
 * person already gave). `LOOK_AHEAD_LIVE` is only a switch: `off` (or
 * `shadow`) counts without sending for everyone, and a comma-separated list
 * of user ids limits it to them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentPausedState } from '@/lib/work/agent-paused'
import type { DigestCandidate } from '@/lib/agent-events/digest'
import { readMeetingWindow, type UpcomingMeetingDeps } from '@/lib/agent-events/upcoming-meetings'
import { trustedGuestEmails } from '@/lib/guests/store'
import {
  LOOK_AHEAD_SLOT_HOURS,
  isDeparture,
  isPlace,
  localParts,
  lookAheadCandidates,
  lookAheadSpan,
  spanWindow,
  type LookAheadCandidate,
  type LookAheadSlot,
  type LookAheadSpan,
} from './candidates'
import {
  buildExtractMessage,
  extraFactsFor,
  factsFor,
  liveMailDeps,
  readBookingMail,
  readLookAheadMail,
  type LookAheadExtract,
  type LookAheadMailDeps,
} from './facts'
import {
  candidateAppOnly,
  clockLabel,
  inQuietHours,
  lookAheadLines,
  lookAheadMessageId,
  plainTitle,
  shortPlace,
  writeLookAhead,
  type LookAheadLine,
  type LookAheadWriteDeps,
} from './message'

export { LOOK_AHEAD_SLOT_HOURS }

/** The event that starts one person's look-ahead for one slot. */
export const LOOK_AHEAD_REQUESTED_EVENT = 'look-ahead/requested'
/** The delayed event that sends one departure's heads-up. */
export const LOOK_AHEAD_TRAVEL_EVENT = 'look-ahead/travel.due'
/** How long before a departure its heads-up goes. */
export const TRAVEL_LEAD_MS = 3 * 60 * 60_000

export interface LookAheadRequestData {
  userId: string
  workspaceId: string
  memberId: string
  conversationId: string
  timeZone: string
  /** The person's local date the pass ran on. */
  date: string
  slot: LookAheadSlot
}

export interface LookAheadRequest {
  id: string
  name: typeof LOOK_AHEAD_REQUESTED_EVENT
  data: LookAheadRequestData
}

/** One departure's heads-up, sent at `ts`. */
export interface LookAheadTravelData {
  userId: string
  workspaceId: string
  memberId: string
  conversationId: string
  timeZone: string
  meetingKey: string
  startIso: string
}

/** Why the plan sent no look-ahead for a person. */
export type LookAheadSkip = 'no_zone' | 'no_home_thread' | 'already_sent' | 'paused' | 'dormant' | 'lookup_failed'

export interface LookAheadPlanDeps {
  /** The kill switch's three states (readAgentPausedState): anything but 'active' skips (fail closed). */
  pausedState: (supabase: SupabaseClient, workspaceId: string) => Promise<AgentPausedState>
  isDormant: (supabase: SupabaseClient, workspaceId: string) => Promise<boolean>
}

/** Whether a person's look-ahead is live (else shadow): yes unless LOOK_AHEAD_LIVE says `off`/`shadow` or lists others. Pure over the env. */
export function lookAheadLive(userId: string, env: string | undefined = process.env.LOOK_AHEAD_LIVE): boolean {
  const value = (env ?? '').trim()
  if (!value || value.toLowerCase() === 'all') return true
  if (['off', 'shadow', 'none', 'false', '0'].includes(value.toLowerCase())) return false
  return value
    .split(',')
    .map((v) => v.trim())
    .includes(userId)
}

/** The request the scan sends for one person and slot. Pure. */
export function lookAheadRequest(conversationId: string, c: Pick<DigestCandidate, 'userId' | 'workspaceId' | 'memberId' | 'timeZone' | 'date'>, slot: LookAheadSlot): LookAheadRequest {
  return {
    id: `look-ahead:${conversationId}:${c.date}:${slot}`,
    name: LOOK_AHEAD_REQUESTED_EVENT,
    data: { userId: c.userId, workspaceId: c.workspaceId, memberId: c.memberId, conversationId, timeZone: c.timeZone, date: c.date, slot },
  }
}

/**
 * One candidate's decision for one slot (see the header). Never throws: a
 * failed read is `lookup_failed` (no look-ahead this slot).
 */
export async function planLookAheadFor(
  supabase: SupabaseClient,
  c: DigestCandidate,
  slot: LookAheadSlot,
  deps: LookAheadPlanDeps,
): Promise<{ ok: true; request: LookAheadRequest } | { ok: false; reason: LookAheadSkip }> {
  try {
    if (!c.timeZoneSource || c.timeZoneSource === 'utc') return { ok: false, reason: 'no_zone' }
    const { data: convs, error: convError } = await supabase.from('chat_conversations').select('id').eq('user_id', c.userId).eq('workspace_id', c.workspaceId).eq('is_home', true).limit(1)
    if (convError) return { ok: false, reason: 'lookup_failed' }
    const conversationId = (convs as Array<{ id?: unknown }> | null)?.[0]?.id
    if (typeof conversationId !== 'string') return { ok: false, reason: 'no_home_thread' }

    const span = lookAheadSpan(slot, c.date)
    const { data: sent, error: sentError } = await supabase
      .from('chat_messages')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('ui_message_id', lookAheadMessageId({ slot, date: span.date }))
      .limit(1)
    if (sentError) return { ok: false, reason: 'lookup_failed' }
    if (Array.isArray(sent) && sent.length > 0) return { ok: false, reason: 'already_sent' }

    // Fails CLOSED: this spends money, so a switch that can't be read is off.
    const state = await deps.pausedState(supabase, c.workspaceId).catch((): AgentPausedState => 'unknown')
    if (state !== 'active') return { ok: false, reason: 'paused' }
    if (await deps.isDormant(supabase, c.workspaceId).catch(() => false)) return { ok: false, reason: 'dormant' }
    return { ok: true, request: lookAheadRequest(conversationId, c, slot) }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }
}

/** One `[look-ahead]` line per scan. Pure. */
export function lookAheadPlanLogLine(r: { candidates: number; sent: number; skips: Partial<Record<LookAheadSkip, number>> }): string {
  const skips = Object.entries(r.skips)
    .map(([k, n]) => `${k}=${n}`)
    .join(' ')
  return `[look-ahead] candidates=${r.candidates} sent=${r.sent}${skips ? ` ${skips}` : ''}`
}

// ── The calendar ─────────────────────────────────────────────────────────────

/** What the calendar read hands on: the span and its candidates (calendar facts only, no mail). */
export interface LookAheadCalendar {
  span: LookAheadSpan
  candidates: LookAheadCandidate[]
}

/** What the calendar read takes besides the read itself: the person's guests and the workspace's members (tests pass stubs). */
export interface LookAheadCalendarDeps extends UpcomingMeetingDeps {
  /** The person's guests' calendar addresses (default: trustedGuestEmails, on this service client). */
  trusted?: (supabase: SupabaseClient, ownerUserId: string) => Promise<Set<string>>
  /** Which of these addresses are the workspace's members (default: findMembersByEmail). */
  memberEmails?: (workspaceId: string, emails: string[]) => Promise<Set<string>>
}

async function defaultMemberEmails(workspaceId: string, emails: string[]): Promise<Set<string>> {
  const { findMembersByEmail } = await import('@/lib/workspace-member-emails')
  return new Set((await findMembersByEmail(workspaceId, emails)).keys())
}

/**
 * The person's guests' addresses for this workspace's look-ahead: the guest
 * list (trustedGuestEmails) less any workspace member's address, since a
 * teammate is never a guest. Read only when the span holds an event with
 * someone besides the person. Never throws: a failed guest read is no
 * guests, and a failed member read is no guests too (every invite is a
 * stranger's, as before: the safe side).
 */
async function lookAheadGuests(supabase: SupabaseClient, data: Pick<LookAheadRequestData, 'userId' | 'workspaceId'>, deps: LookAheadCalendarDeps): Promise<Set<string>> {
  try {
    const listed = await (deps.trusted ?? trustedGuestEmails)(supabase, data.userId)
    if (!listed.size) return listed
    const members = await (deps.memberEmails ?? defaultMemberEmails)(data.workspaceId, [...listed])
    return new Set([...listed].filter((e) => !members.has(e)))
  } catch {
    return new Set()
  }
}

/**
 * Read a slot's span of the calendar and the person's guests' addresses (a
 * guest's invite counts as their own: candidates.ts), and pick the
 * candidates. Never throws: a failed read is none, and a failed guest read is
 * no guests (every invite is a stranger's, as before).
 */
export async function readLookAheadCalendar(
  supabase: SupabaseClient,
  data: Pick<LookAheadRequestData, 'userId' | 'workspaceId' | 'timeZone' | 'date' | 'slot'>,
  deps: LookAheadCalendarDeps = {},
): Promise<LookAheadCalendar> {
  const span = lookAheadSpan(data.slot, data.date)
  try {
    const { trusted: _trusted, memberEmails: _memberEmails, ...readDeps } = deps
    // The clock is now's, never the window's start (a gone token is marked as of now).
    const read = await readMeetingWindow(supabase, { userId: data.userId, workspaceId: data.workspaceId }, spanWindow(span, data.timeZone), { nowMs: Date.now(), ...readDeps }, { details: true })
    // The guest list only matters for an event with someone besides the person on it.
    const withOthers = read.meetings.some((m) => (typeof m.others === 'number' ? m.others > 0 : m.attendees.length > 1) || (m.mine === false && !!m.organizer))
    const trusted = withOthers ? await lookAheadGuests(supabase, data, deps) : new Set<string>()
    return { span, candidates: lookAheadCandidates(read.meetings, { span, timeZone: data.timeZone, trusted }) }
  } catch {
    return { span, candidates: [] }
  }
}

/** The shadow line: how many candidates and why, never what they are. Pure. */
export function lookAheadShadowLine(userId: string, calendar: LookAheadCalendar): string {
  const why = calendar.candidates.flatMap((c) => c.why)
  const count = (w: string) => why.filter((x) => x === w).length
  return `[look-ahead] shadow user=${userId} slot=${calendar.span.slot} date=${calendar.span.date} candidates=${calendar.candidates.length} travel=${count('travel')} place=${count('place')} early=${count('early')}`
}

// ── The gather: calendar, mail, model, checks ────────────────────────────────

/** A departure to give its own heads-up: when it starts, by its meeting key. */
export interface LookAheadDeparture {
  meetingKey: string
  startIso: string
}

/** What the gather hands the write: the lines to send (none: nothing to say), and the departures in them. */
export type LookAheadGather =
  | { status: 'live'; span: LookAheadSpan; lines: LookAheadLine[]; departures: LookAheadDeparture[]; candidates: number; bookings: number; extracted: boolean }
  | { status: 'shadow'; span: LookAheadSpan; candidates: number; line: string }
  | { status: 'nothing'; span: LookAheadSpan }

export interface LookAheadGatherDeps {
  readCalendar?: (data: LookAheadRequestData) => Promise<LookAheadCalendar>
  mail?: LookAheadMailDeps
  /** The model's read (the utility task); resolves null or throws when it fails. */
  extract?: (args: { data: LookAheadRequestData; message: string }) => Promise<LookAheadExtract | null>
  /** Who is live (lookAheadLive over the env). */
  live?: (userId: string) => boolean
  nowMs?: number
}

/**
 * Everything before the write, in one call so the caller can keep it in one
 * step (see the header): a shadow person stops after the calendar, with a
 * count; a live one gets the lines, built from checked facts only. Throws
 * only what its deps throw (the usage gate runs before it, in its own step).
 */
export async function gatherLookAhead(supabase: SupabaseClient, data: LookAheadRequestData, deps: LookAheadGatherDeps = {}): Promise<LookAheadGather> {
  const calendar = await (deps.readCalendar ?? ((d) => readLookAheadCalendar(supabase, d)))(data)
  const { span } = calendar
  const live = (deps.live ?? lookAheadLive)(data.userId)
  if (!live) {
    return calendar.candidates.length ? { status: 'shadow', span, candidates: calendar.candidates.length, line: lookAheadShadowLine(data.userId, calendar) } : { status: 'nothing', span }
  }

  const nowMs = deps.nowMs ?? Date.now()
  const mailDeps = deps.mail ?? liveMailDeps(supabase)
  const itemMail = await readLookAheadMail(mailDeps, { userId: data.userId, workspaceId: data.workspaceId, candidates: calendar.candidates, nowMs })
  const bookings = await readBookingMail(mailDeps, {
    userId: data.userId,
    workspaceId: data.workspaceId,
    date: span.date,
    nowMs,
    readThreads: new Set(itemMail.map((m) => m.threadId).filter((t): t is string => !!t)),
  })
  if (calendar.candidates.length === 0 && bookings.length === 0) return { status: 'nothing', span }

  // One more try on a failed call (items only the model may let through send
  // nothing without it), the second without the booking-only mail: a
  // smaller task, and the calendar's items are what matter most.
  const extract = deps.extract
  const ask = async (withBookings: boolean) => {
    if (!extract) return null
    const used = withBookings ? [...itemMail, ...bookings] : itemMail
    if (!withBookings && calendar.candidates.length === 0) return null
    const answer = await extract({ data, message: buildExtractMessage(calendar.candidates, used, { date: span.date, fromHour: span.fromHour, toHour: span.toHour }) })
    return answer ? { answer, mail: used } : null
  }
  const got = await ask(bookings.length > 0)
    .catch(() => ask(false))
    .catch(() => null)
  const mail = got?.mail ?? itemMail
  const answer = got?.answer ?? null
  const facts = answer ? factsFor(calendar.candidates, mail, answer) : null
  const extras = answer ? extraFactsFor(mail, answer, span) : []
  const lines = lookAheadLines(calendar.candidates, facts, extras)
  // The departures that went out: a flight or train the message names, and may text (its heads-up is a text).
  const kept = new Set(lines.map((l) => l.sortKey))
  const departures = calendar.candidates
    .filter((c, i) => isDeparture(c) && kept.has(c.localTime) && (!facts || facts[i]?.include) && !candidateAppOnly(c, facts?.[i]))
    .map((c) => ({ meetingKey: c.meeting.meetingKey, startIso: c.meeting.startIso }))
  return { status: 'live', span, lines, departures, candidates: calendar.candidates.length, bookings: bookings.length, extracted: answer !== null }
}

/**
 * The delayed heads-up events for these departures: each at its start less
 * TRAVEL_LEAD_MS, only when that is still ahead by 10 minutes and outside
 * quiet hours in the person's zone (a 9 am flight's 6 am heads-up would wake
 * nobody usefully: the evening's message said it). Pure.
 */
export function travelEvents(data: Omit<LookAheadTravelData, 'meetingKey' | 'startIso'>, departures: readonly LookAheadDeparture[], nowMs: number): Array<{ id: string; name: typeof LOOK_AHEAD_TRAVEL_EVENT; ts: number; data: LookAheadTravelData }> {
  return departures
    .map((d) => ({ d, ts: Date.parse(d.startIso) - TRAVEL_LEAD_MS }))
    .filter(({ ts }) => Number.isFinite(ts) && ts > nowMs + 10 * 60_000 && !inQuietHours(localParts(ts, data.timeZone).hour))
    .map(({ d, ts }) => ({ id: `look-ahead-travel:${data.conversationId}:${d.meetingKey}:${d.startIso}`, name: LOOK_AHEAD_TRAVEL_EVENT, ts, data: { ...data, meetingKey: d.meetingKey, startIso: d.startIso } }))
}

// ── A departure's heads-up ───────────────────────────────────────────────────

/**
 * The heads-up's one line, when the departure still stands: the calendar read
 * again around its start finds it by its key at the same time (a moved,
 * cancelled or declined trip finds nothing), and it still may be texted: an
 * invite from someone else that the person never answered goes only when its
 * organizer is on it as an attendee who accepted (a guest's Google invite;
 * the message only scheduled it for a confirmed guest's: candidateAppOnly).
 * Never throws: a failed read is none.
 */
export async function readDepartureLine(supabase: SupabaseClient, data: LookAheadTravelData, deps: UpcomingMeetingDeps = {}): Promise<LookAheadLine | null> {
  const startMs = Date.parse(data.startIso)
  if (!Number.isFinite(startMs)) return null
  try {
    const read = await readMeetingWindow(supabase, { userId: data.userId, workspaceId: data.workspaceId }, { fromMs: startMs - 2 * 60_000, toMs: startMs + 2 * 60_000 }, { nowMs: Date.now(), ...deps }, { details: true })
    const m = read.meetings.find((x) => x.meetingKey === data.meetingKey && Date.parse(x.startIso) === startMs)
    if (!m) return null
    // An unanswered invite whose organizer isn't on it, accepted: no text (an emailed invite can name anyone).
    if (m.accepted === false && !!m.organizer && m.organizerAccepted !== true) return null
    const p = localParts(startMs, data.timeZone)
    const local = `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`
    return { when: clockLabel(local), title: plainTitle(m.title ?? 'Departure'), place: isPlace(m.location) ? shortPlace(m.location) : null, bring: [], confirmation: null, sortKey: local }
  } catch {
    return null
  }
}

// ── The deliver: gather and write, in one step ───────────────────────────────

/**
 * What a run's one step hands on: never the message's words (they may be the
 * mail's), only the row it wrote, the departures' calendar keys and counts.
 */
export type LookAheadDelivered =
  | { status: 'sent'; rowId: string; first: boolean; date: string; departures: LookAheadDeparture[]; lines: number; candidates: number; bookings: number; extracted: boolean }
  | { status: 'shadow'; date: string; candidates: number; line: string }
  | { status: 'nothing'; date: string }
  | { status: 'not_written'; date: string }

/**
 * The slot's message when a first try wrote it (a retried step): its row and
 * the departures it stored. Null when there is none, or the read fails.
 * Never throws.
 */
export async function readWrittenLookAhead(supabase: SupabaseClient, conversationId: string, messageId: string): Promise<{ rowId: string; departures: LookAheadDeparture[] } | null> {
  try {
    const { data } = await supabase.from('chat_messages').select('id, ui_message').eq('conversation_id', conversationId).eq('ui_message_id', messageId).limit(1)
    const row = Array.isArray(data) ? (data[0] as { id?: unknown; ui_message?: { metadata?: { look_ahead_departures?: unknown } } } | undefined) : undefined
    if (!row || typeof row.id !== 'string') return null
    const stored = row.ui_message?.metadata?.look_ahead_departures
    const departures = Array.isArray(stored)
      ? stored.filter((d): d is LookAheadDeparture => !!d && typeof (d as LookAheadDeparture).meetingKey === 'string' && typeof (d as LookAheadDeparture).startIso === 'string')
      : []
    return { rowId: row.id, departures }
  } catch {
    return null
  }
}

/**
 * The gather, then the write (see the header). A slot whose message a first
 * try already wrote goes on from that row (no second gather, no second model
 * call), so a retry still texts once and schedules its departures. Throws
 * only what the gather's deps throw.
 */
export async function deliverLookAhead(supabase: SupabaseClient, data: LookAheadRequestData, deps: LookAheadGatherDeps & { write?: LookAheadWriteDeps } = {}): Promise<LookAheadDelivered> {
  const date = lookAheadSpan(data.slot, data.date).date
  const already = await readWrittenLookAhead(supabase, data.conversationId, lookAheadMessageId({ slot: data.slot, date }))
  if (already) return { status: 'sent', rowId: already.rowId, first: false, date, departures: already.departures, lines: 0, candidates: 0, bookings: 0, extracted: false }
  const gathered = await gatherLookAhead(supabase, data, deps)
  if (gathered.status === 'shadow') return { status: 'shadow', date: gathered.span.date, candidates: gathered.candidates, line: gathered.line }
  if (gathered.status === 'nothing' || gathered.lines.length === 0) return { status: 'nothing', date: gathered.span.date }
  const written = await writeLookAhead(
    supabase,
    {
      workspaceId: data.workspaceId,
      userId: data.userId,
      memberId: data.memberId,
      conversationId: data.conversationId,
      of: { slot: data.slot, date: gathered.span.date },
      lines: gathered.lines,
      departures: gathered.departures,
      timeZone: data.timeZone,
    },
    deps.write,
  )
  if (!written) return { status: 'not_written', date: gathered.span.date }
  return {
    status: 'sent',
    rowId: written.rowId,
    first: written.first,
    date: gathered.span.date,
    departures: gathered.departures,
    lines: gathered.lines.length,
    candidates: gathered.candidates,
    bookings: gathered.bookings,
    extracted: gathered.extracted,
  }
}
