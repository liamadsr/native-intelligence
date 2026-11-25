/**
 * The event turn (A6 follow-up; docs/plans/always-on-agent.md §5 "needs the
 * agent's judgment now: a turn on the home thread"). The router sorts some
 * rows `turn` (./router.ts turnRuleFor: mail from someone the person knows
 * that needs a reply, a meeting the live agent left open asks or staged
 * proposals in, a teammate's mention, a reminder coming due, a failure; or
 * Jev's pick where it is proven, ./router.ts applyJev) and asks for one home
 * turn, reason 'event'. Its plan (src/lib/chat/home-turn-server.ts) runs
 * gatherEventTurn:
 *
 *   • every undelivered `turn` row of the person's from the last
 *     EVENT_TURN_WINDOW_MS (the debounce keeps only the last request, so the
 *     payload's ids are never trusted for what to carry);
 *   • minus what settled since (./freshness.ts: a draft sent, a thread
 *     answered, an approval decided), marked so it is never read again.
 *
 * The body names each thread or item in a line, by Native Intelligence's own phrase around
 * a clipped title (a mail row: the sender's address, never a subject), with its pointer (`email_draft <id>`,
 * `capture <id>`…) so the agent can open it with its read tools and point the
 * person at the review pile. Never mail text: the agent reads a thread live
 * before it mentions it (home-turn.ts EVENT_MAIL_GUIDANCE). Mail from someone
 * the person is in a meeting with right now waits for the meeting's end
 * (meetingHold, below). Once the agent WROTE a reply,
 * the rows are marked delivered (`home_turn:<row id>`). A quiet turn (no_reply)
 * means the agent judged them handled: they are marked too (so the next mail
 * doesn't bring them back), except an approval, which still waits on the
 * person and stays for "while you were away" and the digest.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { clipLogText } from '@/lib/log/agent-log'
import type { HomeTurnEvents } from '@/lib/chat/home-turn'
import { HOME_TURN_MAX_DIGEST_EVENTS } from '@/lib/chat/home-turn'
import { markSettledEvents, settledEventIds } from './freshness'
import { EMAIL_KIND_PHRASE, MENTION_PHRASE } from './away-section'
import { DEFAULT_MEETING_MS, meetingClock, meetingWhen } from './meeting-time'
import type { UpcomingMeeting } from './upcoming-meetings'
import { NOTICE_KINDS, type AgentEventKind, type AgentEventRow } from './types'

/**
 * The kinds a quiet turn never delivers: they wait on the person (a question,
 * a failure, an approval), or the person asked for them (a reminder), so a
 * `[quiet]` reply leaves them for "while you were away" and the digest.
 */
export const UNSEEN_WAITING_KINDS: readonly AgentEventKind[] = ['work.needs_input', 'work.failed', 'work.approval', 'reminder.due', 'sequence.failed', 'connection.needs_reconnect', 'quote.received']

/** How far back an event turn looks for undelivered turn rows. */
export const EVENT_TURN_WINDOW_MS = 24 * 60 * 60_000
/** At most this many lines in one event turn (then "…and N more"). */
export const EVENT_TURN_MAX_LINES = 12

export type EventTurnRow = Pick<AgentEventRow, 'id' | 'kind' | 'facts' | 'occurs_at' | 'ref_type' | 'ref_id'>

/**
 * The person's undelivered turn rows, oldest first, minus the settled ones
 * (marked). Throws on a failed read.
 */
export async function gatherEventTurn(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; nowMs?: number },
): Promise<EventTurnRow[]> {
  const nowMs = args.nowMs ?? Date.now()
  const { data, error } = await supabase
    .from('agent_event')
    .select('id, kind, facts, occurs_at, expires_at, ref_type, ref_id')
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .eq('outcome', 'turn')
    .eq('state', 'routed')
    .is('delivered_at', null)
    .gte('created_at', new Date(nowMs - EVENT_TURN_WINDOW_MS).toISOString())
    .order('occurs_at', { ascending: true })
    .limit(HOME_TURN_MAX_DIGEST_EVENTS)
  if (error) throw new Error(`agent_event read failed: ${error.message}`)
  const rows: EventTurnRow[] = ((data as Array<Record<string, unknown>> | null) ?? [])
    .filter((r) => r.id != null && typeof r.kind === 'string' && typeof r.occurs_at === 'string')
    .filter((r) => !(typeof r.expires_at === 'string' && Date.parse(r.expires_at) <= nowMs))
    .map((r) => ({
      id: String(r.id),
      kind: r.kind as AgentEventKind,
      facts: r.facts && typeof r.facts === 'object' && !Array.isArray(r.facts) ? (r.facts as AgentEventRow['facts']) : {},
      occurs_at: r.occurs_at as string,
      ref_type: typeof r.ref_type === 'string' ? r.ref_type : null,
      ref_id: typeof r.ref_id === 'string' ? r.ref_id : null,
    }))
  const settled = await settledEventIds(supabase, args, rows, nowMs)
  await markSettledEvents(supabase, settled, nowMs)
  return rows.filter((r) => !settled.has(r.id))
}

/**
 * Why a thread got no draft, when a limit held it back (the mail seam's
 * templated `reason`): such a thread is never drafted by an event turn's
 * helper either, which would get round the limit.
 */
export const NO_DRAFT_BECAUSE: Readonly<Record<string, string>> = {
  cap: "today's limit of automatic drafts was reached",
  paused: 'agent work is switched off',
  usage: 'the AI usage limit was reached',
  dormant: 'drafting is paused while the workspace is quiet',
}

/**
 * A pointer the agent can open with its read tools (never outside text). A
 * notice's event points at its notification, which the agent can't open: its
 * pointer is what the notification points at (an action, a capture…), when
 * known.
 */
function pointer(row: Pick<EventTurnRow, 'kind' | 'facts' | 'ref_type' | 'ref_id'>): string {
  if (NOTICE_KINDS.has(row.kind)) {
    const f = row.facts ?? {}
    return typeof f.targetType === 'string' && typeof f.targetId === 'string' && f.targetType && f.targetId
      ? ` [${f.targetType.slice(0, 40)} ${f.targetId.slice(0, 120)}]`
      : ''
  }
  return row.ref_type && row.ref_id ? ` [${row.ref_type} ${row.ref_id.slice(0, 120)}]` : ''
}

/**
 * One row's line: Native Intelligence's phrase around a clipped title, then its pointer.
 * A mail row names the sender's address and its contact pointer, never a
 * subject (no stored mail): the agent reads the thread live before it says
 * what it is. A
 * meeting change names its times in `timeZone` (the person's), with the zone,
 * so the agent never works out a time itself. Pure.
 */
export function eventTurnLine(row: EventTurnRow, timeZone: string | null = null): string {
  const f = row.facts ?? {}
  const title = clipLogText(f.title, 80) ?? 'Untitled'
  const from = clipLogText(f.from, 120)
  const by = from ? ` from ${from}` : ''
  const contact = typeof f.contactId === 'string' && f.contactId ? ` [contact ${f.contactId.slice(0, 64)}]` : ''
  switch (row.kind) {
    case 'email.drafted':
      return `- Reply needed${by}${contact}. A draft is ready in the review pile (Mail, To review).${pointer(row)}`
    case 'email.needs_reply': {
      // E3 (decision 1): Jev wasn't sure a reply is needed, so none was guessed at. The agent
      // reads it before saying anything (Liam, 2026-11-24: "want me to read it?" is no update).
      if (f.reason === 'unsure') {
        return `- Maybe a reply${by}${contact}: Native Intelligence wasn't sure one is needed, so none was drafted. Read it first. Ask the person only if a reply is really in doubt, saying in a clause what it asks; draft one only if they say yes.${pointer(row)}`
      }
      // A draft held back by a limit stays held back: say why, and that it is not to be drafted.
      const held = typeof f.reason === 'string' ? NO_DRAFT_BECAUSE[f.reason] : undefined
      return held
        ? `- Reply needed${by}${contact}. No draft: ${held}. Do not draft it; tell the person.${pointer(row)}`
        : `- Reply needed${by}${contact}. No draft yet.${pointer(row)}`
    }
    case 'capture.processed': {
      const asks = f.openAsks ?? 0
      const proposals = f.pendingProposals ?? 0
      const parts = [
        asks > 0 ? `${asks} open ${asks === 1 ? 'question' : 'questions'} from the live agent nobody answered in the call` : null,
        proposals > 0 ? `${proposals} staged ${proposals === 1 ? 'proposal' : 'proposals'} waiting for review` : null,
      ].filter(Boolean)
      // Their first capture while getting started (docs/plans/getting-started-skill.md): its step 3.
      if (f.firstRun === true) {
        const left = parts.length ? ` Also: ${parts.join('; ')}.` : ''
        return `- Their first capture while getting started is processed: “${title}”. Its notes and to-dos are ready: show them what it pulled out (getting-started step 3).${left}${pointer(row)}`
      }
      // Raised by Jev (router.ts applyJev) with nothing left open: the meeting itself is the news.
      if (!parts.length) return `- Meeting over: “${title}”. Its summary, actions and decisions are ready.${pointer(row)}`
      return `- Meeting over: “${title}”: ${parts.join('; ')}.${pointer(row)}`
    }
    case 'email.arrived': {
      const what = (EMAIL_KIND_PHRASE[f.emailKind ?? ''] ?? 'An email').toLowerCase()
      const ask = f.needsInput ? ' It asks them for something only they can answer.' : ''
      return `- ${what.charAt(0).toUpperCase()}${what.slice(1)}${by}${contact}${f.shouldKnow ? ', worth telling the person about' : ''}.${ask} Read it live before saying what it is.${pointer(row)}`
    }
    case 'meeting.changed': {
      const n = typeof f.attendeeCount === 'number' ? f.attendeeCount : 0
      const others = n > 0 ? ` (with ${n} ${n === 1 ? 'other person' : 'other people'})` : ''
      const was = meetingWhen(row.occurs_at, timeZone)
      if (f.change === 'moved' && f.movedTo) {
        return `- A meeting moved: “${title}”${others}, from ${was} to ${meetingWhen(f.movedTo, timeZone)}.${pointer(row)}`
      }
      if (f.change === 'cancelled') return `- A meeting was cancelled: “${title}”${others}, which was at ${was}.${pointer(row)}`
      return `- A meeting is no longer on the person's calendar: “${title}”${others}, which was at ${was} (cancelled, or moved more than a day away).${pointer(row)}`
    }
    case 'work.approval': {
      // An unattended run's card asks in this thread (P13); a chat door's sits in the chat that raised it.
      const where = f.door === 'chat' ? 'Its card is in the chat that asked for it' : 'Its card is already in this thread'
      return `- Waiting for the person's approval (held by ${f.door === 'chat' ? 'a chat' : `an unattended ${clipLogText(f.door, 20) ?? 'run'}`}): “${title}”. ${where}; only the person can approve it there.${pointer(row)}`
    }
    case 'mention':
      return `- ${MENTION_PHRASE[f.notificationType ?? ''] ?? 'A teammate wants them'}: “${title}”.${pointer(row)}`
    case 'reminder.due':
      return `- A reminder the person set came due: “${title}”.${pointer(row)}`
    case 'work.failed':
      return `- A background job failed: “${title}”.${pointer(row)}`
    case 'sequence.failed':
      return `- An outreach sequence of theirs had a problem: “${title}”.${pointer(row)}`
    case 'connection.needs_reconnect': {
      // Native Intelligence's own catalog id (cleanFacts kept it short): connect takes it.
      const catalogId = typeof f.catalogId === 'string' && /^[a-z0-9-]{1,40}$/.test(f.catalogId) ? f.catalogId : null
      const how = catalogId
        ? `Call connect with catalog_id "${catalogId}": its card's Reconnect signs them in again, keeping its tool settings.`
        : 'Its Reconnect button is on its page in Settings › Connectors; point them there.'
      return `- “${title}” needs the person to sign in again: its sign-in expired and couldn't be renewed, so its tools fail until they reconnect. ${how} Say it once, in a line.${pointer(row)}`
    }
    case 'quote.received':
      // Roadmap B1: the title is Native Intelligence's own words and numbers (receive.ts quoteEventTitle); what the customer typed is read with get_quote, fenced.
      // Roadmap F3: the owner's yes is book_quote (a time the customer chose) or send_quote (the price and the booking link), each its own card.
      return `- A new quote request from the business's website, ${title}.${contact} Read it with get_quote, then tell the person in a few lines who it is, what they want and the price. If the customer already chose a time (its requested dates, or their notes), offer to book it and on their yes call book_quote; otherwise ask for or confirm the price and on their yes call send_quote. A payment link can follow (send_payment_link, its own card).${pointer(row)}`
    case 'job.paid':
      // Roadmap C2: Native Intelligence's own words (paid.ts paidText); the owner's text about it didn't go out.
      return `- A customer paid: “${title}”. Tell the person in a line; nothing else to do.${pointer(row)}`
    default:
      return `- ${title}${pointer(row)}`
  }
}

// ── Mail held while the person is in a meeting with its sender ──────────────
//
// Liam, 2026-11-24: a background message pinged him at 10:29 about mail from
// the very person he was on a call with. Mail from someone the person is in a
// meeting with right now (or about to be: MEETING_HOLD_LEAD_MS) waits in code
// until the meeting ends: its row is left out of the turn and stays
// undelivered, and the turn's run asks for one more event turn just after the
// end (src/lib/inngest/home-turn.ts askAfterMeeting). Whatever they wrote,
// they can say in the meeting. Once it is over, the mail's line says it came
// during that meeting, so mail about it ("I'm here", a link, running late)
// gets no ping.

/** The kinds whose line names a sender: the ones a meeting with that sender holds. */
const MAIL_KINDS: ReadonlySet<AgentEventKind> = new Set(['email.drafted', 'email.needs_reply', 'email.arrived'])
/** How far back the hold reads meetings' starts: one that started longer ago than this is not counted as still going. */
export const MEETING_HOLD_LOOKBACK_MS = 4 * 60 * 60_000
/** Mail this close before a meeting with its sender counts as at it (they're there, running late, the link). */
export const MEETING_HOLD_LEAD_MS = 10 * 60_000
/** At most this many senders named on a meeting's line. */
const MEETING_HOLD_MAX_SENDERS = 3

/** A meeting of the person's as the hold reads it: its pointer, when it runs, and who is in it. */
export interface HoldMeeting {
  ref: string
  id: string
  title: string | null
  startIso: string
  endIso: string
  /** Its attendees and organizer, lower case. */
  people: string[]
}

/** The calendar's meetings as the hold reads them (a meeting with no end runs DEFAULT_MEETING_MS). Pure. */
export function holdMeetingsOf(
  meetings: ReadonlyArray<Pick<UpcomingMeeting, 'ref' | 'id' | 'title' | 'startIso' | 'endIso' | 'attendees' | 'organizer'>>,
): HoldMeeting[] {
  return meetings.flatMap((m) => {
    const startMs = Date.parse(m.startIso)
    if (!Number.isFinite(startMs)) return []
    const endMs = m.endIso ? Date.parse(m.endIso) : NaN
    const people = [...new Set([...(m.attendees ?? []), ...(m.organizer ? [m.organizer] : [])].map((a) => a.trim().toLowerCase()).filter((a) => a.includes('@')))]
    if (!people.length) return []
    const end = Number.isFinite(endMs) && endMs > startMs ? endMs : startMs + DEFAULT_MEETING_MS
    // A block longer than the look-back (a workshop day, a hold on the calendar) is no meeting to hold mail for.
    if (end - startMs > MEETING_HOLD_LOOKBACK_MS) return []
    return [{ ref: m.ref, id: m.id, title: m.title, startIso: m.startIso, endIso: new Date(end).toISOString(), people }]
  })
}

/** What a meeting with the sender does to a turn's rows (meetingHold). */
export interface MeetingHold {
  /** The rows this turn carries. */
  carried: EventTurnRow[]
  /** The rows held for a meeting going on now (left undelivered). */
  heldIds: string[]
  /** When the last meeting that held a row ends (ISO), or null when none did. */
  heldUntil: string | null
  /** Each meeting going on now (or starting within the lead) that held a row, with the senders it held. */
  current: Array<{ meeting: HoldMeeting; senders: string[]; startsLater: boolean }>
  /** A carried mail row (by id) that came during a meeting with its sender, now over. */
  during: Record<string, HoldMeeting>
}

/** The sender of a mail row, lower case, or null. */
function senderOf(row: Pick<EventTurnRow, 'kind' | 'facts'>): string | null {
  if (!MAIL_KINDS.has(row.kind)) return null
  const from = typeof row.facts?.from === 'string' ? row.facts.from.trim().toLowerCase() : ''
  return from.includes('@') ? from : null
}

/** True when the turn's rows hold mail with a sender: only then is the calendar read. Pure. */
export function hasSenderMail(rows: ReadonlyArray<Pick<EventTurnRow, 'kind' | 'facts'>>): boolean {
  return rows.some((r) => senderOf(r) !== null)
}

/** `ms` falls in the meeting, counting its lead. */
function atMeeting(m: HoldMeeting, ms: number): boolean {
  return ms >= Date.parse(m.startIso) - MEETING_HOLD_LEAD_MS && ms < Date.parse(m.endIso)
}

/**
 * Split the turn's rows by the person's meetings: a mail row whose sender is
 * in a meeting going on now (or starting within MEETING_HOLD_LEAD_MS) is
 * held; one that came during such a meeting, now over, is carried with that
 * meeting noted. Every other row is carried as it is. Pure.
 */
export function meetingHold(rows: readonly EventTurnRow[], meetings: readonly HoldMeeting[], nowMs: number): MeetingHold {
  const out: MeetingHold = { carried: [], heldIds: [], heldUntil: null, current: [], during: {} }
  const current = new Map<HoldMeeting, Set<string>>()
  let untilMs = -Infinity
  for (const row of rows) {
    const sender = senderOf(row)
    const theirs = sender ? meetings.filter((m) => m.people.includes(sender)) : []
    const now = theirs.filter((m) => atMeeting(m, nowMs))
    if (sender && now.length) {
      out.heldIds.push(row.id)
      for (const m of now) {
        current.set(m, (current.get(m) ?? new Set()).add(sender))
        untilMs = Math.max(untilMs, Date.parse(m.endIso))
      }
      continue
    }
    out.carried.push(row)
    const at = Date.parse(row.occurs_at)
    const over = Number.isFinite(at) ? theirs.find((m) => Date.parse(m.endIso) <= nowMs && atMeeting(m, at)) : undefined
    if (over) out.during[row.id] = over
  }
  if (Number.isFinite(untilMs)) out.heldUntil = new Date(untilMs).toISOString()
  out.current = [...current].map(([meeting, senders]) => ({ meeting, senders: [...senders], startsLater: Date.parse(meeting.startIso) > nowMs }))
  return out
}

/**
 * The person's meetings around now as the hold reads them: those starting in
 * the last MEETING_HOLD_LOOKBACK_MS or the next MEETING_HOLD_LEAD_MS, in this
 * workspace (one read of their calendar, readMeetingWindow, with organizers).
 * Never throws: a failed read is no meetings, so nothing is held.
 */
export async function readHoldMeetings(
  supabase: SupabaseClient,
  person: { workspaceId: string; userId: string },
  nowMs: number,
): Promise<HoldMeeting[]> {
  try {
    const { readMeetingWindow } = await import('./upcoming-meetings')
    const read = await readMeetingWindow(supabase, person, { fromMs: nowMs - MEETING_HOLD_LOOKBACK_MS, toMs: nowMs + MEETING_HOLD_LEAD_MS }, { nowMs }, { text: true })
    return holdMeetingsOf(read.meetings)
  } catch {
    return []
  }
}

/** A meeting's title on a line, clipped and quoted. */
function meetingTitle(m: HoldMeeting): string {
  return `“${clipLogText(m.title, 80) ?? 'Untitled meeting'}”`
}

/** The line naming a meeting going on now that holds mail. Pure. */
export function inMeetingLine(entry: MeetingHold['current'][number], timeZone: string | null = null): string {
  const m = entry.meeting
  const shown = entry.senders.slice(0, MEETING_HOLD_MAX_SENDERS).map((s) => clipLogText(s, 120) ?? s)
  const more = entry.senders.length - shown.length
  const who = `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`
  const when = entry.startsLater
    ? `They have a meeting starting at ${meetingClock(m.startIso, timeZone, false)}, until ${meetingClock(m.endIso, timeZone)}`
    : `They are in a meeting now, until ${meetingClock(m.endIso, timeZone)}`
  return `- ${when}: ${meetingTitle(m)}, with ${who}. Native Intelligence is holding mail from them until it ends and brings it back then: don't bring it up now. [${m.ref} ${m.id.slice(0, 120)}]`
}

/** What a mail line adds when it came during a meeting with its sender, now over. Pure. */
export function duringMeetingNote(m: HoldMeeting, timeZone: string | null = null): string {
  return `It came while they were in ${meetingTitle(m)} with this sender (${meetingClock(m.startIso, timeZone, false)} to ${meetingClock(m.endIso, timeZone)}), now over: if it was about that meeting (they were there, a link, running late), it is moot: say nothing about it.`
}

/** The event turn's body input, or null when there is nothing to carry. Pure. */
export function eventTurnBody(
  rows: readonly EventTurnRow[],
  timeZone: string | null = null,
  hold: Pick<MeetingHold, 'current' | 'during' | 'heldUntil'> | null = null,
): HomeTurnEvents | null {
  if (!rows.length) return null
  const lines = rows.map((row) => {
    const line = eventTurnLine(row, timeZone)
    const over = hold?.during[row.id]
    if (!over) return line
    // The note goes before the pointer: every line ends with its pointer.
    const p = pointer(row)
    const note = duringMeetingNote(over, timeZone)
    return p && line.endsWith(p) ? `${line.slice(0, -p.length)} ${note}${p}` : `${line} ${note}`
  })
  const shown = lines.slice(0, EVENT_TURN_MAX_LINES)
  if (lines.length > shown.length) shown.push(`- …and ${lines.length - shown.length} more`)
  const meetingLines = (hold?.current ?? []).map((entry) => inMeetingLine(entry, timeZone))
  return {
    lines: [...meetingLines, ...shown],
    eventIds: rows.map((r) => r.id),
    ...(hold?.heldUntil ? { heldUntil: hold.heldUntil } : {}),
  }
}

/**
 * Mark rows a home turn carried delivered (`delivered_key = home_turn:<row>`,
 * `home_turn_id`), fenced on not delivered yet. Never throws; the count marked.
 */
export async function markEventsDelivered(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; eventIds: readonly string[]; homeTurnId: string; nowMs?: number; exceptWaiting?: boolean },
): Promise<number> {
  if (!args.eventIds.length) return 0
  try {
    let query = supabase
      .from('agent_event')
      .update({
        state: 'delivered',
        delivered_at: new Date(args.nowMs ?? Date.now()).toISOString(),
        delivered_key: `home_turn:${args.homeTurnId}`,
        home_turn_id: args.homeTurnId,
      })
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .in('id', [...args.eventIds])
      .is('delivered_at', null)
      .eq('state', 'routed')
    // A quiet turn: the agent judged these handled, so they are not told again
    // with the next mail; only what waits on the person (an approval) stays.
    if (args.exceptWaiting) query = query.not('kind', 'in', `(${UNSEEN_WAITING_KINDS.join(',')})`)
    const { data, error } = await query.select('id')
    if (error) {
      console.warn('[agent-event] home turn delivery mark skipped:', error.message)
      return 0
    }
    return Array.isArray(data) ? data.length : 0
  } catch (err) {
    console.warn('[agent-event] home turn delivery mark skipped:', err instanceof Error ? err.message : err)
    return 0
  }
}

/**
 * A helper's report turn covered these work items: their undelivered rows
 * (a question, a review, a failure, a finish) are delivered by it, so the
 * away section and the digest don't say them again (one helper result, one
 * telling). On a QUIET turn (`exceptWaiting`) the waiting kinds (a question,
 * a failure, an approval) stay undelivered: nobody told the person. Only routed rows: one still `new` is the router's, an expired one stays expired. Never
 * throws; the count marked.
 */
export async function markWorkEventsDelivered(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; workItemIds: readonly string[]; homeTurnId: string; nowMs?: number; exceptWaiting?: boolean },
): Promise<number> {
  if (!args.workItemIds.length) return 0
  try {
    let query = supabase
      .from('agent_event')
      .update({
        state: 'delivered',
        delivered_at: new Date(args.nowMs ?? Date.now()).toISOString(),
        delivered_key: `home_turn:${args.homeTurnId}`,
        home_turn_id: args.homeTurnId,
      })
      .eq('workspace_id', args.workspaceId)
      .eq('user_id', args.userId)
      .eq('ref_type', 'work_item')
      .in('ref_id', [...args.workItemIds])
      .is('delivered_at', null)
      .eq('state', 'routed')
    // A quiet turn told nobody: a question, a failure or an approval stays for the away section.
    if (args.exceptWaiting) query = query.not('kind', 'in', `(${UNSEEN_WAITING_KINDS.join(',')})`)
    const { data, error } = await query.select('id')
    if (error) {
      console.warn('[agent-event] report delivery mark skipped:', error.message)
      return 0
    }
    return Array.isArray(data) ? data.length : 0
  } catch (err) {
    console.warn('[agent-event] report delivery mark skipped:', err instanceof Error ? err.message : err)
    return 0
  }
}
