/**
 * Time offers (availability phase 3a, migration 554): a person offers someone
 * outside the workspace two or three times, the times are held, the guest
 * picks one, it is booked. The shapes and limits every part shares.
 *
 * Pure and client-safe.
 */

export const OFFER_STATES = ['pending_send', 'open', 'booked', 'expired', 'withdrawn', 'declined'] as const
export type OfferState = (typeof OFFER_STATES)[number]

export const SLOT_STATES = ['open', 'booked', 'released'] as const
export type SlotState = (typeof SLOT_STATES)[number]

/**
 * requested: waiting on the host's yes (a booking link that asks first, a
 * customer's job), its time held. declined and expired: the host said no, or
 * never answered. (migration 581)
 */
export const MEETING_BOOKING_STATES = ['requested', 'booking', 'confirmed', 'declined', 'expired', 'cancelled', 'failed'] as const
export type MeetingBookingState = (typeof MEETING_BOOKING_STATES)[number]

/** Where a booking came from: an offer's pick, a booking link, a customer's job (migration 581's fold), a poll (later). */
export const MEETING_BOOKING_SOURCES = ['offer', 'link', 'customer', 'poll'] as const
export type MeetingBookingSource = (typeof MEETING_BOOKING_SOURCES)[number]

/** How an offer reaches its recipient: a link the person pastes themselves, or sent from their mailbox or the business's number. */
export const SEND_BY = ['link', 'email', 'text'] as const
export type SendBy = (typeof SEND_BY)[number]

/** The tool that makes an offer. */
export const OFFER_TIMES_TOOL = 'offer_times' as const

/** How many times one offer holds. */
export const OFFER_SLOTS_MIN = 2
export const OFFER_SLOTS_MAX = 3
/** An offer lapses after this unless it says otherwise, and never after its first time starts. */
export const OFFER_DEFAULT_TTL_MS = 3 * 24 * 60 * 60_000
/** The longest an offer may stay open. */
export const OFFER_MAX_TTL_MS = 14 * 24 * 60 * 60_000
/** The furthest ahead a time may be offered. */
export const OFFER_HORIZON_MS = 60 * 24 * 60 * 60_000
/** A time offered must start at least this far from now. */
export const OFFER_LEAD_MS = 15 * 60_000
/** Offers one person may have live (open or waiting on their card) at once: each holds their time. */
export const OPEN_OFFERS_MAX = 20

/** Failed picks one offer's public page takes in a day before it answers 429. */
export const OFFER_FAILED_PICKS_DAILY_CAP = 5
/** A booking left in 'booking' this long is the sweep's to finish. */
export const BOOKING_STUCK_MS = 2 * 60_000
/** Provider writes one booking gets before it is failed and its time let go. */
export const BOOKING_ATTEMPTS_MAX = 3
/** How many times a guest may move their booking. */
export const RESCHEDULES_MAX = 3
/** How far ahead a guest's move may go. */
export const RESCHEDULE_DAYS = 14

export const RECIPIENT_NAME_MAX = 120
export const TITLE_MAX = 120
export const LOCATION_MAX = 200
/** The person's own line added to an offer's words. */
export const OFFER_MESSAGE_MAX = 160
export const GUEST_NOTE_MAX = 500
export const EMAIL_MAX = 200

export interface OfferSlot {
  id: string
  offerId: string
  startsAt: string
  endsAt: string
  state: SlotState
}

export interface TimeOffer {
  id: string
  workspaceId: string
  hostUserId: string
  createdBy: string | null
  hostName: string
  recipientName: string
  recipientEmail: string | null
  recipientPhone: string | null
  contactId: string | null
  title: string
  durationMinutes: number
  video: boolean
  location: string | null
  message: string | null
  timeZone: string
  state: OfferState
  sentVia: SendBy | null
  cardHash: string | null
  approvalId: string | null
  bookingId: string | null
  expiresAt: string
  createdAt: string
  /** Soonest first. */
  slots: OfferSlot[]
}

export interface MeetingBooking {
  id: string
  workspaceId: string
  hostUserId: string
  hostName: string
  source: MeetingBookingSource
  offerId: string | null
  /** The booking link it was booked from (migration 581). */
  linkId: string | null
  guestName: string
  guestEmail: string | null
  guestPhone: string | null
  guestTimeZone: string | null
  guestNote: string | null
  contactId: string | null
  title: string
  startsAt: string
  endsAt: string
  state: MeetingBookingState
  video: boolean
  location: string | null
  calendarAccountId: string | null
  calendarId: string | null
  calendarEventId: string | null
  conferenceUrl: string | null
  attempts: number
  rescheduleCount: number
  lastError: string | null
  cancelledBy: 'guest' | 'host' | null
  /** The guest's answers to the link's questions: their words, never instructions. */
  answers: BookingAnswer[]
  /** The other hosts who attend (a link's host_mode all); hostUserId organizes. */
  otherHostIds: string[]
  /** The zone the host's words about it use. */
  hostTimeZone: string | null
  createdAt: string
  updatedAt: string
}

/** One answer to a booking link's question. */
export interface BookingAnswer {
  id: string
  label: string
  answer: string
}

/** What the public page shows of an offer's state. */
export type PublicOfferState = 'open' | 'booked' | 'expired' | 'withdrawn'

/** An offer's state as its page reads it now (an open offer past its expiry reads expired). Pure. */
export function publicOfferState(offer: Pick<TimeOffer, 'state' | 'expiresAt'>, now: number): PublicOfferState {
  if (offer.state === 'booked') return 'booked'
  if (offer.state === 'open') return Date.parse(offer.expiresAt) > now ? 'open' : 'expired'
  if (offer.state === 'expired') return 'expired'
  return 'withdrawn'
}

/** The slots still open to pick, soonest first. Pure. */
export function openSlotsOf(offer: Pick<TimeOffer, 'slots' | 'state' | 'expiresAt'>, now: number): OfferSlot[] {
  if (publicOfferState(offer, now) !== 'open') return []
  return offer.slots.filter((s) => s.state === 'open' && Date.parse(s.startsAt) > now)
}
