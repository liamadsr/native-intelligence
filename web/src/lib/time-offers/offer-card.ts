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
  offers: Array<{ id: string; recipient: string; title: string; state: OfferState; times: Array<{ label: string; booked: boolean }>; expires: string | null }>
  bookings: Array<{ id: string; guest: string; title: string; when: string; state: MeetingBookingState }>
}

export type TimeOfferCardData = OfferCardData | BookedCardData | OfferListCardData

/** The tools that draw a card here. */
export const TIME_OFFER_CARD_TOOLS = ['offer_times', 'accept_time_offer', 'list_time_offers'] as const

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

function bookingOf(b: unknown): { id: string; guest: string; title: string; when: string; state: MeetingBookingState; videoLink: string | null } | null {
  if (!isRecord(b)) return null
  const state = bookingState(b.state)
  const guest = isRecord(b.guest) ? str(b.guest.name) : null
  const title = str(b.title)
  const when = str(b.when)
  if (!state || !guest || !title || !when) return null
  return { id: str(b.booking_id) ?? `${guest}-${when}`, guest, title, when, state, videoLink: str(b.video_link) }
}

function listCardOf(o: Record<string, unknown>): OfferListCardData | null {
  const offers: OfferListCardData['offers'] = []
  for (const item of Array.isArray(o.offers) ? o.offers : []) {
    if (!isRecord(item)) continue
    const state = offerState(item.state)
    const recipient = isRecord(item.recipient) ? str(item.recipient.name) : null
    const title = str(item.title)
    if (!state || !recipient || !title) continue
    const times = (Array.isArray(item.times) ? item.times : [])
      .filter(isRecord)
      .map((t) => ({ label: str(t.label), booked: t.state === 'booked' }))
      .filter((t): t is { label: string; booked: boolean } => !!t.label)
    offers.push({ id: str(item.offer_id) ?? `${recipient}-${offers.length}`, recipient, title, state, times, expires: str(item.expires) })
  }
  const bookings = (Array.isArray(o.bookings) ? o.bookings : []).map(bookingOf).filter((b): b is NonNullable<ReturnType<typeof bookingOf>> => !!b)
  if (!offers.length && !bookings.length) return null
  return { kind: 'list', offers, bookings: bookings.map(({ id, guest, title, when, state }) => ({ id, guest, title, when, state })) }
}

export function timeOfferCardOf(toolName: string, output: unknown): TimeOfferCardData | null {
  if (!isRecord(output) || output.success !== true) return null
  if (toolName === 'offer_times') return offerCardOf(output)
  if (toolName === 'list_time_offers') return listCardOf(output)
  if (toolName === 'accept_time_offer') {
    const b = bookingOf(output.booking)
    return b ? { kind: 'booked', guest: b.guest, title: b.title, when: b.when, state: b.state, videoLink: b.videoLink, already: output.already_booked === true } : null
  }
  return null
}
