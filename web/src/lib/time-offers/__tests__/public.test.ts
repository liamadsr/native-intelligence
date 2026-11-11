/**
 * The public API (src/lib/time-offers/public.ts and src/app/api/public/
 * time-offers/, bookings/): what a guest sees (never the host's email or
 * calendar), the pick's answers in the shared error shape, the honeypot,
 * the failed-pick cap, and the manage link's read, cancel, times and move.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createOffer, planOffer } from '../offers'
import { __clearTimesCacheForTests, handleAcceptOffer, handleBookingTimes, handleCancelBooking, handleGetBooking, handleGetOffer, handleRescheduleBooking, loadBookingPage, loadOfferPage, type PublicDeps } from '../public'
import { manageTokenFor } from '../tokens'
import { bookingSeams, freeCalendar, hoursFromNow, HOST, offerDb, WS } from './fake-db'

const NOW = Date.now()
const SLOTS = [hoursFromNow(26, NOW), hoursFromNow(50, NOW)]
const H = 3_600_000

async function setup() {
  const db = offerDb()
  const cal = freeCalendar()
  const planned = await planOffer(db.db, { workspaceId: WS, hostUserId: HOST, recipient: { name: 'Dana Reyes', email: 'dana@initech.example' }, title: 'Intro call', slots: SLOTS, durationMinutes: 30, sendBy: 'link', message: 'Looking forward to it.' }, cal)
  if (!planned.ok) throw new Error(planned.message)
  const made = await createOffer(db.db, planned.plan, { state: 'open', createdBy: HOST }, cal)
  if (!made.ok) throw new Error(made.message)
  const seams = bookingSeams()
  const window = { start: Date.parse(hoursFromNow(80, NOW)), end: Date.parse(hoursFromNow(81, NOW)) }
  const manage = {
    secret: 'test-secret',
    origin: 'https://app.example',
    updateEvent: vi.fn(async () => ({}) as never),
    deleteEvent: vi.fn(async () => {}),
    tellHost: vi.fn(async () => true),
    freeTime: vi.fn(async () => ({ known: true as const, free: [window], timeZone: 'America/New_York' })),
  }
  const deps: PublicDeps = { supabase: db.db, accept: { ...seams, checkFree: cal.checkFree, calendarAccount: cal.calendarAccount, findContact: cal.findContact }, manage }
  return { ...db, token: made.token!, deps, seams, manage, window }
}

const post = (body: unknown) => new Request('https://app.example/api/public/x', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  __clearTimesCacheForTests()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('GET /api/public/time-offers/<token>', () => {
  it('the host name, title, length, the open times as instants, expiry and state; never the host email, the recipient contact or a calendar detail', async () => {
    const { token, deps } = await setup()
    const res = await handleGetOffer(token, deps)
    expect(res.status).toBe(200)
    const { offer } = await res.json()
    expect(offer).toEqual({
      state: 'open',
      host_name: 'Ava Lin',
      title: 'Intro call',
      duration_minutes: 30,
      video: true,
      location: null,
      message: 'Looking forward to it.',
      time_zone: 'America/New_York',
      expires_at: SLOTS[0],
      recipient_name: 'Dana Reyes',
      needs_email: false,
      slots: SLOTS.map((s) => ({ start: s, end: new Date(Date.parse(s) + 30 * 60_000).toISOString() })),
      booked_start: null,
    })
    expect(JSON.stringify(offer)).not.toContain('dana@initech.example')
    expect(JSON.stringify(offer)).not.toContain(HOST)
  })

  it('a token of the wrong shape or unknown: 404 in the shared shape', async () => {
    const { deps } = await setup()
    for (const token of ['short', 'A'.repeat(24)]) {
      const res = await handleGetOffer(token, deps)
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'This offer does not exist.', code: 'NOT_FOUND' })
    }
  })
})

describe('POST /api/public/time-offers/<token>/accept', () => {
  it('books: 201 with the booking and the manage link; again: 200, already; the offer then reads booked', async () => {
    const { token, deps } = await setup()
    const res = await handleAcceptOffer(post({ start: SLOTS[1], name: 'Dana Reyes', note: 'See you then' }), token, deps)
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, already: false, status: 'confirmed', booking: { start: SLOTS[1], title: 'Intro call', host_name: 'Ava Lin', video: true, conference_url: 'https://meet.example/abc-defg-hij' } })
    expect(body.manage_url).toMatch(/^https:\/\/app\.example\/b\/[A-Za-z0-9_-]{24}$/)
    const again = await handleAcceptOffer(post({ start: SLOTS[1], name: 'Dana Reyes' }), token, deps)
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ already: true, manage_url: body.manage_url })
    const read = await (await handleGetOffer(token, deps)).json()
    expect(read.offer).toMatchObject({ state: 'booked', slots: [], booked_start: SLOTS[1] })
    const other = await handleAcceptOffer(post({ start: SLOTS[0], name: 'Dana Reyes' }), token, deps)
    expect(other.status).toBe(410)
    expect(await other.json()).toMatchObject({ code: 'BOOKED' })
  })

  it('a time no longer free: 409 SLOT_TAKEN with the times still open', async () => {
    const { token, deps } = await setup()
    ;(deps.accept!.checkFree as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ known: true, busy: [true] })
    const res = await handleAcceptOffer(post({ start: SLOTS[0], name: 'Dana' }), token, deps)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'That time is no longer available.', code: 'SLOT_TAKEN', details: { slots: [{ start: SLOTS[1], end: new Date(Date.parse(SLOTS[1]) + 30 * 60_000).toISOString() }] } })
  })

  it('bad input is 400; a honeypot is answered as if it went, and books nothing', async () => {
    const { token, deps, tables } = await setup()
    expect((await handleAcceptOffer(post({ name: 'Dana' }), token, deps)).status).toBe(400)
    expect((await handleAcceptOffer(post({ start: SLOTS[0] }), token, deps)).status).toBe(400)
    expect((await handleAcceptOffer(new Request('https://app.example/x', { method: 'POST', body: 'nope' }), token, deps)).status).toBe(400)
    const bot = await handleAcceptOffer(post({ start: SLOTS[0], name: 'Bot', website: 'http://spam.example' }), token, deps)
    expect(bot.status).toBe(200)
    expect(await bot.json()).toEqual({ ok: true, status: 'booking' })
    expect(tables.meeting_booking).toHaveLength(0)
  })

  it('after a handful of failed picks in a day the page answers 429, before anything is read from a calendar', async () => {
    const { token, deps, tables } = await setup()
    const offerId = tables.time_offer[0].id
    for (let i = 0; i < 5; i++) tables.time_offer_failure.push({ id: `f-${i}`, offer_id: offerId, reason: 'slot_taken', created_at: new Date().toISOString() })
    const res = await handleAcceptOffer(post({ start: SLOTS[0], name: 'Dana' }), token, deps)
    expect(res.status).toBe(429)
    expect(await res.json()).toMatchObject({ code: 'RATE_LIMITED' })
    // Once, when the offer was made: never for the refused pick.
    expect(deps.accept!.checkFree).toHaveBeenCalledTimes(1)
  })
})

describe('the manage link', () => {
  async function bookedSetup() {
    const s = await setup()
    const res = await handleAcceptOffer(post({ start: SLOTS[0], name: 'Dana Reyes' }), s.token, s.deps)
    const { manage_url } = await res.json()
    return { ...s, manageToken: String(manage_url).split('/b/')[1] }
  }

  it('reads the booking: its time, host name, video link and what can still change; never the host email', async () => {
    const { manageToken, deps, tables } = await bookedSetup()
    expect(manageToken).toBe(manageTokenFor(String(tables.meeting_booking[0].id), 'test-secret'))
    const res = await handleGetBooking(manageToken, deps)
    expect(res.status).toBe(200)
    expect((await res.json()).booking).toEqual({
      state: 'confirmed',
      title: 'Intro call',
      start: SLOTS[0],
      end: new Date(Date.parse(SLOTS[0]) + 30 * 60_000).toISOString(),
      host_name: 'Ava Lin',
      guest_name: 'Dana Reyes',
      time_zone: 'UTC',
      video: true,
      conference_url: 'https://meet.example/abc-defg-hij',
      location: null,
      can_cancel: true,
      can_reschedule: true,
      reschedules_left: 3,
    })
    expect((await handleGetBooking('B'.repeat(24), deps)).status).toBe(404)
  })

  it('lists the times it can move to, and moves it', async () => {
    const { manageToken, deps, window, manage } = await bookedSetup()
    const times = await (await handleBookingTimes(manageToken, deps)).json()
    expect(times).toEqual({ time_zone: 'America/New_York', slots: [{ start: new Date(window.start).toISOString(), end: new Date(window.start + H / 2).toISOString() }, { start: new Date(window.start + H / 2).toISOString(), end: new Date(window.end).toISOString() }] })
    // A reload within the minute reads no calendar.
    await handleBookingTimes(manageToken, deps)
    expect(manage.freeTime).toHaveBeenCalledTimes(1)
    const moved = await handleRescheduleBooking(post({ start: new Date(window.start).toISOString() }), manageToken, deps)
    expect(moved.status).toBe(200)
    expect((await moved.json()).booking).toMatchObject({ start: new Date(window.start).toISOString(), reschedules_left: 2 })
    expect((await handleRescheduleBooking(post({ start: 'whenever' }), manageToken, deps)).status).toBe(400)
  })

  it('cancels it; a second cancel is 410', async () => {
    const { manageToken, deps, manage } = await bookedSetup()
    const res = await handleCancelBooking(manageToken, deps)
    expect(res.status).toBe(200)
    expect((await res.json()).booking).toMatchObject({ state: 'cancelled', can_cancel: false, can_reschedule: false })
    expect(manage.deleteEvent).toHaveBeenCalledWith(HOST, 'evt-1', { accountId: 'acct-google', notifyAttendees: true })
    const again = await handleCancelBooking(manageToken, deps)
    expect(again.status).toBe(410)
    expect(await again.json()).toMatchObject({ code: 'CLOSED' })
  })
})

describe("the pages' first render (src/app/t, src/app/b)", () => {
  it('reads what the GETs answer; an unknown or malformed token is missing; a failed read is an error', async () => {
    const { token, deps } = await setup()
    const offer = await loadOfferPage(deps.supabase, token)
    expect(offer).toEqual({ kind: 'found', data: (await (await handleGetOffer(token, deps)).json()).offer })
    expect(await loadOfferPage(deps.supabase, 'short')).toEqual({ kind: 'missing' })
    expect(await loadOfferPage(deps.supabase, 'A'.repeat(24))).toEqual({ kind: 'missing' })
    const broken = { from: () => { throw new Error('down') } } as unknown as PublicDeps['supabase']
    expect(await loadOfferPage(broken, token)).toEqual({ kind: 'error' })

    const res = await handleAcceptOffer(post({ start: SLOTS[0], name: 'Dana Reyes', time_zone: 'Europe/London' }), token, deps)
    const manageToken = String((await res.json()).manage_url).split('/b/')[1]
    const booking = await loadBookingPage(deps.supabase, manageToken)
    expect(booking).toMatchObject({ kind: 'found', data: { state: 'confirmed', guest_name: 'Dana Reyes', can_cancel: true } })
    expect(await loadBookingPage(deps.supabase, 'B'.repeat(24))).toEqual({ kind: 'missing' })
    expect(await loadBookingPage(broken, manageToken)).toEqual({ kind: 'error' })
  })
})
