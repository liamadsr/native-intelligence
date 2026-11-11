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

/** Where a booking came from: an offer's pick, a booking link, a customer's job (migration 581's fold), a poll (migration 583). */
export const MEETING_BOOKING_SOURCES = ['offer', 'link', 'customer', 'poll'] as const
export type MeetingBookingSource = (typeof MEETING_BOOKING_SOURCES)[number]

/** How an offer reaches its recipient: a link the person pastes themselves, or sent from their mailbox or the business's number. */
export const SEND_BY = ['link', 'email', 'text'] as const
export type SendBy = (typeof SEND_BY)[number]

/** The tool that makes an offer. */
export const OFFER_TIMES_TOOL = 'offer_times' as const
/** The tool that reminds a poll's guests who haven't answered (availability phase 5). */
export const NUDGE_TIME_OFFER_TOOL = 'nudge_time_offer' as const

/**
 * pick: one guest picks one time (phase 3a). poll: several guests each mark
 * every time that works, booked when all have answered (phase 5, migration
 * 583). A single offer is a poll of one that books on the first pick.
 */
export const OFFER_MODES = ['pick', 'poll'] as const
export type OfferMode = (typeof OFFER_MODES)[number]

/** How a poll guest's answer came: their page, the host's agent reading their reply, the business's assistant reading their text, or their own calendar. */
export const ANSWER_VIA = ['link', 'host', 'text', 'calendar'] as const
export type AnswerVia = (typeof ANSWER_VIA)[number]

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
/** A poll's guests: two (or one with co-hosts) to eight. */
export const POLL_RECIPIENTS_MAX = 8
/** A poll's times: a handful, more than a pick's. */
export const POLL_SLOTS_MAX = 6
/** Teammates who may co-host a poll's meeting. */
export const POLL_CO_HOSTS_MAX = 4
/** Saves one guest's poll page takes in a day before it answers 429. */
export const POLL_SAVES_DAILY_CAP = 20
/** Nudges one guest gets at most, and how long between two. */
export const POLL_NUDGES_MAX = 3
export const POLL_NUDGE_GAP_MS = 12 * 60 * 60_000
export const POLL_NOTE_MAX = 300
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
  /** pick (one guest, recipient*), or poll (its guests are PollRecipient rows). Migration 583. */
  mode: OfferMode
  /** A poll's co-hosts: teammates whose time is held with the host's, and who attend. */
  coHostIds: string[]
}

/** One guest of a poll (migration 583 time_offer_recipient). */
export interface PollRecipient {
  id: string
  offerId: string
  workspaceId: string
  position: number
  name: string
  email: string | null
  phone: string | null
  contactId: string | null
  /** A linked guest: their Native Intelligence user, whose free/busy the host's agent may read. */
  peerUserId: string | null
  /** Their link is live (the poll was sent). */
  sent: boolean
  answeredAt: string | null
  answeredVia: AnswerVia | null
  note: string | null
  nudges: number
  nudgedAt: string | null
  /** Null until booked; then whether they are on the meeting. */
  attending: boolean | null
  declinedAt: string | null
  /** The open times that work for them (slot ids), from their answer. */
  works: string[]
}

/** A poll with its guests and their answers. */
export interface TimeOfferPoll extends TimeOffer {
  recipients: PollRecipient[]
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

/** Whether every guest of a poll has answered. Pure. */
export function everyoneAnswered(recipients: readonly Pick<PollRecipient, 'answeredAt'>[]): boolean {
  return recipients.length > 0 && recipients.every((r) => r.answeredAt !== null)
}

/**
 * The open times that work for every guest, soonest first: the one to book
 * is the first (the earliest common time). Pure.
 */
export function commonSlots(poll: Pick<TimeOfferPoll, 'slots' | 'recipients'>, now: number): OfferSlot[] {
  if (!everyoneAnswered(poll.recipients)) return []
  return poll.slots
    .filter((s) => s.state === 'open' && Date.parse(s.startsAt) > now)
    .filter((s) => poll.recipients.every((r) => r.works.includes(s.id)))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
}

/**
 * The time most guests can make, soonest among ties, with who can and who
 * can't (said no, or hasn't answered): the host's best option when no time
 * works for everyone. Null when nothing is open. Pure.
 */
export function bestSlot(
  poll: Pick<TimeOfferPoll, 'slots' | 'recipients'>,
  now: number,
): { slot: OfferSlot; can: PollRecipient[]; cannot: PollRecipient[]; waiting: PollRecipient[] } | null {
  const open = poll.slots.filter((s) => s.state === 'open' && Date.parse(s.startsAt) > now).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
  let best: { slot: OfferSlot; can: PollRecipient[]; cannot: PollRecipient[]; waiting: PollRecipient[] } | null = null
  for (const slot of open) {
    const can = poll.recipients.filter((r) => r.works.includes(slot.id))
    if (!best || can.length > best.can.length) {
      best = {
        slot,
        can,
        cannot: poll.recipients.filter((r) => r.answeredAt !== null && !r.works.includes(slot.id)),
        waiting: poll.recipients.filter((r) => r.answeredAt === null),
      }
    }
  }
  return best
}

/** The slots still open to pick, soonest first. Pure. */
export function openSlotsOf(offer: Pick<TimeOffer, 'slots' | 'state' | 'expiresAt'>, now: number): OfferSlot[] {
  if (publicOfferState(offer, now) !== 'open') return []
  return offer.slots.filter((s) => s.state === 'open' && Date.parse(s.startsAt) > now)
}
