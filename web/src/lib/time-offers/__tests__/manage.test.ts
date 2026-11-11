/**
 * A booked meeting changed after the pick (src/lib/time-offers/manage.ts):
 * cancelled (the provider event deleted with the attendees told, its claim
 * gone; a provider that refuses leaves it as it was), and moved (a new
 * claim beside the old, the event moved with the attendees told, then the
 * old claim gone; a failure leaves the original intact; at most 3 moves);
 * and the sweep (./sweep.ts): lapsed offers let their times go, a stuck
 * booking is finished.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptOffer, type AcceptDeps } from '../accept'
import { bookingForManageToken, cancelMeeting, rescheduleMeeting, rescheduleTimes, startsInWindows, type ManageDeps } from '../manage'
import { createOffer, planOffer } from '../offers'
import { sweepTimeOffers } from '../sweep'
import { manageTokenFor } from '../tokens'
import type { MeetingBooking } from '../types'
import { bookingSeams, freeCalendar, hoursFromNow, HOST, offerDb, WS } from './fake-db'

const NOW = Date.now()
const SLOTS = [hoursFromNow(26, NOW), hoursFromNow(50, NOW)]
const H = 3_600_000

async function booked() {
  const db = offerDb()
  const cal = freeCalendar()
  const planned = await planOffer(db.db, { workspaceId: WS, hostUserId: HOST, recipient: { name: 'Dana Reyes', email: 'dana@initech.example' }, title: 'Intro call', slots: SLOTS, durationMinutes: 30, sendBy: 'link' }, cal)
  if (!planned.ok) throw new Error(planned.message)
  const made = await createOffer(db.db, planned.plan, { state: 'open', createdBy: HOST }, cal)
  if (!made.ok) throw new Error(made.message)
  const seams = bookingSeams()
  const deps: AcceptDeps = { ...seams, checkFree: cal.checkFree, calendarAccount: cal.calendarAccount, findContact: cal.findContact }
  const result = await acceptOffer(db.db, { offer: { token: made.token! }, slotStart: SLOTS[0], guest: { name: 'Dana Reyes', email: 'dana@initech.example' }, via: 'link' }, deps)
  if (!result.ok) throw new Error(result.message)
  // The host's free time for a move: a window tomorrow-plus-three, 9 to 11.
  const window = { start: Date.parse(hoursFromNow(80, NOW)), end: Date.parse(hoursFromNow(82, NOW)) }
  const manage: ManageDeps & { updateEvent: ReturnType<typeof vi.fn>; deleteEvent: ReturnType<typeof vi.fn>; tellHost: ReturnType<typeof vi.fn> } = {
    secret: 'test-secret',
    origin: 'https://app.example',
    updateEvent: vi.fn(async () => ({}) as never),
    deleteEvent: vi.fn(async () => {}),
    tellHost: vi.fn(async () => true),
    freeTime: vi.fn(async () => ({ known: true as const, free: [window], timeZone: 'America/New_York' })),
  }
  return { ...db, booking: result.booking, manage, window, seams }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('the manage link', () => {
  it('finds its booking by the token, never by anything else', async () => {
    const { db, booking } = await booked()
    expect((await bookingForManageToken(db, manageTokenFor(booking.id, 'test-secret')))?.id).toBe(booking.id)
    expect(await bookingForManageToken(db, manageTokenFor(booking.id, 'another-secret'))).toBeNull()
  })
})

describe('cancelMeeting', () => {
  it("the guest cancels: the provider event deleted with the attendees told, the claim gone, the host told where they are", async () => {
    const { db, tables, booking, manage } = await booked()
    const out = await cancelMeeting(db, { booking, by: 'guest' }, manage)
    expect(out).toMatchObject({ ok: true, booking: { state: 'cancelled', cancelledBy: 'guest' } })
    expect(manage.deleteEvent).toHaveBeenCalledWith(HOST, 'evt-1', { accountId: 'acct-google', notifyAttendees: true })
    expect(tables.host_time_claim).toHaveLength(0)
    expect(manage.tellHost).toHaveBeenCalledWith(expect.objectContaining({ routes: true, text: expect.stringContaining('Dana Reyes cancelled Intro call') }))
    // Twice: the second finds it closed.
    expect(await cancelMeeting(db, { booking: out.ok ? out.booking : booking, by: 'guest' }, manage)).toMatchObject({ ok: false, code: 'CLOSED' })
  })

  it('a provider that refuses the cancellation leaves the booking and its claim as they were', async () => {
    const { db, tables, booking, manage } = await booked()
    manage.deleteEvent.mockRejectedValueOnce(new Error('Google Calendar delete error: 500'))
    expect(await cancelMeeting(db, { booking, by: 'host' }, manage)).toMatchObject({ ok: false, code: 'FAILED' })
    expect(tables.meeting_booking[0].state).toBe('confirmed')
    expect(tables.host_time_claim).toHaveLength(1)
    expect(manage.tellHost).not.toHaveBeenCalled()
  })

  it('a meeting that started can no longer be changed', async () => {
    const { db, booking, manage } = await booked()
    const started: MeetingBooking = { ...booking, startsAt: new Date(NOW - 60_000).toISOString() }
    expect(await cancelMeeting(db, { booking: started, by: 'guest' }, manage)).toMatchObject({ ok: false, code: 'STARTED' })
  })
})

describe('rescheduleMeeting', () => {
  it('lists half-hour starts in the free windows, the same length, never the current time', async () => {
    const { db, booking, manage, window } = await booked()
    const times = await rescheduleTimes(db, booking, manage)
    expect(times).toMatchObject({ ok: true, timeZone: 'America/New_York' })
    expect(times.ok && times.times.map((t) => t.start)).toEqual([window.start, window.start + H / 2, window.start + H, window.start + 1.5 * H])
    expect(startsInWindows([{ start: 0, end: H }], H / 2)).toEqual([{ start: 0, end: H / 2 }, { start: H / 2, end: H }])
  })

  it('moves it: a new claim beside the old, the event moved with the attendees told, then the old claim gone; the host told', async () => {
    const { db, tables, booking, manage, window } = await booked()
    const to = new Date(window.start + H).toISOString()
    const out = await rescheduleMeeting(db, { booking, start: to, by: 'guest' }, manage)
    expect(out).toMatchObject({ ok: true, booking: { startsAt: to, rescheduleCount: 1, state: 'confirmed' } })
    expect(manage.updateEvent).toHaveBeenCalledWith(HOST, 'evt-1', expect.objectContaining({ start: to, end: new Date(window.start + 1.5 * H).toISOString() }), { accountId: 'acct-google', notifyAttendees: true })
    expect(tables.host_time_claim.map((c) => [c.kind, c.starts_at])).toEqual([['booking', to]])
    expect(manage.tellHost).toHaveBeenCalledWith(expect.objectContaining({ routes: true, text: expect.stringContaining('Dana Reyes moved Intro call') }))
  })

  it('a provider that refuses the move leaves the original booking and claim intact', async () => {
    const { db, tables, booking, manage, window } = await booked()
    manage.updateEvent.mockRejectedValueOnce(new Error('Google Calendar update error: 500'))
    expect(await rescheduleMeeting(db, { booking, start: new Date(window.start).toISOString(), by: 'guest' }, manage)).toMatchObject({ ok: false, code: 'FAILED' })
    expect(tables.meeting_booking[0]).toMatchObject({ starts_at: SLOTS[0], reschedule_count: 0 })
    expect(tables.host_time_claim.map((c) => c.starts_at)).toEqual([SLOTS[0]])
  })

  it('a time not on the list, one another claim took, and a fourth move are refused', async () => {
    const { db, tables, booking, manage, window } = await booked()
    expect(await rescheduleMeeting(db, { booking, start: new Date(window.start + 10 * 60_000).toISOString(), by: 'guest' }, manage)).toMatchObject({ ok: false, code: 'SLOT_TAKEN' })
    tables.host_time_claim.push({ id: 'c-other', workspace_id: WS, host_user_id: HOST, starts_at: new Date(window.start).toISOString(), ends_at: new Date(window.start + H).toISOString(), kind: 'booking', claim_key: 'b-other', booking_id: 'b-other' })
    expect(await rescheduleMeeting(db, { booking, start: new Date(window.start).toISOString(), by: 'guest' }, manage)).toMatchObject({ ok: false, code: 'SLOT_TAKEN' })
    expect(manage.updateEvent).not.toHaveBeenCalled()
    expect(await rescheduleTimes(db, { ...booking, rescheduleCount: 3 }, manage)).toMatchObject({ ok: false, code: 'LIMIT' })
  })

  it('an unknown calendar offers no times', async () => {
    const { db, booking, manage } = await booked()
    ;(manage.freeTime as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ known: false, reason: 'down' })
    expect(await rescheduleTimes(db, booking, manage)).toMatchObject({ ok: false, code: 'CALENDAR_UNKNOWN' })
  })
})

describe('sweepTimeOffers', () => {
  it('expires a lapsed offer and lets its holds go; finishes a booking stuck between its claim and its event', async () => {
    const db = offerDb()
    const cal = freeCalendar()
    const planned = await planOffer(db.db, { workspaceId: WS, hostUserId: HOST, recipient: { name: 'Lee Okafor', email: 'lee@umbrella.example' }, title: 'Catch up', slots: SLOTS, durationMinutes: 30, sendBy: 'link' }, cal)
    if (!planned.ok) throw new Error(planned.message)
    const made = await createOffer(db.db, planned.plan, { state: 'open', createdBy: HOST }, cal)
    if (!made.ok) throw new Error(made.message)
    db.tables.time_offer[0].expires_at = new Date(NOW - 1000).toISOString()
    for (const c of db.tables.host_time_claim) c.expires_at = new Date(NOW - 1000).toISOString()
    // A booking whose provider write never happened (a crash after the claim).
    db.tables.meeting_booking.push({ id: '6f0a8c1e-1b2c-4d5e-8f90-123456789abc', workspace_id: WS, host_user_id: HOST, host_name: 'Ava Lin', source: 'offer', offer_id: null, guest_name: 'Sam Ortiz', guest_email: 'sam@globex.example', title: 'Demo', starts_at: SLOTS[1], ends_at: new Date(Date.parse(SLOTS[1]) + 30 * 60_000).toISOString(), state: 'booking', video: true, attempts: 0, reschedule_count: 0, calendar_account_id: 'acct-google', manage_token_hash: 'h-sam', created_at: new Date(NOW - 10 * 60_000).toISOString(), updated_at: new Date(NOW - 10 * 60_000).toISOString() })
    const seams = bookingSeams()
    const result = await sweepTimeOffers(db.db, { ...seams, now: () => NOW })
    expect(result).toEqual({ expired: 1, finished: 1, failed: 0, stillBooking: 0 })
    expect(db.tables.time_offer[0].state).toBe('expired')
    expect(db.tables.host_time_claim).toHaveLength(0)
    expect(db.tables.meeting_booking[0]).toMatchObject({ state: 'confirmed', calendar_event_id: 'evt-1', attempts: 1 })
    expect(seams.createEvent).toHaveBeenCalledWith(HOST, expect.objectContaining({ attendees: ['sam@globex.example'] }), 'acct-google', { sendInvites: true, video: true, idempotencyKey: '6f0a8c1e-1b2c-4d5e-8f90-123456789abc' })
    // A second sweep finds nothing to do.
    expect(await sweepTimeOffers(db.db, { ...seams, now: () => NOW })).toEqual({ expired: 0, finished: 0, failed: 0, stillBooking: 0 })
  })
})
