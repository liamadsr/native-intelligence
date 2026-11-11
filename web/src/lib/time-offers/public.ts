/**
 * The public API of time offers (availability phase 3a), under
 * /api/public/ (no sign-in: outside the auth proxy's matcher). Each route is
 * a thin call into a handler here, pure over {@link PublicDeps}.
 *
 *   GET  /api/public/time-offers/<token>              the offer's page data
 *                                                     (a poll guest's: \`poll\`)
 *   POST /api/public/time-offers/<token>/accept       pick a time
 *   POST /api/public/time-offers/<token>/answer       a poll guest marks every
 *                                                     time that works (phase 5)
 *   GET  /api/public/bookings/<token>                 the manage page's data
 *   POST /api/public/bookings/<token>/cancel          cancel it
 *   GET  /api/public/bookings/<token>/times           times it can move to
 *   POST /api/public/bookings/<token>/reschedule      move it
 *
 * What a guest may see: the host's display name, the title, length, place,
 * the host's own line, the times as instants, and their own booking. Never
 * the host's email, calendar, other events or anyone else's data; a poll's
 * guest sees how many others there are and how many are still to answer,
 * never who they are or what they answered. A poll guest's manage link
 * opens their group meeting: they can say they can't make it, never cancel
 * or move it for everyone.
 *
 * Cheap: the GETs of an offer or a booking are one or two indexed reads and
 * never call a calendar provider; the calendar is read live only on a pick,
 * a move and the move's list of times (kept a minute per booking). Capped by
 * counting rows: an offer takes OFFER_FAILED_PICKS_DAILY_CAP failed picks a
 * day, a booking RESCHEDULES_MAX moves, a poll guest POLL_SAVES_DAILY_CAP
 * saves. Errors use the shared shape of
 * @/lib/api-errors.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, badRequest, notFound, rateLimited, serverError } from '@/lib/api-errors'
import type { Span } from '@/lib/availability/engine'
import { appOrigin } from '@/lib/twilio/config'
import { acceptOffer, type AcceptDeps, type AcceptResult } from './accept'
import { bookingForManageToken, cancelMeeting, changeable, rescheduleMeeting, rescheduleTimes, type ManageDeps, type ManageFailure } from './manage'
import type { OfferPageLoad, PageLoad, PublicBookingData, PublicOfferData, PublicPollData } from './display'
import { declineGroupMeeting, recipientManageUrl, recordAnswer, type AnswerDeps, type AnswerResult } from './polls'
import { getPollByRecipientHash, getRecipientByManageHash } from './poll-store'
import { countFailedPicks, getBooking, getOfferByTokenHash } from './store'
import { isOfferToken, manageTokenHash, offerTokenHash } from './tokens'
import { OFFER_FAILED_PICKS_DAILY_CAP, RESCHEDULES_MAX, openSlotsOf, publicOfferState, type MeetingBooking, type PollRecipient, type TimeOffer, type TimeOfferPoll } from './types'

export interface PublicDeps {
  supabase: SupabaseClient
  now?: () => number
  accept?: AcceptDeps
  manage?: ManageDeps
  /** A poll's answers and its guests' group meetings (phase 5). */
  poll?: AnswerDeps
}

const DAY_MS = 24 * 60 * 60_000
const nowOf = (deps: PublicDeps) => (deps.now ?? Date.now)()

/** The offer as its public page reads it (see the header). Pure. */
export function publicOffer(offer: TimeOffer, now: number): PublicOfferData {
  const state = publicOfferState(offer, now)
  const booked = offer.slots.find((s) => s.state === 'booked')
  return {
    state,
    host_name: offer.hostName,
    title: offer.title,
    duration_minutes: offer.durationMinutes,
    video: offer.video,
    location: offer.location,
    message: offer.message,
    time_zone: offer.timeZone,
    expires_at: offer.expiresAt,
    recipient_name: offer.recipientName,
    needs_email: !offer.recipientEmail,
    slots: openSlotsOf(offer, now).map((s) => ({ start: s.startsAt, end: s.endsAt })),
    booked_start: state === 'booked' && booked ? booked.startsAt : null,
  }
}

/**
 * A poll as one guest's page reads it (see the header): their own answer,
 * counts of the others, and once booked the meeting with their own manage
 * link (`origin` and `secret` mint it). Pure.
 */
export function publicPoll(poll: TimeOfferPoll, recipient: PollRecipient, now: number, booked: MeetingBooking | null, link: { origin: string; secret?: string }): PublicPollData {
  const state = publicOfferState(poll, now)
  const attending = recipient.attending === true
  return {
    state,
    host_name: poll.hostName,
    title: poll.title,
    duration_minutes: poll.durationMinutes,
    video: poll.video,
    location: poll.location,
    message: poll.message,
    time_zone: poll.timeZone,
    expires_at: poll.expiresAt,
    recipient_name: recipient.name,
    slots: openSlotsOf(poll, now).map((s) => ({ start: s.startsAt, end: s.endsAt })),
    answer: recipient.answeredAt
      ? {
          works: poll.slots.filter((s) => recipient.works.includes(s.id)).map((s) => s.startsAt),
          none: recipient.works.length === 0,
          note: recipient.note,
          answered_at: recipient.answeredAt,
          from_calendar: recipient.answeredVia === 'calendar',
        }
      : null,
    guests: poll.recipients.length,
    waiting: poll.recipients.filter((r) => !r.answeredAt).length,
    booked:
      state === 'booked' && booked
        ? {
            start: booked.startsAt,
            end: booked.endsAt,
            attending,
            video: booked.video,
            conference_url: attending ? booked.conferenceUrl : null,
            location: booked.location,
            manage_url: attending && booked.state !== 'cancelled' ? recipientManageUrl(link.origin, booked.id, recipient.id, link.secret) : null,
          }
        : null,
  }
}

/** A booking as its guest's manage page reads it; through a poll guest's own link, their group meeting. Pure. */
export function publicBooking(booking: MeetingBooking, now: number, guest?: PollRecipient): PublicBookingData {
  const blocked = changeable(booking, now)
  if (guest) {
    const attending = guest.attending === true
    return {
      state: booking.state,
      awaiting_host: false,
      title: booking.title,
      start: booking.startsAt,
      end: booking.endsAt,
      host_name: booking.hostName,
      guest_name: guest.name,
      time_zone: booking.guestTimeZone ?? booking.hostTimeZone ?? 'UTC',
      video: booking.video,
      conference_url: attending ? booking.conferenceUrl : null,
      location: booking.location,
      can_cancel: !blocked && attending,
      can_reschedule: false,
      reschedules_left: 0,
      group: { attending },
    }
  }
  return {
    state: booking.state,
    awaiting_host: booking.state === 'requested',
    title: booking.title,
    start: booking.startsAt,
    end: booking.endsAt,
    host_name: booking.hostName,
    guest_name: booking.guestName,
    time_zone: booking.guestTimeZone ?? 'UTC',
    video: booking.video,
    conference_url: booking.conferenceUrl,
    location: booking.location,
    can_cancel: !blocked,
    can_reschedule: !blocked && booking.state === 'confirmed' && booking.rescheduleCount < RESCHEDULES_MAX,
    reschedules_left: Math.max(0, RESCHEDULES_MAX - booking.rescheduleCount),
  }
}

const spansOut = (spans: readonly Span[]) => spans.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }))

/** A poll guest's page by their link's token, or null for no such guest. Throws on a failed read. */
async function pollPageOf(supabase: SupabaseClient, token: string, now: number, deps: Pick<PublicDeps, 'poll'> = {}): Promise<PublicPollData | null> {
  const found = await getPollByRecipientHash(supabase, offerTokenHash(token))
  if (!found || found.poll.state === 'pending_send') return null
  const booked = found.poll.state === 'booked' && found.poll.bookingId ? await getBooking(supabase, found.poll.bookingId) : null
  return publicPoll(found.poll, found.recipient, now, booked, { origin: deps.poll?.origin ?? appOrigin(), secret: deps.poll?.secret })
}

/** The offer's page's first render (src/app/t/[token]/page.tsx): the same read as its GET, a poll guest's as `poll`. */
export async function loadOfferPage(supabase: SupabaseClient, token: string, now: number = Date.now(), deps: Pick<PublicDeps, 'poll'> = {}): Promise<OfferPageLoad> {
  if (!isOfferToken(token)) return { kind: 'missing' }
  try {
    const offer = await getOfferByTokenHash(supabase, offerTokenHash(token))
    if (offer) return { kind: 'found', data: publicOffer(offer, now) }
    const poll = await pollPageOf(supabase, token, now, deps)
    return poll ? { kind: 'poll', data: poll } : { kind: 'missing' }
  } catch {
    return { kind: 'error' }
  }
}

/** A booking by a manage token: the meeting's own, or a poll guest's for their group meeting. Throws on a failed read. */
async function managedBooking(supabase: SupabaseClient, token: string): Promise<{ booking: MeetingBooking; guest?: PollRecipient } | null> {
  const booking = await bookingForManageToken(supabase, token)
  if (booking) return { booking }
  const found = await getRecipientByManageHash(supabase, manageTokenHash(token))
  const group = found?.poll.bookingId ? await getBooking(supabase, found.poll.bookingId) : null
  return found && group ? { booking: group, guest: found.recipient } : null
}

/** The manage page's first render (src/app/b/[token]/page.tsx): the same read as its GET. */
export async function loadBookingPage(supabase: SupabaseClient, token: string, now: number = Date.now()): Promise<PageLoad<PublicBookingData>> {
  if (!isOfferToken(token)) return { kind: 'missing' }
  try {
    const managed = await managedBooking(supabase, token)
    return managed ? { kind: 'found', data: publicBooking(managed.booking, now, managed.guest) } : { kind: 'missing' }
  } catch {
    return { kind: 'error' }
  }
}

/** GET /api/public/time-offers/<token>. */
export async function handleGetOffer(token: string, deps: PublicDeps): Promise<Response> {
  if (!isOfferToken(token)) return notFound('This offer does not exist.')
  let offer: TimeOffer | null
  try {
    offer = await getOfferByTokenHash(deps.supabase, offerTokenHash(token))
  } catch {
    return serverError('This offer is not available right now.')
  }
  if (!offer) {
    let poll: PublicPollData | null
    try {
      poll = await pollPageOf(deps.supabase, token, nowOf(deps), deps)
    } catch {
      return serverError('This offer is not available right now.')
    }
    if (poll) return Response.json({ poll }, { headers: { 'Cache-Control': 'no-store' } })
    return notFound('This offer does not exist.')
  }
  return Response.json({ offer: publicOffer(offer, nowOf(deps)) }, { headers: { 'Cache-Control': 'no-store' } })
}

function answerFailureResponse(result: Extract<AnswerResult, { ok: false }>): Response {
  switch (result.code) {
    case 'NOT_FOUND':
      return notFound(result.message)
    case 'BAD_INPUT':
      return apiError(result.message, { status: 400, code: 'BAD_INPUT', ...(result.openSlots ? { details: { slots: result.openSlots.map((s) => ({ start: s.startsAt, end: s.endsAt })) } } : {}) })
    case 'BOOKED':
    case 'EXPIRED':
    case 'WITHDRAWN':
      return apiError(result.message, { status: 410, code: result.code })
    case 'LIMIT':
      return rateLimited(result.message)
    default:
      return serverError(result.message)
  }
}

/** POST /api/public/time-offers/<token>/answer: a poll guest's whole answer (phase 5). */
export async function handleAnswerPoll(request: Request, token: string, deps: PublicDeps): Promise<Response> {
  if (!isOfferToken(token)) return notFound('These times do not exist.')
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the answer as JSON.')
  // A honeypot a person never fills: answered as if it went, so a bot learns nothing.
  if (typeof body.website === 'string' && body.website.trim()) return Response.json({ ok: true })
  const none = body.none === true
  const works = Array.isArray(body.works) ? body.works.filter((w): w is string => typeof w === 'string').slice(0, 10) : []
  if (Array.isArray(body.works) && body.works.length > 10) return badRequest('Too many times.')
  if (!none && !works.length) return badRequest('Mark every time that works, or choose none of these work.')
  const note = typeof body.note === 'string' ? body.note.slice(0, 1000) : null
  const result = await recordAnswer(deps.supabase, { ref: { token }, works: none ? [] : works, none, note, via: 'link' }, { now: deps.now, ...deps.poll })
  if (!result.ok) return answerFailureResponse(result)
  const booked = result.booking ?? (result.poll.state === 'booked' && result.poll.bookingId ? await getBooking(deps.supabase, result.poll.bookingId).catch(() => null) : null)
  return Response.json({ ok: true, poll: publicPoll(result.poll, result.recipient, nowOf(deps), booked, { origin: deps.poll?.origin ?? appOrigin(), secret: deps.poll?.secret }) })
}

function acceptFailure(result: Extract<AcceptResult, { ok: false }>): Response {
  const slots = result.openSlots ? { slots: result.openSlots.map((s) => ({ start: s.startsAt, end: s.endsAt })) } : undefined
  switch (result.code) {
    case 'NOT_FOUND':
      return notFound(result.message)
    case 'BAD_INPUT':
    case 'NEEDS_EMAIL':
      return apiError(result.message, { status: 400, code: result.code, ...(slots ? { details: slots } : {}) })
    case 'SLOT_TAKEN':
      return apiError(result.message, { status: 409, code: 'SLOT_TAKEN', details: slots ?? { slots: [] } })
    case 'BOOKED':
    case 'EXPIRED':
    case 'WITHDRAWN':
      return apiError(result.message, { status: 410, code: result.code })
    case 'CALENDAR_UNKNOWN':
    case 'NO_CALENDAR':
      return apiError(result.message, { status: 503, code: 'UNAVAILABLE' })
    default:
      return serverError(result.message)
  }
}

/** POST /api/public/time-offers/<token>/accept. */
export async function handleAcceptOffer(request: Request, token: string, deps: PublicDeps): Promise<Response> {
  if (!isOfferToken(token)) return notFound('This offer does not exist.')
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the pick as JSON.')
  // A honeypot a person never fills: answered as if it went, so a bot learns nothing.
  if (typeof body.website === 'string' && body.website.trim()) return Response.json({ ok: true, status: 'booking' })
  const start = typeof body.start === 'string' ? body.start : ''
  if (!start || !Number.isFinite(Date.parse(start))) return badRequest('Pick a time.')
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name || name.length > 120) return badRequest('Add your name.')
  const email = typeof body.email === 'string' ? body.email : null
  const note = typeof body.note === 'string' ? body.note : null
  const timeZone = typeof body.time_zone === 'string' ? body.time_zone : null

  const now = nowOf(deps)
  try {
    const offer = await getOfferByTokenHash(deps.supabase, offerTokenHash(token))
    if (!offer) return notFound('This offer does not exist.')
    if ((await countFailedPicks(deps.supabase, offer.id, new Date(now - DAY_MS).toISOString())) >= OFFER_FAILED_PICKS_DAILY_CAP) {
      return rateLimited('Too many tries on this offer today. Ask for new times.')
    }
  } catch {
    return serverError('This offer is not available right now.')
  }

  const result = await acceptOffer(deps.supabase, { offer: { token }, slotStart: start, guest: { name, email, note, timeZone }, via: 'link' }, { now: deps.now, ...deps.accept })
  if (!result.ok) return acceptFailure(result)
  const b = result.booking
  return Response.json(
    {
      ok: true,
      already: result.already,
      status: b.state,
      booking: { start: b.startsAt, end: b.endsAt, title: b.title, host_name: b.hostName, video: b.video, conference_url: b.conferenceUrl, location: b.location },
      manage_url: result.manageUrl,
    },
    { status: result.already ? 200 : 201 },
  )
}

function manageFailure(result: ManageFailure): Response {
  switch (result.code) {
    case 'NOT_FOUND':
      return notFound(result.message)
    case 'BAD_INPUT':
      return badRequest(result.message)
    case 'CLOSED':
    case 'STARTED':
      return apiError(result.message, { status: 410, code: result.code })
    case 'LIMIT':
      return rateLimited(result.message)
    case 'SLOT_TAKEN':
      return apiError(result.message, { status: 409, code: 'SLOT_TAKEN' })
    case 'CALENDAR_UNKNOWN':
      return apiError(result.message, { status: 503, code: 'UNAVAILABLE' })
    default:
      return serverError(result.message)
  }
}

async function bookingOf(token: string, deps: PublicDeps): Promise<{ booking: MeetingBooking; guest?: PollRecipient } | Response> {
  if (!isOfferToken(token)) return notFound('This booking does not exist.')
  try {
    return (await managedBooking(deps.supabase, token)) ?? notFound('This booking does not exist.')
  } catch {
    return serverError('This booking is not available right now.')
  }
}

/** A group meeting can't be moved by one of its guests: they reply to the host. */
const groupCantMove = (booking: MeetingBooking) => badRequest(`This meeting is with several people, so it can't be moved from here. Reply to ${booking.hostName} to find another time.`)

/** GET /api/public/bookings/<token>. */
export async function handleGetBooking(token: string, deps: PublicDeps): Promise<Response> {
  const managed = await bookingOf(token, deps)
  if (managed instanceof Response) return managed
  return Response.json({ booking: publicBooking(managed.booking, nowOf(deps), managed.guest) }, { headers: { 'Cache-Control': 'no-store' } })
}

/** POST /api/public/bookings/<token>/cancel: through a poll guest's own link, "I can't make it" (they come off it; the meeting stays). */
export async function handleCancelBooking(token: string, deps: PublicDeps): Promise<Response> {
  const managed = await bookingOf(token, deps)
  if (managed instanceof Response) return managed
  if (managed.guest) {
    const declined = await declineGroupMeeting(deps.supabase, { booking: managed.booking, recipient: managed.guest }, { now: deps.now, ...deps.poll, ...(deps.manage?.updateEvent ? { updateEvent: deps.manage.updateEvent } : {}) })
    if (!declined.ok) return manageFailure(declined)
    return Response.json({ ok: true, booking: publicBooking(declined.booking, nowOf(deps), declined.recipient) })
  }
  const booking = managed.booking
  const result = await cancelMeeting(deps.supabase, { booking, by: 'guest' }, { now: deps.now, ...deps.manage })
  if (!result.ok) return manageFailure(result)
  return Response.json({ ok: true, booking: publicBooking(result.booking, nowOf(deps)) })
}

/**
 * The move's times, kept a minute per booking on this instance: a manage page
 * reloaded (or scraped) must not read the host's calendar provider on every
 * load. A move re-reads them live either way.
 */
const TIMES_TTL_MS = 60_000
const timesCache = new Map<string, { at: number; value: { timeZone: string; times: Span[] } }>()

/** GET /api/public/bookings/<token>/times. */
export async function handleBookingTimes(token: string, deps: PublicDeps): Promise<Response> {
  const managed = await bookingOf(token, deps)
  if (managed instanceof Response) return managed
  if (managed.guest) return groupCantMove(managed.booking)
  const booking = managed.booking
  const now = nowOf(deps)
  const cached = timesCache.get(booking.id)
  if (cached && now - cached.at < TIMES_TTL_MS && changeable(booking, now) === null) {
    return Response.json({ time_zone: cached.value.timeZone, slots: spansOut(cached.value.times) })
  }
  const result = await rescheduleTimes(deps.supabase, booking, { now: deps.now, ...deps.manage })
  if (!result.ok) return manageFailure(result)
  if (timesCache.size > 500) timesCache.clear()
  timesCache.set(booking.id, { at: now, value: { timeZone: result.timeZone, times: result.times } })
  return Response.json({ time_zone: result.timeZone, slots: spansOut(result.times) })
}

/** POST /api/public/bookings/<token>/reschedule. */
export async function handleRescheduleBooking(request: Request, token: string, deps: PublicDeps): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the new time as JSON.')
  const start = typeof body.start === 'string' ? body.start : ''
  if (!start || !Number.isFinite(Date.parse(start))) return badRequest('Pick a new time.')
  const managed = await bookingOf(token, deps)
  if (managed instanceof Response) return managed
  if (managed.guest) return groupCantMove(managed.booking)
  const booking = managed.booking
  const result = await rescheduleMeeting(deps.supabase, { booking, start, by: 'guest' }, { now: deps.now, ...deps.manage })
  timesCache.delete(booking.id)
  if (!result.ok) return manageFailure(result)
  return Response.json({ ok: true, booking: publicBooking(result.booking, nowOf(deps)) })
}

/** Test seam: forget the cached move times. */
export function __clearTimesCacheForTests(): void {
  timesCache.clear()
}
