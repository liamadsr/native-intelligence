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
import { linkOf } from '@/lib/booking-links/__tests__/fixtures'

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

  it("deletes the event the booking holds now, not the one the caller read (a booking still being written when it was cancelled)", async () => {
    const { db, booking, manage } = await booked()
    // The caller read it mid-write, before its event existed.
    const stale: MeetingBooking = { ...booking, state: 'booking', calendarEventId: null, calendarAccountId: null }
    expect(await cancelMeeting(db, { booking: stale, by: 'host' }, manage)).toMatchObject({ ok: true })
    expect(manage.deleteEvent).toHaveBeenCalledWith(HOST, 'evt-1', { accountId: 'acct-google', notifyAttendees: true })
  })

  it('a refused cancellation of an event written meanwhile puts the booking back as confirmed', async () => {
    const { db, tables, booking, manage } = await booked()
    manage.deleteEvent.mockRejectedValueOnce(new Error('Google Calendar delete error: 500'))
    const stale: MeetingBooking = { ...booking, state: 'booking', calendarEventId: null, calendarAccountId: null }
    expect(await cancelMeeting(db, { booking: stale, by: 'host' }, manage)).toMatchObject({ ok: false, code: 'FAILED' })
    expect(tables.meeting_booking[0].state).toBe('confirmed')
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

  it("a booking link's meeting moves by the link's own rules: its times read for the hosts it was booked with, the meeting's length, its own event and claim left out", async () => {
    const { db, booking, manage, window } = await booked()
    const fromLink = { ...booking, source: 'link' as const, linkId: 'link-1' }
    const link = linkOf({ id: 'link-1', hostMode: 'any', windowDays: 5, noticeMinutes: 24 * 60, durationMinutes: 60, hosts: [{ userId: 'user-other', position: 0 }, { userId: HOST, position: 1 }] })
    const slot = { start: window.start + 2 * H, end: window.start + 2.5 * H, hostIds: [HOST] }
    const linkTimes = vi.fn(async () => ({ known: true as const, timeZone: 'America/Chicago', slots: [slot, { start: Date.parse(booking.startsAt), end: Date.parse(booking.endsAt), hostIds: [HOST] }] }))
    const deps = { ...manage, getLink: vi.fn(async () => link), linkTimes }
    const times = await rescheduleTimes(db, fromLink, deps)
    // The link's times only (the host's free window is not offered), never the current time.
    expect(times).toEqual({ ok: true, timeZone: 'America/Chicago', times: [{ start: slot.start, end: slot.end }] })
    expect(manage.freeTime).not.toHaveBeenCalled()
    const [own, range, readDeps] = linkTimes.mock.calls[0] as unknown as [typeof link, { from: number; to: number }, { exceptClaims: unknown; exceptEventId: unknown }]
    expect(own).toMatchObject({ hostMode: 'one', hosts: [{ userId: HOST, position: 0 }], durationMinutes: 30, noticeMinutes: 24 * 60, windowDays: 5 })
    expect(range.to - range.from).toBe(5 * 24 * H)
    expect(readDeps).toMatchObject({ exceptClaims: { bookingId: booking.id }, exceptEventId: 'evt-1' })
    // A time the link doesn't offer can't be picked, though the host is free then.
    expect(await rescheduleMeeting(db, { booking: fromLink, start: new Date(window.start).toISOString(), by: 'guest' }, deps)).toMatchObject({ ok: false, code: 'SLOT_TAKEN' })
    // An unread calendar is unknown, never free.
    expect(await rescheduleTimes(db, fromLink, { ...deps, linkTimes: vi.fn(async () => ({ known: false as const, reason: 'x' })) })).toMatchObject({ ok: false, code: 'CALENDAR_UNKNOWN' })
  })

  it('an offer still moves within the host’s working hours (no link to read)', async () => {
    const { db, booking, manage } = await booked()
    const getLink = vi.fn(async () => null)
    await rescheduleTimes(db, booking, { ...manage, getLink })
    expect(getLink).not.toHaveBeenCalled()
    expect(manage.freeTime).toHaveBeenCalled()
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

  it('two moves at once: the one that loses never touches the calendar, so the calendar and the booking agree', async () => {
    const { db, tables, booking, manage, window } = await booked()
    const first = new Date(window.start).toISOString()
    const second = new Date(window.start + H).toISOString()
    // Both read the same booking; the first wins the fence while the second waits on its read.
    const [a, b] = await Promise.all([rescheduleMeeting(db, { booking, start: first, by: 'guest' }, manage), rescheduleMeeting(db, { booking, start: second, by: 'guest' }, manage)])
    const won = [a, b].filter((r) => r.ok)
    expect(won).toHaveLength(1)
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: 'CLOSED' })
    const at = (won[0] as { booking: MeetingBooking }).booking.startsAt
    // One provider move, to where the booking now is; the loser's claim gone.
    expect(manage.updateEvent).toHaveBeenCalledTimes(1)
    expect(manage.updateEvent).toHaveBeenCalledWith(HOST, 'evt-1', expect.objectContaining({ start: at }), expect.anything())
    expect(tables.meeting_booking[0]).toMatchObject({ starts_at: at, reschedule_count: 1 })
    expect(tables.host_time_claim.map((c) => c.starts_at)).toEqual([at])
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
    expect(result).toEqual({ expired: 1, pollsBooked: 0, lapsedRequests: 0, finished: 1, failed: 0, stillBooking: 0 })
    expect(db.tables.time_offer[0].state).toBe('expired')
    expect(db.tables.host_time_claim).toHaveLength(0)
    expect(db.tables.meeting_booking[0]).toMatchObject({ state: 'confirmed', calendar_event_id: 'evt-1', attempts: 1 })
    expect(seams.createEvent).toHaveBeenCalledWith(HOST, expect.objectContaining({ attendees: ['sam@globex.example'] }), 'acct-google', { sendInvites: true, video: true, idempotencyKey: '6f0a8c1e-1b2c-4d5e-8f90-123456789abc' })
    // A second sweep finds nothing to do.
    expect(await sweepTimeOffers(db.db, { ...seams, now: () => NOW })).toEqual({ expired: 0, pollsBooked: 0, lapsedRequests: 0, finished: 0, failed: 0, stillBooking: 0 })
  })

  it("prunes the public pages' rate-limit rows older than two days (no cap counts back further than a day)", async () => {
    const at = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()
    const db = offerDb({
      time_offer_failure: [{ id: 'f-old', offer_id: 'o-1', reason: 'slot_taken', created_at: at(49) }, { id: 'f-new', offer_id: 'o-1', reason: 'slot_taken', created_at: at(20) }],
      booking_link_attempt: [{ id: 'a-old', link_id: 'l-1', client_hash: 'c', created_at: at(72) }, { id: 'a-new', link_id: 'l-1', client_hash: 'c', created_at: at(1) }],
    })
    await sweepTimeOffers(db.db, { ...bookingSeams(), now: () => NOW })
    expect(db.tables.time_offer_failure.map((r) => r.id)).toEqual(['f-new'])
    expect(db.tables.booking_link_attempt.map((r) => r.id)).toEqual(['a-new'])
  })
})

describe('a booking meeting on a call here: its meeting link follows it (migration 576)', () => {
  it('cancelled: the link is revoked', async () => {
    const { db, booking, manage } = await booked()
    const meetingChanged = vi.fn(async () => true)
    expect(await cancelMeeting(db, { booking, by: 'guest' }, { ...manage, meetingChanged })).toMatchObject({ ok: true })
    expect(meetingChanged).toHaveBeenCalledWith({ bookingId: booking.id, cancelled: true })
  })

  it('a cancellation the calendar refused leaves the link alone', async () => {
    const { db, booking, manage } = await booked()
    manage.deleteEvent.mockRejectedValueOnce(new Error('Google Calendar delete error: 500'))
    const meetingChanged = vi.fn(async () => true)
    expect(await cancelMeeting(db, { booking, by: 'host' }, { ...manage, meetingChanged })).toMatchObject({ ok: false })
    expect(meetingChanged).not.toHaveBeenCalled()
  })

  it('moved: the meeting moves with it, and the event keeps the link at the top', async () => {
    const { db, booking, manage, window } = await booked()
    const call = 'https://app.example/m/AbCdEfGhIjKlMnOpQrStUvWxYz012345'
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example')
    const meetingChanged = vi.fn(async () => true)
    const to = new Date(window.start).toISOString()
    const out = await rescheduleMeeting(db, { booking: { ...booking, conferenceUrl: call }, start: to, by: 'guest' }, { ...manage, meetingChanged })
    vi.unstubAllEnvs()
    expect(out).toMatchObject({ ok: true })
    expect(meetingChanged).toHaveBeenCalledWith({ bookingId: booking.id, startsAt: to, endsAt: new Date(window.start + 30 * 60_000).toISOString() })
    const [, , update] = manage.updateEvent.mock.calls[0] as unknown as [string, string, { description: string }]
    expect(update.description.split('\n')[0]).toBe(`Join the meeting: ${call}`)
  })

  it('a move the calendar refused leaves the meeting where it was', async () => {
    const { db, booking, manage, window } = await booked()
    manage.updateEvent.mockRejectedValueOnce(new Error('Google Calendar update error: 500'))
    const meetingChanged = vi.fn(async () => true)
    expect(await rescheduleMeeting(db, { booking, start: new Date(window.start).toISOString(), by: 'guest' }, { ...manage, meetingChanged })).toMatchObject({ ok: false, code: 'FAILED' })
    expect(meetingChanged).not.toHaveBeenCalled()
  })
})

