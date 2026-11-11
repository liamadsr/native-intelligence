/**
 * The public API of time offers (availability phase 3a), under
 * /api/public/ (no sign-in: outside the auth proxy's matcher). Each route is
 * a thin call into a handler here, pure over {@link PublicDeps}.
 *
 *   GET  /api/public/time-offers/<token>              the offer's page data
 *   POST /api/public/time-offers/<token>/accept       pick a time
 *   GET  /api/public/bookings/<token>                 the manage page's data
 *   POST /api/public/bookings/<token>/cancel          cancel it
 *   GET  /api/public/bookings/<token>/times           times it can move to
 *   POST /api/public/bookings/<token>/reschedule      move it
 *
 * What a guest may see: the host's display name, the title, length, place,
 * the host's own line, the times as instants, and their own booking. Never
 * the host's email, calendar, other events or anyone else's data.
 *
 * Cheap: the GETs of an offer or a booking are one or two indexed reads and
 * never call a calendar provider; the calendar is read live only on a pick,
 * a move and the move's list of times (kept a minute per booking). Capped by
 * counting rows: an offer takes OFFER_FAILED_PICKS_DAILY_CAP failed picks a
 * day, a booking RESCHEDULES_MAX moves. Errors use the shared shape of
 * @/lib/api-errors.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, badRequest, notFound, rateLimited, serverError } from '@/lib/api-errors'
import type { Span } from '@/lib/availability/engine'
import { acceptOffer, type AcceptDeps, type AcceptResult } from './accept'
import { bookingForManageToken, cancelMeeting, changeable, rescheduleMeeting, rescheduleTimes, type ManageDeps, type ManageFailure } from './manage'
import { countFailedPicks, getOfferByTokenHash } from './store'
import { isOfferToken, offerTokenHash } from './tokens'
import { OFFER_FAILED_PICKS_DAILY_CAP, RESCHEDULES_MAX, openSlotsOf, publicOfferState, type MeetingBooking, type TimeOffer } from './types'

export interface PublicDeps {
  supabase: SupabaseClient
  now?: () => number
  accept?: AcceptDeps
  manage?: ManageDeps
}

const DAY_MS = 24 * 60 * 60_000
const nowOf = (deps: PublicDeps) => (deps.now ?? Date.now)()

/** The offer as its public page reads it (see the header). Pure. */
export function publicOffer(offer: TimeOffer, now: number) {
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

/** A booking as its guest's manage page reads it. Pure. */
export function publicBooking(booking: MeetingBooking, now: number) {
  const blocked = changeable(booking, now)
  return {
    state: booking.state,
    title: booking.title,
    start: booking.startsAt,
    end: booking.endsAt,
    host_name: booking.hostName,
    guest_name: booking.guestName,
    video: booking.video,
    conference_url: booking.conferenceUrl,
    location: booking.location,
    can_cancel: !blocked,
    can_reschedule: !blocked && booking.state === 'confirmed' && booking.rescheduleCount < RESCHEDULES_MAX,
    reschedules_left: Math.max(0, RESCHEDULES_MAX - booking.rescheduleCount),
  }
}

const spansOut = (spans: readonly Span[]) => spans.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() }))

/** GET /api/public/time-offers/<token>. */
export async function handleGetOffer(token: string, deps: PublicDeps): Promise<Response> {
  if (!isOfferToken(token)) return notFound('This offer does not exist.')
  let offer: TimeOffer | null
  try {
    offer = await getOfferByTokenHash(deps.supabase, offerTokenHash(token))
  } catch {
    return serverError('This offer is not available right now.')
  }
  if (!offer) return notFound('This offer does not exist.')
  return Response.json({ offer: publicOffer(offer, nowOf(deps)) }, { headers: { 'Cache-Control': 'no-store' } })
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

async function bookingOf(token: string, deps: PublicDeps): Promise<MeetingBooking | Response> {
  if (!isOfferToken(token)) return notFound('This booking does not exist.')
  try {
    const booking = await bookingForManageToken(deps.supabase, token)
    return booking ?? notFound('This booking does not exist.')
  } catch {
    return serverError('This booking is not available right now.')
  }
}

/** GET /api/public/bookings/<token>. */
export async function handleGetBooking(token: string, deps: PublicDeps): Promise<Response> {
  const booking = await bookingOf(token, deps)
  if (booking instanceof Response) return booking
  return Response.json({ booking: publicBooking(booking, nowOf(deps)) }, { headers: { 'Cache-Control': 'no-store' } })
}

/** POST /api/public/bookings/<token>/cancel. */
export async function handleCancelBooking(token: string, deps: PublicDeps): Promise<Response> {
  const booking = await bookingOf(token, deps)
  if (booking instanceof Response) return booking
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
  const booking = await bookingOf(token, deps)
  if (booking instanceof Response) return booking
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
  const booking = await bookingOf(token, deps)
  if (booking instanceof Response) return booking
  const result = await rescheduleMeeting(deps.supabase, { booking, start, by: 'guest' }, { now: deps.now, ...deps.manage })
  timesCache.delete(booking.id)
  if (!result.ok) return manageFailure(result)
  return Response.json({ ok: true, booking: publicBooking(result.booking, nowOf(deps)) })
}

/** Test seam: forget the cached move times. */
export function __clearTimesCacheForTests(): void {
  timesCache.clear()
}
