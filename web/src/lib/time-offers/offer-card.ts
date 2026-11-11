/**
 * What the chat's time-offer cards draw (src/app/account/(dashboard)/chat/
 * time-offer-card.tsx), read from the tools' answers
 * (src/lib/ai/tools/time-offers.ts, ./send.ts offerResult):
 *
 *   offer_times        who, what, the times held, the link to copy, and
 *                      whether it went (by email or text) or waits to be
 *                      pasted
 *   accept_time_offer  the meeting booked: who, when, its video link
 *   list_time_offers   each offer with its state, each booking with its time
 *                      (from an offer or a booking link)
 *
 * A poll (availability phase 5: offer_times with several guests) is a small
 * grid in both: each guest by each time (works, doesn't, waiting; answered
 * from their calendar marked), each guest's link to copy, and the booked
 * meeting or the best option when none works for all.
 * record_time_offer_answer and book_poll_time draw the booked card when
 * they booked.
 *
 * Only what the answer already says to the person. Null (the generic chip
 * instead) for a refusal, or a list with nothing in it. Pure.
 */
import { OFFER_STATES, MEETING_BOOKING_STATES, type MeetingBookingState, type OfferState } from './types'

export interface OfferCardData {
  kind: 'offer'
  recipient: string | null
  title: string | null
  durationMinutes: number | null
  /** Each "Tue, Nov 17, 10:00 AM EST". */
  times: string[]
  link: string
  sentVia: 'link' | 'email' | 'text'
  to: string | null
  expires: string | null
  pasteText: string | null
}

/** One guest's row of a poll's grid. */
export interface PollGuestCell {
  id: string
  name: string
  link: string | null
  answered: boolean
  /** The starts that work for them. */
  works: string[]
  fromCalendar: boolean
  /** Null until booked. */
  attending: boolean | null
}

export interface PollCardData {
  kind: 'poll'
  title: string | null
  durationMinutes: number | null
  state: OfferState
  /** Each time's start, its label ("Tue, Nov 17, 10:00 AM EST"), and whether it is the booked one. */
  times: Array<{ start: string; label: string; booked: boolean }>
  guests: PollGuestCell[]
  sentVia: 'link' | 'email' | 'text' | null
  expires: string | null
  /** The time most can make, when everyone answered and none works for all. */
  best: string | null
  /** The booked meeting, when the answer named it. */
  booking: { when: string; videoLink: string | null; state: MeetingBookingState } | null
  coHosts: number
}

export interface BookedCardData {
  kind: 'booked'
  guest: string
  title: string
  when: string
  state: MeetingBookingState
  videoLink: string | null
  already: boolean
}

export interface OfferListCardData {
  kind: 'list'
  /** A poll's offers carry their grid (`poll`). */
  offers: Array<{ id: string; recipient: string; title: string; state: OfferState; times: Array<{ label: string; booked: boolean }>; expires: string | null; poll?: PollCardData }>
  /** `fromLink`: booked from one of the person's booking links, not an offer. */
  bookings: Array<{ id: string; guest: string; title: string; when: string; state: MeetingBookingState; fromLink: boolean }>
}

export type TimeOfferCardData = OfferCardData | PollCardData | BookedCardData | OfferListCardData

/** The tools that draw a card here. */
export const TIME_OFFER_CARD_TOOLS = ['offer_times', 'accept_time_offer', 'list_time_offers', 'record_time_offer_answer', 'book_poll_time'] as const

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const offerState = (v: unknown): OfferState | null => ((OFFER_STATES as readonly unknown[]).includes(v) ? (v as OfferState) : null)
const bookingState = (v: unknown): MeetingBookingState | null => ((MEETING_BOOKING_STATES as readonly unknown[]).includes(v) ? (v as MeetingBookingState) : null)

function offerCardOf(o: Record<string, unknown>): OfferCardData | null {
  const link = str(o.link)
  const sentVia = o.sent_via === 'email' || o.sent_via === 'text' || o.sent_via === 'link' ? o.sent_via : null
  if (!link || !sentVia || !Array.isArray(o.times)) return null
  return {
    kind: 'offer',
    recipient: str(o.recipient_name),
    title: str(o.title),
    durationMinutes: typeof o.duration_minutes === 'number' ? o.duration_minutes : null,
    times: o.times.map((t) => (isRecord(t) ? str(t.label) : null)).filter((t): t is string => !!t),
    link,
    sentVia,
    to: str(o.to),
    expires: str(o.expires),
    pasteText: str(o.paste_text),
  }
}

/** A poll's grid from offer_times' answer or a list_time_offers item; null when it isn't a poll. */
function pollCardOf(o: Record<string, unknown>, bookings: ReadonlyArray<{ id: string; when: string; videoLink: string | null; state: MeetingBookingState }> = []): PollCardData | null {
  if (o.mode !== 'poll' || !Array.isArray(o.guests) || !Array.isArray(o.times)) return null
  const times = o.times
    .filter(isRecord)
    .map((t) => ({ start: str(t.start), label: str(t.label), booked: t.state === 'booked' }))
    .filter((t): t is { start: string; label: string; booked: boolean } => !!t.start && !!t.label)
  const guests: PollGuestCell[] = o.guests.filter(isRecord).flatMap((g) => {
    const name = str(g.name)
    if (!name) return []
    return [
      {
        id: str(g.guest_id) ?? name,
        name,
        link: str(g.link),
        answered: g.answered === true,
        works: Array.isArray(g.works) ? g.works.filter((w): w is string => typeof w === 'string') : [],
        fromCalendar: g.from_calendar === true,
        attending: typeof g.attending === 'boolean' ? g.attending : null,
      },
    ]
  })
  if (!times.length || !guests.length) return null
  const bookingId = str(o.booking_id)
  const booked = bookingId ? bookings.find((b) => b.id === bookingId) : undefined
  const sentVia = o.sent_via === 'email' || o.sent_via === 'text' || o.sent_via === 'link' ? o.sent_via : null
  return {
    kind: 'poll',
    title: str(o.title),
    durationMinutes: typeof o.duration_minutes === 'number' ? o.duration_minutes : null,
    state: offerState(o.state) ?? 'open',
    times,
    guests,
    sentVia,
    expires: str(o.expires),
    best: str(o.best_time),
    booking: booked ? { when: booked.when, videoLink: booked.videoLink, state: booked.state } : null,
    coHosts: typeof o.co_hosts === 'number' ? o.co_hosts : 0,
  }
}

function bookingOf(b: unknown): { id: string; guest: string; title: string; when: string; state: MeetingBookingState; videoLink: string | null; fromLink: boolean } | null {
  if (!isRecord(b)) return null
  const state = bookingState(b.state)
  const guest = isRecord(b.guest) ? str(b.guest.name) : null
  const title = str(b.title)
  const when = str(b.when)
  if (!state || !guest || !title || !when) return null
  return { id: str(b.booking_id) ?? `${guest}-${when}`, guest, title, when, state, videoLink: str(b.video_link), fromLink: b.from_booking_link === true }
}

function listCardOf(o: Record<string, unknown>): OfferListCardData | null {
  const offers: OfferListCardData['offers'] = []
  const bookings = (Array.isArray(o.bookings) ? o.bookings : []).map(bookingOf).filter((b): b is NonNullable<ReturnType<typeof bookingOf>> => !!b)
  for (const item of Array.isArray(o.offers) ? o.offers : []) {
    if (!isRecord(item)) continue
    const state = offerState(item.state)
    const title = str(item.title)
    // A poll's offer: its guests are the grid, named in the list by count.
    const poll = pollCardOf(item, bookings)
    const recipient = poll ? (poll.guests.length === 1 ? poll.guests[0].name : `${poll.guests.length} people`) : isRecord(item.recipient) ? str(item.recipient.name) : null
    if (!state || !recipient || !title) continue
    const times = poll
      ? poll.times.map((t) => ({ label: t.label, booked: t.booked }))
      : (Array.isArray(item.times) ? item.times : [])
          .filter(isRecord)
          .map((t) => ({ label: str(t.label), booked: t.state === 'booked' }))
          .filter((t): t is { label: string; booked: boolean } => !!t.label)
    offers.push({ id: str(item.offer_id) ?? `${recipient}-${offers.length}`, recipient, title, state, times, expires: str(item.expires), ...(poll ? { poll } : {}) })
  }
  if (!offers.length && !bookings.length) return null
  return { kind: 'list', offers, bookings: bookings.map(({ id, guest, title, when, state, fromLink }) => ({ id, guest, title, when, state, fromLink })) }
}

export function timeOfferCardOf(toolName: string, output: unknown): TimeOfferCardData | null {
  if (!isRecord(output) || output.success !== true) return null
  if (toolName === 'offer_times') return output.mode === 'poll' ? pollCardOf(output) : offerCardOf(output)
  if (toolName === 'list_time_offers') return listCardOf(output)
  if (toolName === 'accept_time_offer' || toolName === 'record_time_offer_answer' || toolName === 'book_poll_time') {
    const b = bookingOf(output.booking)
    return b ? { kind: 'booked', guest: b.guest, title: b.title, when: b.when, state: b.state, videoLink: b.videoLink, already: output.already_booked === true } : null
  }
  return null
}
