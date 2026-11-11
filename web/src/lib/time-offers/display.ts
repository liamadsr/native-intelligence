/**
 * What the guest's pages draw (availability phase 3b): the offer's page
 * /t/<token> (src/app/t/[token]/), a poll guest's page at the same address
 * (phase 5), and the manage page /b/<token> (src/app/b/[token]/). The shapes the public API answers
 * (./public.ts publicOffer / publicBooking), the times grouped by day in the
 * guest's own zone, and what each error of the API means to a guest.
 *
 * Pure and client-safe: no node imports (./words.ts hashes, so it isn't).
 */
import { zoneAbbreviation } from '@/lib/availability/zone'
import type { PublicOfferState } from './types'

export interface PublicSlot {
  start: string
  end: string
}

/** GET /api/public/time-offers/<token>'s `offer`. */
export interface PublicOfferData {
  state: PublicOfferState
  host_name: string
  title: string
  duration_minutes: number
  video: boolean
  location: string | null
  message: string | null
  time_zone: string
  expires_at: string
  recipient_name: string
  needs_email: boolean
  slots: PublicSlot[]
  booked_start: string | null
}

/** A poll guest's own answer, as their page shows it. */
export interface PublicPollAnswer {
  /** The starts of the times that work for them. */
  works: string[]
  none: boolean
  note: string | null
  answered_at: string
  /** Filled in from their own calendar (a linked guest): they can still change it. */
  from_calendar: boolean
}

/**
 * GET /api/public/time-offers/<token>'s `poll` (phase 5): one guest's page of
 * a poll. Of the other guests only counts: never a name or an answer.
 */
export interface PublicPollData {
  state: PublicOfferState
  host_name: string
  title: string
  duration_minutes: number
  video: boolean
  location: string | null
  message: string | null
  time_zone: string
  expires_at: string
  /** Their own name, as the host gave it. */
  recipient_name: string
  /** The times still open to mark. */
  slots: PublicSlot[]
  answer: PublicPollAnswer | null
  /** How many people the poll went to, them included, and how many of them are still to answer. */
  guests: number
  waiting: number
  /** Once booked: the meeting, and whether they are on it (with their own manage link). */
  booked: { start: string; end: string; attending: boolean; video: boolean; conference_url: string | null; location: string | null; manage_url: string | null } | null
}

/** POST /api/public/time-offers/<token>/answer's answer: the page as it is now. */
export interface AnsweredPoll {
  ok: true
  poll: PublicPollData
}

/** What a server-rendered poll page starts from. */
export type OfferPageLoad = PageLoad<PublicOfferData> | { kind: 'poll'; data: PublicPollData }

/** GET /api/public/bookings/<token>'s `booking`. */
export interface PublicBookingData {
  /** requested: a booking link's request still waiting on the host's yes; declined and expired: the host said no, or never answered. */
  state: 'requested' | 'booking' | 'confirmed' | 'declined' | 'expired' | 'cancelled' | 'failed'
  /** The host still has to say yes (state requested). */
  awaiting_host: boolean
  title: string
  start: string
  end: string
  host_name: string
  guest_name: string
  /** The zone the guest picked in (the server's first render's), else UTC. */
  time_zone: string
  video: boolean
  conference_url: string | null
  location: string | null
  can_cancel: boolean
  can_reschedule: boolean
  reschedules_left: number
  /**
   * A poll's group meeting, read through one guest's own link (phase 5):
   * they can say they can't make it (can_cancel), never move or cancel it
   * for everyone; `attending` false once they said so (or were left out).
   */
  group?: { attending: boolean }
}

/** The accept's 201 / 200 answer. */
export interface AcceptedBooking {
  already: boolean
  status: string
  booking: { start: string; end: string; title: string; host_name: string; video: boolean; conference_url: string | null; location: string | null }
  manage_url: string
}

/** What a server-rendered page starts from: found, not there, or the read failed. */
/** `at`: when the server read it, so the page's first render and the browser's agree on "now". */
export type PageLoad<T> = { kind: 'found'; data: T; at?: number } | { kind: 'missing' } | { kind: 'error' }

const tidy = (s: string) => s.replace(/[  ]/g, ' ')

function format(at: number, timeZone: string, options: Intl.DateTimeFormatOptions): string {
  try {
    return tidy(new Intl.DateTimeFormat('en-US', { timeZone, ...options }).format(new Date(at)))
  } catch {
    return tidy(new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...options }).format(new Date(at)))
  }
}

/** Whether `timeZone` is one this browser knows. */
export function isTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** "Tuesday, November 17". */
export const dayLabel = (iso: string, timeZone: string) => format(Date.parse(iso), timeZone, { weekday: 'long', month: 'long', day: 'numeric' })

/** "Tue, Nov 17". */
export const shortDayLabel = (iso: string, timeZone: string) => format(Date.parse(iso), timeZone, { weekday: 'short', month: 'short', day: 'numeric' })

/** "10:00 AM". */
export const clockLabel = (iso: string, timeZone: string) => format(Date.parse(iso), timeZone, { hour: 'numeric', minute: '2-digit' })

/** The zone's short name at that instant ("EST"), else the zone itself. */
export function zoneShort(timeZone: string, at: number): string {
  return zoneAbbreviation(timeZone, at) ?? timeZone
}

/** "Tuesday, November 17 · 10:00 AM – 10:30 AM EST". */
export function whenLabel(start: string, end: string, timeZone: string): string {
  return `${dayLabel(start, timeZone)} · ${clockLabel(start, timeZone)} – ${clockLabel(end, timeZone)} ${zoneShort(timeZone, Date.parse(start))}`
}

/** "30 min", "1 hr", "1 hr 30 min". */
export function lengthLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h} hr ${m} min` : `${h} hr`
}

export interface DayGroup {
  key: string
  label: string
  slots: Array<PublicSlot & { time: string }>
}

/** The times by local day in `timeZone`, soonest first. */
export function groupByDay(slots: readonly PublicSlot[], timeZone: string): DayGroup[] {
  const days: DayGroup[] = []
  for (const slot of [...slots].sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) {
    const label = dayLabel(slot.start, timeZone)
    const last = days[days.length - 1]
    const item = { ...slot, time: clockLabel(slot.start, timeZone) }
    if (last && last.label === label) last.slots.push(item)
    else days.push({ key: `${slot.start}`, label, slots: [item] })
  }
  return days
}

const SOMETHING_WRONG = "That didn't go through. Try again in a moment."

interface ApiError {
  error?: unknown
  code?: unknown
  details?: unknown
}

const messageOf = (body: ApiError | null, fallback: string) => (body && typeof body.error === 'string' && body.error ? body.error : fallback)

function slotsOf(details: unknown): PublicSlot[] {
  const slots = details && typeof details === 'object' ? (details as { slots?: unknown }).slots : null
  if (!Array.isArray(slots)) return []
  return slots.filter((s): s is PublicSlot => !!s && typeof s === 'object' && typeof s.start === 'string' && typeof s.end === 'string')
}

/** What a failed pick means on the offer's page. */
export type PickFailure =
  | { kind: 'slot_taken'; slots: PublicSlot[] }
  | { kind: 'closed'; state: Exclude<PublicOfferState, 'open'> }
  | { kind: 'missing' }
  | { kind: 'needs_email'; message: string }
  | { kind: 'message'; message: string }

/** A failed POST /accept, read for the guest (null `body` for a network error). Pure. */
export function pickFailure(status: number, body: ApiError | null, hostName: string): PickFailure {
  const code = body?.code
  if (status === 409 && code === 'SLOT_TAKEN') return { kind: 'slot_taken', slots: slotsOf(body?.details) }
  if (status === 410) return { kind: 'closed', state: code === 'BOOKED' ? 'booked' : code === 'WITHDRAWN' ? 'withdrawn' : 'expired' }
  if (status === 404) return { kind: 'missing' }
  if (status === 400 && code === 'NEEDS_EMAIL') return { kind: 'needs_email', message: messageOf(body, 'Add your email so the invitation can reach you.') }
  if (status === 400 || status === 429) return { kind: 'message', message: messageOf(body, SOMETHING_WRONG) }
  if (status === 503) return { kind: 'message', message: `We couldn't check ${hostName}'s calendar just now. Try again in a minute.` }
  return { kind: 'message', message: SOMETHING_WRONG }
}

/** What a failed save of a poll answer means on the guest's page. */
export type AnswerFailureView =
  | { kind: 'closed'; state: Exclude<PublicOfferState, 'open'> }
  | { kind: 'missing' }
  /** A marked time passed or was taken meanwhile: the times still open, so the page can drop the gone marks. */
  | { kind: 'slots'; slots: PublicSlot[]; message: string }
  | { kind: 'message'; message: string }

/** A failed POST /answer, read for the guest (null `body` for a network error). Pure. */
export function answerFailure(status: number, body: ApiError | null): AnswerFailureView {
  const code = body?.code
  if (status === 410) return { kind: 'closed', state: code === 'BOOKED' ? 'booked' : code === 'WITHDRAWN' ? 'withdrawn' : 'expired' }
  if (status === 404) return { kind: 'missing' }
  if (status === 429) return { kind: 'message', message: messageOf(body, 'Too many changes today. Reply to the host instead.') }
  if (status === 400 && Array.isArray((body?.details as { slots?: unknown } | undefined)?.slots)) {
    return { kind: 'slots', slots: slotsOf(body?.details), message: `${messageOf(body, 'A time you marked is no longer available.')} It's unmarked: check your answer and save again.` }
  }
  if (status === 400) return { kind: 'message', message: messageOf(body, SOMETHING_WRONG) }
  return { kind: 'message', message: SOMETHING_WRONG }
}

/** "2 people still to answer", "Everyone has answered": counts only, never who. Pure. */
export function waitingLabel(waiting: number, answered: boolean): string | null {
  if (!answered) return null
  if (waiting <= 0) return 'Everyone has answered.'
  return waiting === 1 ? '1 person still to answer.' : `${waiting} people still to answer.`
}

/** What a failed cancel, move or move's times means on the manage page. */
export type ManageFailureView = { kind: 'slot_taken'; message: string } | { kind: 'reload'; message: string } | { kind: 'missing' } | { kind: 'message'; message: string }

/** A failed manage call, read for the guest (null `body` for a network error). Pure. */
export function manageFailureView(status: number, body: ApiError | null): ManageFailureView {
  if (status === 409) return { kind: 'slot_taken', message: 'That time was just taken. Pick another.' }
  if (status === 410) return { kind: 'reload', message: messageOf(body, 'This meeting changed.') }
  if (status === 404) return { kind: 'missing' }
  if (status === 400 || status === 429) return { kind: 'message', message: messageOf(body, SOMETHING_WRONG) }
  if (status === 503) return { kind: 'message', message: "The calendar couldn't be checked just now. Try again in a minute." }
  return { kind: 'message', message: SOMETHING_WRONG }
}

/**
 * Where a booking stands for its guest now. `awaiting`: a booking link's
 * request the host hasn't said yes to; `declined` and `expired`: one they
 * said no to, or never answered (never a meeting that was cancelled).
 */
export type BookingPhase = 'upcoming' | 'pending' | 'awaiting' | 'live' | 'past' | 'cancelled' | 'declined' | 'expired' | 'failed'

export function bookingPhase(b: Pick<PublicBookingData, 'state' | 'start' | 'end'> & Partial<Pick<PublicBookingData, 'awaiting_host'>>, now: number): BookingPhase {
  if (b.state === 'cancelled') return 'cancelled'
  if (b.state === 'declined') return 'declined'
  if (b.state === 'expired') return 'expired'
  if (b.state === 'failed') return 'failed'
  // A request whose time came before the host's yes was never booked.
  if (b.awaiting_host || b.state === 'requested') return Date.parse(b.start) <= now ? 'expired' : 'awaiting'
  if (Date.parse(b.end) <= now) return 'past'
  if (Date.parse(b.start) <= now) return 'live'
  return b.state === 'booking' ? 'pending' : 'upcoming'
}

/** "You can move it 2 more times": said once a move has been used, and never at 0 (no button then). */
export function movesLeftLabel(left: number, max: number): string | null {
  if (left <= 0 || left >= max) return null
  return left === 1 ? 'You can move it one more time.' : `You can move it ${left} more times.`
}
