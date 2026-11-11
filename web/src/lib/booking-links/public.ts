/**
 * The public API of booking links (availability phase 4a), under
 * /api/public/ (no sign-in: outside the auth proxy's matcher). Each route is
 * a thin call into a handler here, pure over {@link LinkPublicDeps}.
 *
 *   GET  /api/public/booking-links/<profile>/<slug>         the link's page data
 *   GET  /api/public/booking-links/<profile>/<slug>/times   its open times (?from=YYYY-MM-DD&days=7&tz=Zone)
 *   POST /api/public/booking-links/<profile>/<slug>/book    book one
 *   GET  /api/public/book/<slug>                            an old /book/<slug> address: the link it is now
 *
 * A business's job link (purpose 'job') answers through the same routes:
 * its times are the business's open slots (src/lib/customers/slots.ts) and
 * a booking is the customer's request on the owner's yes
 * (src/lib/customers/booking-link.ts postBookingRequest, its caps and its
 * mobile-only rule).
 *
 * What a guest may see: the link's title, description, length, place,
 * questions and the hosts' display names, and the open times as instants.
 * Never a host's email, calendar or events, nor anyone else's booking.
 *
 * Cheap: a link's GET is a few indexed reads and never calls a calendar
 * provider; its times are read from the hosts' calendars at most once a
 * minute per link and range on this instance (a booking re-reads its time
 * live either way). A booking is capped by counting rows:
 * LINK_ATTEMPTS_HOURLY_CAP tries a link per hour, LINK_GUEST_DAILY_CAP
 * bookings a guest per link per day, and a honeypot field. Errors use the
 * shared shape of @/lib/api-errors.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { apiError, badRequest, notFound, rateLimited, serverError } from '@/lib/api-errors'
import { readWorkingHours } from '@/lib/availability/schedule'
import { addDays, dayKey, localDate, parseDayKey, zonedTime } from '@/lib/availability/zone'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { postBookingRequest, supabaseBookingLinkDeps, type BookingLinkDeps } from '@/lib/customers/booking-link'
import { activeBusinessNumber } from '@/lib/customers/numbers'
import { findOpenSlots } from '@/lib/customers/slots'
import { businessName, getBusinessProfile } from '@/lib/customers/store'
import { hostDisplayName } from '@/lib/time-offers/offers'
import { normalizeE164 } from '@/lib/twilio/phone'
import type { PageLoad } from '@/lib/time-offers/display'
import { bookFromLink, type LinkBookingDeps, type LinkBookingFailure } from './book'
import { countGuestBookings, countLinkAttempts, getJobLink, getLinkByAddress, getProfileByHandle, recordLinkAttempt } from './store'
import { readLinkTimes, type LinkTimesResult } from './times'
import { LINK_ATTEMPTS_HOURLY_CAP, LINK_GUEST_DAILY_CAP, LINK_TIMES_DAYS_MAX, type BookingLink, type PublicLinkBooked, type PublicLinkData, type PublicLinkTimes } from './types'

export interface LinkPublicDeps {
  supabase: SupabaseClient
  now?: () => number
  book?: LinkBookingDeps
  readTimes?: (link: BookingLink, range: { from: number; to: number }) => Promise<LinkTimesResult>
  /** A job link's business seams (default: the real store). */
  job?: BookingLinkDeps
  /** The hosts' display names (default: their member rows). */
  hostName?: (workspaceId: string, userId: string) => Promise<string | null>
  /** Whether the workspace can text a guest (a live business number). */
  canText?: (workspaceId: string) => Promise<boolean>
  /** The zone the hosts' times are worked in (default: the link's own, else the organizer's working hours'). */
  zoneOf?: (link: BookingLink) => Promise<string>
  /** A job link's open slots (default: the business's, src/lib/customers/slots.ts findOpenSlots). */
  jobTimes?: (business: { workspaceId: string; ownerUserId: string }, range: { fromDate: string; days: number }) => Promise<{ slots: Array<{ start: string; end: string }>; timeZone: string }>
}

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const nowOf = (deps: LinkPublicDeps) => (deps.now ?? Date.now)()
const NO_STORE = { 'Cache-Control': 'no-store' }

/** A link a guest may use: on, and with a host (a job link: its business's). */
async function liveLink(deps: LinkPublicDeps, profile: string, slug: string): Promise<BookingLink | null> {
  const link = await getLinkByAddress(deps.supabase, profile, slug)
  return link && link.active && (link.hosts.length || link.purpose === 'job') ? link : null
}

async function linkZone(deps: LinkPublicDeps, link: BookingLink): Promise<string> {
  if (deps.zoneOf) return deps.zoneOf(link)
  if (link.purpose === 'job') {
    const profile = await getBusinessProfile(deps.supabase, link.workspaceId)
    if (profile?.timeZone) return profile.timeZone
  }
  if (link.weeklyHours && link.timeZone) return link.timeZone
  const organizer = link.hosts[0]?.userId ?? link.ownerUserId
  return (await readWorkingHours(deps.supabase, { userId: organizer, workspaceId: link.workspaceId })).timeZone
}

/** The link as its page reads it (see the header). */
export async function publicLink(link: BookingLink, deps: LinkPublicDeps): Promise<PublicLinkData> {
  const hostName = deps.hostName ?? ((ws: string, id: string) => hostDisplayName(deps.supabase, ws, id))
  const canText = deps.canText ?? (async (ws: string) => !!(await activeBusinessNumber(deps.supabase, ws)))
  const [names, zone, texts] = await Promise.all([
    link.purpose === 'job'
      ? businessName(deps.supabase, link.workspaceId).then((n) => [n])
      : Promise.all(link.hosts.map((h) => hostName(link.workspaceId, h.userId).catch(() => null))).then((all) => all.filter((n): n is string => !!n)),
    linkZone(deps, link),
    link.purpose === 'job' ? Promise.resolve(true) : canText(link.workspaceId).catch(() => false),
  ])
  return {
    profile: link.profileHandle ?? '',
    slug: link.slug,
    purpose: link.purpose,
    title: link.title,
    description: link.description,
    duration_minutes: link.durationMinutes,
    host_mode: link.hostMode,
    host_names: names,
    questions: link.questions.map((q) => ({ id: q.id, label: q.label, required: q.required, kind: q.kind })),
    time_zone: zone,
    video: link.video,
    location: link.video ? null : link.location,
    ask_first: link.purpose === 'job' || link.askFirst,
    contact: link.purpose === 'job' ? 'phone' : texts ? 'email_or_phone' : 'email',
  }
}

/** The link's page's first render (src/app/book/[slug]/[link]/page.tsx): the same read as its GET. */
export async function loadLinkPage(deps: LinkPublicDeps, profile: string, slug: string): Promise<PageLoad<PublicLinkData>> {
  try {
    const link = await liveLink(deps, profile, slug)
    return link ? { kind: 'found', data: await publicLink(link, deps) } : { kind: 'missing' }
  } catch {
    return { kind: 'error' }
  }
}

/** GET /api/public/booking-links/<profile>/<slug>. */
export async function handleGetLink(profile: string, slug: string, deps: LinkPublicDeps): Promise<Response> {
  const page = await loadLinkPage(deps, profile, slug)
  if (page.kind === 'missing') return notFound('This booking page does not exist.')
  if (page.kind === 'error') return serverError('This booking page is not available right now.')
  return Response.json({ link: page.data }, { headers: NO_STORE })
}

/**
 * The range a times read asks for: `from` a date in `tz` (default today),
 * `days` of them (default 7, at most LINK_TIMES_DAYS_MAX). Pure.
 */
export function timesRange(params: URLSearchParams, zone: string, now: number): { from: number; to: number; fromDay: string } | null {
  const tz = isTimeZone(params.get('tz')) ? (params.get('tz') as string) : zone
  const fromParam = params.get('from')
  const first = fromParam ? parseDayKey(fromParam) : localDate(now, tz)
  // A real date only (parseDayKey takes 2031-13-40 as digits).
  if (!first || dayKey(addDays(first, 0)) !== dayKey(first)) return null
  const daysRaw = params.get('days')
  const days = daysRaw === null ? 7 : Number(daysRaw)
  if (!Number.isInteger(days) || days < 1) return null
  const span = Math.min(days, LINK_TIMES_DAYS_MAX)
  const from = zonedTime(first, '00:00', tz)
  const to = zonedTime(addDays(first, span), '00:00', tz)
  return Number.isFinite(from) && to > from ? { from, to, fromDay: dayKey(first) } : null
}

/**
 * The times read, kept a minute per link and range on this instance: a page
 * reloaded (or scraped) must not read the hosts' calendar providers each time.
 */
const TIMES_TTL_MS = 60_000
const timesCache = new Map<string, { at: number; value: PublicLinkTimes }>()

/** Test seam: forget the cached times. */
export function __clearLinkTimesCacheForTests(): void {
  timesCache.clear()
}

function forgetLink(linkId: string): void {
  for (const key of timesCache.keys()) if (key.startsWith(`${linkId}:`)) timesCache.delete(key)
}

/** GET /api/public/booking-links/<profile>/<slug>/times. */
export async function handleLinkTimes(request: Request, profile: string, slug: string, deps: LinkPublicDeps): Promise<Response> {
  const now = nowOf(deps)
  let link: BookingLink | null
  let zone: string
  try {
    link = await liveLink(deps, profile, slug)
    if (!link) return notFound('This booking page does not exist.')
    zone = await linkZone(deps, link)
  } catch {
    return serverError('This booking page is not available right now.')
  }
  const range = timesRange(new URL(request.url).searchParams, zone, now)
  if (!range) return badRequest('Ask for days from a date: ?from=YYYY-MM-DD&days=7.')
  const key = `${link.id}:${range.from}:${range.to}`
  const cached = timesCache.get(key)
  if (cached && now - cached.at < TIMES_TTL_MS) return Response.json(cached.value)

  let value: PublicLinkTimes
  if (link.purpose === 'job') {
    try {
      const business = { workspaceId: link.workspaceId, ownerUserId: link.ownerUserId }
      const days = Math.min(14, Math.max(1, Math.round((range.to - range.from) / DAY_MS)))
      const found = await (deps.jobTimes ?? ((b, r) => findOpenSlots(deps.supabase, b, { ...r, max: 40 }, { now: () => now })))(business, { fromDate: range.fromDay, days })
      value = { time_zone: found.timeZone, from: new Date(range.from).toISOString(), to: new Date(range.to).toISOString(), slots: found.slots }
    } catch {
      return apiError("The calendar couldn't be checked just now. Try again in a minute.", { status: 503, code: 'UNAVAILABLE' })
    }
  } else {
    const read = await (deps.readTimes ?? ((l, r) => readLinkTimes(l, r, { supabase: deps.supabase, now: () => now })))(link, range)
    if (!read.known) return apiError("The calendar couldn't be checked just now. Try again in a minute.", { status: 503, code: 'UNAVAILABLE' })
    value = {
      time_zone: read.timeZone,
      from: new Date(range.from).toISOString(),
      to: new Date(range.to).toISOString(),
      slots: read.slots.map((s) => ({ start: new Date(s.start).toISOString(), end: new Date(s.end).toISOString() })),
    }
  }
  if (timesCache.size > 500) timesCache.clear()
  timesCache.set(key, { at: now, value })
  return Response.json(value)
}

function bookFailure(result: LinkBookingFailure): Response {
  switch (result.code) {
    case 'BAD_INPUT':
    case 'NEEDS_CONTACT':
    case 'NEEDS_EMAIL':
      return apiError(result.message, { status: 400, code: result.code, ...(result.field ? { details: { field: result.field } } : {}) })
    case 'SLOT_TAKEN':
      return apiError(result.message, { status: 409, code: 'SLOT_TAKEN' })
    case 'CLOSED':
      return apiError(result.message, { status: 410, code: 'CLOSED' })
    case 'UNAVAILABLE':
    case 'NO_CALENDAR':
      return apiError(result.message, { status: 503, code: 'UNAVAILABLE' })
    case 'TOO_MANY_PENDING':
      return rateLimited(result.message)
    default:
      return serverError(result.message)
  }
}

/** POST /api/public/booking-links/<profile>/<slug>/book. Body: { start, name, email?, phone?, answers?, note?, time_zone?, website (honeypot) }. */
export async function handleBookLink(request: Request, profile: string, slug: string, deps: LinkPublicDeps): Promise<Response> {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the booking as JSON.')
  // A honeypot a person never fills: answered as if it went, so a bot learns nothing.
  if (typeof body.website === 'string' && body.website.trim()) return Response.json({ ok: true, status: 'requested' }, { status: 201 })
  const start = typeof body.start === 'string' ? body.start : ''
  if (!start || !Number.isFinite(Date.parse(start))) return badRequest('Pick a time.')
  const now = nowOf(deps)

  let link: BookingLink | null
  try {
    link = await liveLink(deps, profile, slug)
    if (!link) return notFound('This booking page does not exist.')
    if ((await countLinkAttempts(deps.supabase, link.id, new Date(now - HOUR_MS).toISOString())) >= LINK_ATTEMPTS_HOURLY_CAP) {
      return rateLimited('Too many bookings on this page right now. Try again in a little while.')
    }
  } catch {
    return serverError('This booking page is not available right now.')
  }

  if (link.purpose === 'job') {
    const answers = (body.answers && typeof body.answers === 'object' ? body.answers : {}) as Record<string, unknown>
    let business
    try {
      business = await getBusinessProfile(deps.supabase, link.workspaceId)
    } catch {
      return serverError('This booking page is not available right now.')
    }
    if (!business) return notFound('This booking page does not exist.')
    await recordLinkAttempt(deps.supabase, link.id)
    const made = await postBookingRequest(business, { start, name: body.name, phone: body.phone, address: answers.address ?? body.address, note: body.note }, deps.job ?? supabaseBookingLinkDeps(deps.supabase))
    if (made instanceof Response) return made
    forgetLink(link.id)
    const b = made.booking
    const out: PublicLinkBooked = {
      ok: true,
      status: 'requested',
      booking: { start: b.startsAt, end: b.endsAt, title: link.title, host_name: business.businessName, video: false, conference_url: null, location: b.address },
      manage_url: null,
    }
    return Response.json(out, { status: 201 })
  }

  const email = typeof body.email === 'string' ? body.email : null
  const phone = typeof body.phone === 'string' ? body.phone : null
  try {
    const since = new Date(now - DAY_MS).toISOString()
    const who = { email: email?.trim().toLowerCase() || null, phone: normalizeE164(phone) }
    if ((await countGuestBookings(deps.supabase, link.id, since, who)) >= LINK_GUEST_DAILY_CAP) return rateLimited("You've already booked here today. Check your email or texts for it.")
  } catch {
    return serverError('This booking page is not available right now.')
  }
  await recordLinkAttempt(deps.supabase, link.id)

  const result = await bookFromLink(
    deps.supabase,
    {
      link,
      input: {
        start,
        name: typeof body.name === 'string' ? body.name : '',
        email,
        phone,
        answers: body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers) ? (body.answers as Record<string, unknown>) : null,
        note: typeof body.note === 'string' ? body.note : null,
        timeZone: typeof body.time_zone === 'string' ? body.time_zone : null,
      },
    },
    { now: deps.now, ...(deps.readTimes ? { readTimes: deps.readTimes } : {}), ...deps.book },
  )
  if (!result.ok) return bookFailure(result)
  forgetLink(link.id)
  const b = result.booking
  const out: PublicLinkBooked = {
    ok: true,
    status: b.state === 'confirmed' ? 'confirmed' : b.state === 'requested' ? 'requested' : 'booking',
    booking: { start: b.startsAt, end: b.endsAt, title: b.title, host_name: b.hostName, video: b.video, conference_url: b.conferenceUrl, location: b.location },
    manage_url: result.manageUrl,
  }
  return Response.json(out, { status: result.already ? 200 : 201 })
}

/**
 * GET /api/public/book/<slug>: an old /book/<slug> address (a business's
 * booking slug, its workspace handle since 581) as the link it is now: the
 * business's job link while it is on.
 */
export async function handleLegacySlug(slug: string, deps: LinkPublicDeps): Promise<Response> {
  const found = await resolveLegacySlug(deps.supabase, slug)
  if (found === 'error') return serverError('This booking page is not available right now.')
  if (!found) return notFound('This booking page does not exist.')
  return Response.json(found, { headers: NO_STORE })
}

/** The job link an old /book/<slug> address is now, or null; 'error' on a failed read. */
export async function resolveLegacySlug(supabase: SupabaseClient, slug: string): Promise<{ profile: string; slug: string } | null | 'error'> {
  try {
    const handle = await getProfileByHandle(supabase, slug)
    if (!handle || handle.userId) return null
    const link = await getJobLink(supabase, handle.workspaceId)
    return link && link.active && link.profileId === handle.id ? { profile: handle.handle, slug: link.slug } : null
  } catch {
    return 'error'
  }
}
