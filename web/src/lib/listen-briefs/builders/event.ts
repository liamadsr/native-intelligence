import { TZDate } from '@date-fns/tz'
import { format } from 'date-fns'
import { z } from 'zod'
import { applyCaptureVisibility } from '@/lib/ai/tools/_shared'
import type { SeriesKey } from '@/lib/captures/series-history'
import { gatherPersonContext, type PersonContext } from '@/lib/crm/person-context'
import { parseGoogleSeriesFromInstanceId } from '@/lib/integrations/meeting-series'
import { plainTextToSpeech, splitSentences } from '@/lib/read-aloud/speech-text'
import { ownAddresses, row, rows, type BriefContext, type OneResult, type Result } from '../context'
import {
  Speech,
  clause,
  count,
  firstName,
  listOf,
  nameFromEmail,
  notesSummary,
  numberWord,
  one,
  personLine,
  type OneOrMany,
} from '../speech'
import { describeDay, describeWhen, safeTimeZone, type Clock } from '../when'
import { OWNER_EMBEDS, isClosed, pressing, saidOf, sayItemsUnder, type ItemRow, type SaidItem } from './action-items'
import { captureSpeech, finishedNotes } from './capture'
import { MY_ACTIONS_READ } from './contact'

/**
 * A calendar event, as meeting prep: when and where, who is coming, what the
 * invite says, the last meeting of the series (or, for a one-off, the last one
 * with these guests) with its own summary and the action items still open
 * from it, mail from the guests waiting on the user's reply, and the user's
 * own open actions from meetings with them, each item read one by one (Liam,
 * 2026-09-28: "now do the same for calendar events"). Once it is over and the
 * user recorded it, the brief is what came of it: the recording's own
 * (captureSpeech).
 *
 *   "Pricing sync, in about 25 minutes, on a video call. With Jessa Lin from
 *    Acme and Sam Park. Jessa organized it. You last met on Tuesday. … Two
 *    action items from that meeting are still open, one of them yours. Send
 *    the revised deck, assigned to Jessa Lin. …"
 *
 * Events live in Google or Microsoft, not here, so the client sends what its
 * calendar shows (`input`, checked by parseEventInput); everything else is
 * read on the user's own client (captures with the capture builder's fences),
 * and the guests' open work through gatherPersonContext, as builders/contact.ts
 * runs it.
 */
export async function eventSpeech(ctx: BriefContext, id: string, input: unknown): Promise<Speech | null> {
  const event = parseEventInput(input)
  if (!event) return null

  if (event.linkedCaptureId && timingOf(event, ctx.clock) === 'over' && (await isLinkedRecording(ctx, event))) {
    const recorded = await captureSpeech(ctx, event.linkedCaptureId)
    if (recorded) return recorded
  }

  const [contacts, ownEmails, series] = await Promise.all([
    matchContacts(ctx, invitedEmails(event)),
    ownAddresses(ctx),
    seriesCaptures(ctx, id, event),
  ])
  const attendees = resolveAttendees(event, { contacts, ownEmails, memberId: ctx.memberId })
  const guests = attendees.filter((a) => a.kind === 'contact' || a.kind === 'guest')
  const [previous, people] = await Promise.all([
    previousMeeting(ctx, event, series, guests),
    peopleContext(ctx, guests),
  ])
  return eventWords({ event, attendees, previous, people }, ctx)
}

// ── What the client sends ────────────────────────────────────────────────────

/** The most guests a brief looks at (the client sends no more). */
export const MAX_GUESTS = 30

// Every field but `start` is `.optional().catch(undefined)`: missing or junk,
// it is dropped rather than failing the rest.

/** Lower-cased, and a real address, or it fails. */
const email = z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.email().max(254))
/** One line of text, whitespace collapsed, cut to `max`. */
const line = (max: number) => z.string().transform((s) => s.replace(/\s+/g, ' ').trim().slice(0, max))
/** An id to look captures up by. */
const key = z.string().trim().min(1).max(512)
/** A time a Date can read ("2026-09-28T17:00:00Z", or "2026-09-28" all day). */
const moment = z
  .string()
  .max(40)
  .refine((s) => Number.isFinite(Date.parse(s)))

const attendeeSchema = z.object({
  email,
  name: line(120).optional().catch(undefined),
  responseStatus: line(40).optional().catch(undefined),
})

const eventInputSchema = z.object({
  title: line(300).optional().catch(undefined),
  start: moment,
  end: moment.optional().catch(undefined),
  isAllDay: z.boolean().optional().catch(undefined),
  location: line(300).optional().catch(undefined),
  hasVideoCall: z.boolean().optional().catch(undefined),
  description: z
    .string()
    .transform((s) => s.slice(0, 4000))
    .optional()
    .catch(undefined),
  attendees: z.array(z.unknown()).catch([]),
  attendeeCount: z.number().int().min(0).max(100000).optional().catch(undefined),
  organizer: email.optional().catch(undefined),
  icalUid: key.optional().catch(undefined),
  seriesMasterId: key.optional().catch(undefined),
  linkedCaptureId: z.uuid().optional().catch(undefined),
})

export interface EventAttendee {
  email: string
  name?: string
  /** As the provider says it: "accepted", "declined", "tentative",
   *  "needsAction" (Google); "tentativelyAccepted", "notResponded" (Microsoft). */
  responseStatus?: string
}

/** The event as the calendar panel has it (IEvent, src/calendar/interfaces.ts). */
export interface EventInput {
  title?: string
  start: string
  end?: string
  isAllDay?: boolean
  location?: string
  hasVideoCall?: boolean
  description?: string
  /** Deduped, calendar rooms left out, at most MAX_GUESTS. */
  attendees: EventAttendee[]
  /** How many are invited in all, when there were more than the client sent. */
  attendeeCount?: number
  organizer?: string
  icalUid?: string
  seriesMasterId?: string
  /** The user's own capture linked to this event (IEvent.linkedCapture). */
  linkedCaptureId?: string
}

/**
 * What the client sent, or null when it isn't an event (no readable start) or
 * there's nothing to say beyond a time. Junk fields and junk guests are
 * dropped one by one; text is cut to size.
 */
export function parseEventInput(input: unknown): EventInput | null {
  const parsed = eventInputSchema.safeParse(input)
  if (!parsed.success) return null
  const d = parsed.data

  // Duplicates, rooms and junk are skipped; a huge list is not read to its end.
  const attendees: EventAttendee[] = []
  const seen = new Set<string>()
  for (const item of d.attendees.slice(0, MAX_GUESTS * 4)) {
    const guest = attendeeSchema.safeParse(item)
    if (!guest.success || seen.has(guest.data.email) || CALENDAR_ROOM.test(guest.data.email)) continue
    seen.add(guest.data.email)
    attendees.push(guest.data)
    if (attendees.length === MAX_GUESTS) break
  }

  // "(No title)" is how Microsoft says there is none.
  const title = d.title && !/^\(no title\)$/i.test(d.title) ? d.title : undefined
  if (!title && attendees.length === 0 && !d.description?.trim()) return null
  return {
    title,
    start: d.start,
    end: d.end,
    isAllDay: d.isAllDay,
    location: d.location || undefined,
    hasVideoCall: d.hasVideoCall,
    description: d.description,
    attendees,
    attendeeCount: d.attendeeCount,
    organizer: d.organizer,
    icalUid: d.icalUid,
    seriesMasterId: d.seriesMasterId,
    linkedCaptureId: d.linkedCaptureId,
  }
}

/** Google's rooms and group calendars, which sit on invites like people. */
const CALENDAR_ROOM = /@(?:resource|group)\.calendar\.google\.com$/

/** Every address on the invite, the organizer's included. */
function invitedEmails(event: EventInput): string[] {
  const emails = event.attendees.map((a) => a.email)
  if (event.organizer && !emails.includes(event.organizer)) emails.push(event.organizer)
  return emails
}

// ── Who is coming ────────────────────────────────────────────────────────────

/** A CRM contact whose address is on the invite. */
export interface ContactMatch {
  id: string
  full_name: string | null
  email: string | null
  secondary_emails: string[] | null
  job_title: string | null
  /** Set on a member's own contact: the user's, or a teammate's. */
  member_id: string | null
  company: OneOrMany<{ name: string | null }>
}

export interface Attendee {
  email: string
  kind: 'user' | 'teammate' | 'contact' | 'guest'
  /** How the brief names them: their CRM name, else the invite's, else one
   *  read from their address ("jordan.lee@acme.com" → "Jordan Lee"). The
   *  user is never named. */
  name: string
  /** A CRM contact's company. */
  company: string | null
  /** Their CRM contact, for a `contact`. */
  contactId: string | null
  organizer: boolean
  declined: boolean
}

/**
 * The invite's people, in its order (an organizer who isn't on it first):
 * the user (one of their own addresses, or their own member contact),
 * teammates (a member's contact), CRM contacts, and the rest by name or their
 * address. There is no member.email: a member's address is on their contact.
 */
export function resolveAttendees(
  event: EventInput,
  found: { contacts: readonly ContactMatch[]; ownEmails: readonly string[]; memberId: string },
): Attendee[] {
  const own = new Set(found.ownEmails.map((e) => e.toLowerCase()))
  // A member's own contact wins over a CRM row that shares its address.
  const byEmail = new Map<string, ContactMatch>()
  const ranked = [...found.contacts].sort((a, b) => Number(!!b.member_id) - Number(!!a.member_id))
  for (const contact of ranked) {
    for (const address of [contact.email, ...(contact.secondary_emails ?? [])]) {
      const key = address?.trim().toLowerCase()
      if (key && !byEmail.has(key)) byEmail.set(key, contact)
    }
  }

  const organizer = event.organizer
  const invited: EventAttendee[] =
    organizer && !event.attendees.some((a) => a.email === organizer)
      ? [{ email: organizer }, ...event.attendees]
      : event.attendees
  return invited.map((a): Attendee => {
    const contact = byEmail.get(a.email)
    const base = {
      email: a.email,
      company: null,
      contactId: null,
      organizer: a.email === organizer,
      declined: a.responseStatus?.toLowerCase() === 'declined',
    }
    if (own.has(a.email) || contact?.member_id === found.memberId) {
      return { ...base, kind: 'user', name: 'you' }
    }
    const name = clause(contact?.full_name) || clause(a.name) || nameFromEmail(a.email) || a.email
    if (contact?.member_id) return { ...base, kind: 'teammate', name }
    if (contact) {
      return { ...base, kind: 'contact', name, contactId: contact.id, company: clause(one(contact.company)?.name) }
    }
    return { ...base, kind: 'guest', name }
  })
}

// ── Its history ──────────────────────────────────────────────────────────────

/** A recorded meeting from before this one. */
export interface PriorCapture {
  id: string
  title: string | null
  ai_summary: string | null
  summary: string | null
  started_at: string | null
  occurrence_start: string | null
}

/** An action that came out of a meeting: what it is, whose, when it's due,
 *  and whether it's done. */
export interface FollowUpRow extends ItemRow {
  id: string
  assignee_id: string | null
  /** none | low | medium | high | urgent */
  priority: string | null
}

export interface PreviousMeeting {
  /** The previous meeting of this recurring series, or (none on record) the
   *  latest one with these guests. */
  via: 'series' | 'guests'
  capture: PriorCapture
  /** Actions that came out of it, closed ones included. */
  followUps: FollowUpRow[]
}

/**
 * How this meeting's captures are found, as the calendar panel's history finds
 * them (/api/account/calendar/event-series): the series master id (or the one
 * a Google instance id carries), the iCalendar UID every attendee's copy
 * shares, and the event id itself (the whole series' for EventKit).
 */
export function seriesKeys(id: string, event: EventInput): SeriesKey[] {
  const keys: SeriesKey[] = []
  const seriesKey = event.seriesMasterId || parseGoogleSeriesFromInstanceId(id)
  if (seriesKey) keys.push({ column: 'series_key', value: seriesKey })
  if (event.icalUid) keys.push({ column: 'ical_uid', value: event.icalUid })
  keys.push({ column: 'calendar_event_id', value: id })
  return keys
}

/** A recording that began this soon before the meeting, with no occurrence of
 *  its own on record, is taken as this meeting started early. */
const EARLY_START_MS = 15 * 60_000

/**
 * The newest capture from before this meeting: not the one linked to it, nor
 * one of this very occurrence (teammates recording the same call, or it
 * started a little early). Pure.
 */
export function pickPrevious(captures: readonly PriorCapture[], event: EventInput): PriorCapture | null {
  const before = Date.parse(event.start) - EARLY_START_MS
  let best: PriorCapture | null = null
  let bestAt = -Infinity
  for (const capture of captures) {
    if (capture.id === event.linkedCaptureId) continue
    const at = Date.parse(capture.occurrence_start ?? capture.started_at ?? '')
    if (!Number.isFinite(at) || at >= before || at <= bestAt) continue
    best = capture
    bestAt = at
  }
  return best
}

/** How far from the meeting a recording of it may be anchored. */
const SAME_MEETING_SLACK_MS = 3 * 60 * 60_000

/**
 * The capture linked to an event is a recording of it: started (not the
 * placeholder calendar sync makes for a meeting nobody recorded), and of this
 * occurrence (an EventKit series shares one event id, so the link can be
 * another week's). Pure.
 */
export function recordsThisMeeting(
  capture: { started_at: string | null; occurrence_start: string | null } | null,
  event: EventInput,
): boolean {
  if (!capture?.started_at) return false
  const at = Date.parse(capture.occurrence_start ?? capture.started_at)
  const start = Date.parse(event.start)
  const end = Math.max(Date.parse(event.end ?? '') || start, start)
  return at >= start - SAME_MEETING_SLACK_MS && at <= end + SAME_MEETING_SLACK_MS
}

// ── The words ────────────────────────────────────────────────────────────────

/** How much of the last meeting's own summary is said. */
const NOTES_SAID = 2

/** What the calendar and the workspace say, as words. Pure. */
export function eventWords(
  data: {
    event: EventInput
    attendees: Attendee[]
    previous: PreviousMeeting | null
    people: PersonContext[]
  },
  who: { memberId: string; clock: Clock },
): Speech {
  const { event, attendees, previous, people } = data
  const { memberId, clock } = who
  const speech = new Speech()
  const title = clause(event.title) || 'Untitled event'
  const timing = timingOf(event, clock)

  // When, and where.
  if (event.isAllDay) {
    const { first, last } = allDays(event, clock)
    if (first && last) speech.say(timing === 'over' ? `${title} was` : `${title},`, `from ${bare(first)} through ${bare(last)}`)
    else if (first) speech.say(timing === 'over' ? `${title} was ${first}` : `${title}, ${first}, all day`)
    else speech.say(title)
  } else if (timing === 'now') {
    speech.say(`${title} is happening now`)
    const started = describeWhen(event.start, clock)
    const ends = describeWhen(event.end, clock)
    speech.say(started && `It started ${started}`, ends && (started ? `and ends ${ends}` : `It ends ${ends}`))
  } else {
    const when = describeWhen(event.start, clock)
    speech.say(timing === 'over' ? `${title} was ${when}` : [title, when, whereOf(event)].filter(Boolean).join(', '))
  }

  // Who is coming (the user isn't named), who set it up, and who said no.
  const others = attendees.filter((a) => a.kind !== 'user')
  const unnamed = Math.max(0, (event.attendeeCount ?? 0) - event.attendees.length)
  const coming = withWhom(others.filter((a) => !a.declined), unnamed)
  if (coming) speech.say(`With ${coming}`)
  const organizer = firstName(others.find((a) => a.organizer)?.name)
  if (organizer) speech.say(`${organizer} organized it`)
  // Who can't make an audience-sized event is noise.
  const declined = listOf(others.filter((a) => a.declined).map((a) => firstName(a.name)))
  if (declined && others.length <= MAX_GUESTS_FOR_HISTORY) speech.say(`${declined} declined`)
  if (attendees.some((a) => a.kind === 'user' && a.declined)) speech.say('You declined it')

  // The invite's own words (not its title again).
  const [opening, next] = inviteSays(event.description, 3).filter((s) => clause(s)?.toLowerCase() !== title.toLowerCase())
  if (opening) speech.say('The invite says:', opening)
  if (next) speech.say(next)

  // Last time: when, its own summary, and the action items still open from it,
  // one by one. Each open item is said once: one still open from it isn't said
  // again as the user's from meetings with the guests.
  const counted = new Set<string>()
  if (previous) {
    const { capture } = previous
    const when = describeWhen(capture.started_at ?? capture.occurrence_start, clock)
    const named = clause(capture.title)
    // Over, and not recorded: that meeting came before this one.
    const before = timing === 'over'
    if (previous.via === 'series') {
      // The series' own title again says nothing.
      const other = named && named.toLowerCase() !== title.toLowerCase() ? named : null
      speech.say(before ? 'Before that, you met' : 'You last met', when, other && `, in ${other}`)
    } else {
      const guests = others.filter((a) => a.kind === 'contact' || a.kind === 'guest')
      const them = (guests.length === 1 && firstName(guests[0].name)) || 'them'
      speech.say(`${before ? 'Before that, your' : 'Your'} last meeting with ${them} was`, [named, when].filter(Boolean).join(', '))
    }
    speech.sayAll(notesSummary(finishedNotes(capture.ai_summary) ?? capture.summary, NOTES_SAID))

    const open = pressing(previous.followUps.filter((a) => !isClosed(one(a.workflow_state)?.category)), clock)
    for (const a of open) counted.add(a.id)
    const yours = open.filter((a) => a.assignee_id === memberId).length
    sayItemsUnder(
      speech,
      open.map((a) => saidOf(a, memberId)),
      clock,
      { one: 'One action item from that meeting is still open:', many: (n) => stillOpen(n, yours) },
    )
  }

  // What the guests in the CRM are waiting on: mail, and the user's own
  // actions from meetings with them, one by one (theirs need no owner: the
  // heading says they're the user's). The gatherer reads MY_ACTIONS_READ of
  // them a guest at most: at that many, "at least".
  const waiting = new Map<string, { from: string | null; subject: string | null }>()
  const mine = new Map<string, SaidItem>()
  let moreOfMine = false
  for (const person of people) {
    const from = calledBy(person)
    for (const t of person.recent_email_threads ?? []) {
      if (t.needs_reply && !waiting.has(t.id)) waiting.set(t.id, { from, subject: clause(t.subject) })
    }
    const theirMeetings = person.my_open_actions_from_their_meetings
    if (theirMeetings.length >= MY_ACTIONS_READ) moreOfMine = true
    for (const a of theirMeetings) {
      if (!counted.has(a.id) && !mine.has(a.id)) {
        mine.set(a.id, { title: a.title, due_at: a.due_at, priority: null, done: false, owner: null })
      }
    }
  }
  const mail = [...waiting.values()]
  const sender = new Set(mail.map((m) => m.from)).size === 1 ? mail[0].from : null
  if (mail.length === 1) {
    speech.say(sender ? `${sender}'s email` : 'An email from them', mail[0].subject && `about ${mail[0].subject}`, 'is waiting on your reply')
  } else if (mail.length > 1) {
    speech.say(`${count(mail.length, 'email')} from ${sender ?? 'them'} are waiting on your reply`)
  }
  if (mine.size) {
    const them = (people.length === 1 && calledBy(people[0])) || 'them'
    sayItemsUnder(
      speech,
      pressing([...mine.values()], clock),
      clock,
      {
        one: `You have one action open from your meetings with ${them}:`,
        many: (n) => `You have ${moreOfMine ? 'at least ' : ''}${count(n, 'action')} open from your meetings with ${them}`,
      },
      mine.size,
      moreOfMine,
    )
  }
  return speech
}

/** A guest in the CRM, as the brief calls them: "Jessa". */
function calledBy(person: PersonContext): string | null {
  const { full_name, email } = person.contact
  return firstName(clause(full_name) || (email ? nameFromEmail(email) : null))
}

/** "Two action items from that meeting are still open, one of them yours":
 *  the heading of two or more (a lone one is said in its own sentence). */
function stillOpen(open: number, mine: number): string {
  const yours = mine === 0 ? null : mine < open ? `${numberWord(mine)} of them yours` : 'all of them yours'
  return [`${count(open, 'action item')} from that meeting are still open`, yours].filter(Boolean).join(', ')
}

/**
 * Who is coming, the user left out: "Jessa Lin and Jordan Lee from Acme" (a
 * few people from one company), "Jessa Lin from Acme and Sam Park", "Jessa Lin,
 * Sam Park and 118 others". `unnamed`: invited, but beyond the guests the
 * client sent. Null for no one.
 */
function withWhom(people: Attendee[], unnamed: number): string | null {
  const companies = new Set(people.map((p) => p.company ?? ''))
  const [company] = [...companies]
  const together = companies.size === 1 && company && people.length <= 3 && !unnamed && listOf(people.map((p) => p.name))
  if (together) return `${together} from ${company}`
  const names = people.map((p) => personLine(p.name, null, p.company) ?? p.name)
  if (!unnamed) return listOf(names)
  const shown = names.slice(0, 2)
  const rest = names.length - shown.length + unnamed
  if (!shown.length) return count(rest, 'person', 'people')
  return `${shown.join(', ')} and ${rest === 1 ? 'one other' : `${numberWord(rest)} others`}`
}

type Timing = 'ahead' | 'now' | 'over'

/** Where the event stands: an all-day one by the user's calendar day. */
function timingOf(event: EventInput, clock: Clock): Timing {
  if (event.isAllDay) {
    const today = dayIn(clock.now, clock.timeZone)
    const first = calendarDay(event.start, clock.timeZone)
    // The end day is exclusive (the day after the last), as providers send it.
    const end = event.end ? calendarDay(event.end, clock.timeZone) : ''
    if (today < first) return 'ahead'
    return (end > first ? today >= end : today > first) ? 'over' : 'now'
  }
  const now = clock.now.getTime()
  const start = Date.parse(event.start)
  const end = Math.max(Date.parse(event.end ?? '') || start, start)
  if (now < start) return 'ahead'
  return now < end ? 'now' : 'over'
}

/** An all-day event's days, as said: its first ("tomorrow", "on Friday"),
 *  and its last when it runs several. The end day is exclusive (the day after
 *  the last), as providers send it. */
function allDays(event: EventInput, clock: Clock): { first: string | null; last: string | null } {
  const first = calendarDay(event.start, clock.timeZone)
  const end = event.end ? calendarDay(event.end, clock.timeZone) : ''
  const last = end > first ? dayBefore(end) : first
  return { first: describeDay(first, clock), last: last > first ? describeDay(last, clock) : null }
}

/** "on Friday" → "Friday", for "from Friday through tomorrow". */
function bare(day: string): string {
  return day.replace(/^on /, '')
}

/** "2026-10-01" → "2026-09-30". */
function dayBefore(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

const LINK = /https?:\/\/\S+/gi
const VIDEO_LINK = /(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com)\//i
/** A location that only names the call's app: Teams puts "Microsoft Teams
 *  Meeting" on every invite. */
const VIDEO_APP = /^(?:microsoft teams|teams|zoom|google meet|webex|skype)(?: meeting)?$/i

/** "on a video call", "at Blue Bottle, Hayes Valley", "at Room 4B or on a
 *  video call". A location that is only a join link, or the call's app, is
 *  the video call. */
function whereOf(event: EventInput): string | null {
  const raw = event.location ?? ''
  const place = clause(raw.replace(LINK, ' ').replace(/^[\s,;:|-]+|[\s,;:|-]+$/g, ''))
  const app = !!place && VIDEO_APP.test(place)
  const at = place && !app ? `at ${place}` : null
  if (event.hasVideoCall === true || VIDEO_LINK.test(raw) || app) return at ? `${at} or on a video call` : 'on a video call'
  return at
}

/** Where what calendars append for the call begins (join links, dial-ins,
 *  "Please do not edit this section"): Google Meet's marker line, Teams'
 *  rule, Zoom's and Meet's headings. */
const CONFERENCING = /-::~:~::~|_{20,}|Join Zoom Meeting|Join with Google Meet/i

/**
 * The invite's description as something to read: HTML flattened, the
 * conferencing text calendars append cut off, links dropped. Null when
 * nothing is left.
 */
export function agendaOf(description: string | null | undefined): string | null {
  let text = description ?? ''
  // Tags never span a "<" or ">", which keeps these linear on any input.
  if (/<\/?[a-z][^<>]*>/i.test(text)) {
    text = text
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<(?:ul|ol)\b[^<>]*>/gi, '\n')
      .replace(/<\/(?:p|div|li|h[1-6]|tr|ul|ol)>/gi, '\n')
      .replace(/<li\b[^<>]*>/gi, '- ')
      .replace(/<[^<>]*>/g, '')
  }
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
  const footer = text.search(CONFERENCING)
  if (footer >= 0) text = text.slice(0, footer)
  text = text
    .replace(LINK, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text || null
}

/** A line of an invite that is a list item: "- ", "* ", "• ", "1. ". */
const LIST_ITEM = /^\s*(?:[-*•◦▪]|\d{1,3}[.)])\s+/
/** "Hi all," "Hello team!": nothing to hear. */
const GREETING = /^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening))\b[^.?:]{0,24}[,!]?$/i

/**
 * What the invite says, as its first `max` sentences (agendaOf's text): a
 * list is one sentence ("The new tiers, the launch date and Q&A"), joined to
 * the line that leads into it ("Agenda: …"), and a greeting is skipped.
 */
export function inviteSays(description: string | null | undefined, max = 2): string[] {
  const agenda = agendaOf(description)
  if (!agenda) return []
  const lines = agenda.split('\n').flatMap((raw) => {
    const text = plainTextToSpeech(raw.replace(LIST_ITEM, ''))
    return text ? [{ text, listed: LIST_ITEM.test(raw) }] : []
  })

  const units: string[] = []
  let i = 0
  while (i < lines.length) {
    // A line ending in ":" leads into what comes after it.
    const lead = units[units.length - 1]?.endsWith(':') ? (units.pop() ?? null) : null
    // A list: listed lines, or under a lead, lines with no full stop of their own.
    const items: string[] = []
    while (i < lines.length && (lines[i].listed || (lead && !/[.!?:]$/.test(lines[i].text)))) {
      items.push(lines[i++].text.replace(/[\s.;:,]+$/, ''))
    }
    const text = items.length ? listOf(items, 4, 'more') : lines[i++].text
    if (!text || (!lead && !items.length && GREETING.test(text))) continue
    units.push(lead ? `${lead} ${text}` : text)
  }
  const last = units.length - 1
  if (last >= 0) units[last] = units[last].replace(/:$/, '')
  return units.flatMap((unit) => splitSentences(unit)).slice(0, max)
}

/** An all-day date's calendar day: its own date when it is a bare date or UTC
 *  midnight (how Google and Microsoft send one), else the day it falls on in
 *  the user's zone. */
const BARE_DAY = /^(\d{4}-\d{2}-\d{2})(?:$|T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00(?::?00)?)$)/

function calendarDay(value: string, timeZone: string): string {
  const bare = BARE_DAY.exec(value)
  return bare ? bare[1] : dayIn(new Date(value), timeZone)
}

/** "2026-09-27": the day `date` falls on in the zone. */
function dayIn(date: Date, timeZone: string): string {
  return format(new TZDate(date, safeTimeZone(timeZone)), 'yyyy-MM-dd')
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** Whether the capture linked to this event is a recording of it
 *  (recordsThisMeeting), read with the capture fences. */
async function isLinkedRecording(ctx: BriefContext, event: EventInput): Promise<boolean> {
  if (!event.linkedCaptureId) return false
  const result = await applyCaptureVisibility(
    ctx.supabase
      .from('captures')
      .select('started_at, occurrence_start')
      .eq('id', event.linkedCaptureId)
      .eq('workspace_id', ctx.workspaceId),
    ctx.userId,
  ).maybeSingle()
  const capture = row('linked capture', result as OneResult<{ started_at: string | null; occurrence_start: string | null }>)
  return recordsThisMeeting(capture, event)
}

/** The CRM rows behind the invite's addresses, by main or other address. */
async function matchContacts(ctx: BriefContext, emails: string[]): Promise<ContactMatch[]> {
  if (emails.length === 0) return []
  const contacts = () =>
    ctx.supabase
      .from('contact')
      .select('id, full_name, email, secondary_emails, job_title, member_id, company:company_id(name)')
      .eq('workspace_id', ctx.workspaceId)
      .is('merged_into_contact_id', null)
  const [main, other] = await Promise.all([
    contacts().in('email', emails).limit(60),
    contacts().overlaps('secondary_emails', emails).limit(60),
  ])
  return [
    ...rows('contacts', main as Result<ContactMatch>),
    ...rows('contacts (other addresses)', other as Result<ContactMatch>),
  ]
}

const PRIOR_SELECT = 'id, title, ai_summary, summary, started_at, occurrence_start'

/** Recorded meetings of this series that started before it, newest first. One
 *  read per key: provider ids can hold PostgREST's or-syntax characters. */
async function seriesCaptures(ctx: BriefContext, id: string, event: EventInput): Promise<PriorCapture[]> {
  const before = new Date(event.start).toISOString()
  const keys = seriesKeys(id, event)
  const results = await Promise.all(
    keys.map(({ column, value }) =>
      applyCaptureVisibility(
        ctx.supabase
          .from('captures')
          .select(PRIOR_SELECT)
          .eq('workspace_id', ctx.workspaceId)
          .eq(column, value)
          .neq('status', 'archived')
          .not('started_at', 'is', null)
          .lt('started_at', before),
        ctx.userId,
      )
        .order('started_at', { ascending: false })
        .limit(4),
    ),
  )
  return results.flatMap((result, i) => rows(`series (${keys[i].column})`, result as Result<PriorCapture>))
}

/** Guests beyond this many make an audience: the latest meeting with any one
 *  of them says nothing about this one, nor does who of them declined. */
const MAX_GUESTS_FOR_HISTORY = 8

/** The previous meeting of the series, else the latest with these guests,
 *  with what came out of it. */
async function previousMeeting(
  ctx: BriefContext,
  event: EventInput,
  series: PriorCapture[],
  guests: Attendee[],
): Promise<PreviousMeeting | null> {
  let via: PreviousMeeting['via'] = 'series'
  let capture = pickPrevious(series, event)
  if (!capture) {
    const emails = guests.map((g) => g.email)
    if (emails.length === 0 || emails.length > MAX_GUESTS_FOR_HISTORY) return null
    via = 'guests'
    capture = pickPrevious(await capturesWith(ctx, emails, event), event)
    if (!capture) return null
  }
  const followUps = await ctx.supabase
    .from('actions')
    .select(`id, title, due_at, priority, assignee_id, context_data, workflow_state:workflow_state!status_id(category), ${OWNER_EMBEDS}`)
    .eq('source_capture_id', capture.id)
    .eq('workspace_id', ctx.workspaceId)
    .neq('confirmation', 'dismissed')
    .limit(50)
  return { via, capture, followUps: rows('follow-ups', followUps as Result<FollowUpRow>) }
}

/** Recorded meetings with any of these guests (by the address they joined
 *  with) that started before this one, newest first. */
async function capturesWith(ctx: BriefContext, emails: string[], event: EventInput): Promise<PriorCapture[]> {
  const result = await applyCaptureVisibility(
    ctx.supabase
      .from('captures')
      .select(`${PRIOR_SELECT}, cp:capture_participant!inner(external_email)`)
      .eq('workspace_id', ctx.workspaceId)
      .in('cp.external_email', emails)
      .neq('status', 'archived')
      .not('started_at', 'is', null)
      .lt('started_at', new Date(event.start).toISOString()),
    ctx.userId,
  )
    .order('started_at', { ascending: false })
    .limit(4)
  return rows('meetings with the guests', result as Result<PriorCapture>)
}

/** How many guests' CRM context a brief gathers. */
const MAX_PEOPLE = 3

/** What is open with up to MAX_PEOPLE guests in the CRM (the organizer
 *  first, not those who declined), in parallel; one that can't be read is
 *  left out. */
async function peopleContext(ctx: BriefContext, guests: Attendee[]): Promise<PersonContext[]> {
  const contactIds = guests
    .filter((g) => g.contactId && !g.declined)
    .sort((a, b) => Number(b.organizer) - Number(a.organizer))
    .flatMap((g) => (g.contactId ? [g.contactId] : []))
    .slice(0, MAX_PEOPLE)
  const settled = await Promise.allSettled(
    contactIds.map((contactId) =>
      gatherPersonContext(ctx.service, {
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        contactId,
        requester: ctx.userId,
      }),
    ),
  )
  return settled.flatMap((r) => {
    if (r.status === 'rejected') {
      console.warn('[listen-brief] person context failed:', r.reason)
      return []
    }
    return r.value ? [r.value] : []
  })
}
