/**
 * Picking a time (src/lib/time-offers/accept.ts): the hold becomes the
 * booking's claim in one step and the offer's other holds go; the host's
 * calendar is re-read live first; the provider event is written with the
 * guest invited, a video link and an idempotency key from the booking; the
 * same pick again answers its booking; two picks at once make one booking;
 * a time no longer free fails with the times still open; the agents book
 * only the offer's own recipient; a provider that fails leaves the booking
 * for the sweep, and its last try fails it, lets its time go, takes off any
 * event the provider made anyway and tells the host; a provider write that
 * hangs counts as failed well before the sweep could start a second; an
 * event written for a booking another attempt confirmed is never deleted;
 * a forwarded link books the offer's own address.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptOffer, finishBooking, type AcceptDeps } from '../accept'
import { createOffer, planOffer, type OfferRequest } from '../offers'
import { googleEventIdFor } from '@/lib/integrations/calendar'
import { manageTokenFor, manageTokenHash } from '../tokens'
import { bookingSeams, freeCalendar, hoursFromNow, HOST, offerDb, WS } from './fake-db'

const NOW = Date.now()
const SLOTS = [hoursFromNow(26, NOW), hoursFromNow(50, NOW), hoursFromNow(74, NOW)]

async function open(over: Partial<OfferRequest> = {}) {
  const db = offerDb()
  const cal = freeCalendar()
  const planned = await planOffer(db.db, { workspaceId: WS, hostUserId: HOST, recipient: { name: 'Dana Reyes', email: 'dana@initech.example', phone: '+13125550142' }, title: 'Intro call', slots: SLOTS, durationMinutes: 30, sendBy: 'link', ...over }, cal)
  if (!planned.ok) throw new Error(planned.message)
  const made = await createOffer(db.db, planned.plan, { state: 'open', createdBy: HOST }, cal)
  if (!made.ok) throw new Error(made.message)
  const seams = bookingSeams()
  const deps: AcceptDeps = { ...seams, checkFree: cal.checkFree, calendarAccount: cal.calendarAccount, findContact: cal.findContact }
  return { ...db, offer: made.offer, token: made.token!, cal, seams, deps }
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('acceptOffer on the public page', () => {
  it('books the slot: hold to booking claim, other holds gone, the provider event with the guest invited and a video link, confirmed, the host told', async () => {
    const { db, tables, token, offer, seams, cal, deps } = await open()
    const result = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[1], guest: { name: 'Dana R.', email: 'dana@initech.example', note: 'Looking forward', timeZone: 'Europe/Lisbon' }, via: 'link' }, deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.booking).toMatchObject({ state: 'confirmed', guestName: 'Dana R.', guestEmail: 'dana@initech.example', guestTimeZone: 'Europe/Lisbon', startsAt: SLOTS[1], calendarEventId: 'evt-1', conferenceUrl: 'https://meet.example/abc-defg-hij' })
    expect(result.manageUrl).toBe(`https://app.example/b/${manageTokenFor(result.booking.id, 'test-secret')}`)
    expect(tables.meeting_booking[0].manage_token_hash).toBe(manageTokenHash(manageTokenFor(result.booking.id, 'test-secret')))
    // The live re-check left this offer's own holds out.
    expect(cal.checkFree).toHaveBeenLastCalledWith(expect.objectContaining({ exceptClaims: { offerId: offer.id }, spans: [{ start: Date.parse(SLOTS[1]), end: Date.parse(SLOTS[1]) + 30 * 60_000 }] }))
    expect(tables.host_time_claim.map((c) => [c.kind, c.booking_id, c.starts_at])).toEqual([['booking', result.booking.id, SLOTS[1]]])
    expect(tables.time_offer_slot.map((s) => s.state).sort()).toEqual(['booked', 'released', 'released'])
    expect(tables.time_offer[0]).toMatchObject({ state: 'booked', booking_id: result.booking.id })
    const [userId, event, accountId, options] = seams.createEvent.mock.calls[0] as unknown as [string, { attendees: string[]; description: string; title: string }, string, Record<string, unknown>]
    expect(userId).toBe(HOST)
    expect(accountId).toBe('acct-google')
    expect(options).toEqual({ sendInvites: true, video: true, idempotencyKey: result.booking.id })
    expect(event.attendees).toEqual(['dana@initech.example'])
    expect(event.title).toBe('Intro call (Dana R.)')
    expect(event.description).toContain(result.manageUrl)
    expect(event.description).toContain('Booked through Native Intelligence')
    expect(event.description).toContain('Note from Dana R.: Looking forward')
    expect(googleEventIdFor(result.booking.id)).toMatch(/^ni[0-9a-v]{32}$/)
    expect(seams.tellHost).toHaveBeenCalledWith(expect.objectContaining({ userId: HOST, messageId: `meeting-booking:${result.booking.id}:booked`, routes: false, text: expect.stringContaining('Dana R. picked') }))
  })

  it('is idempotent: the same pick again answers the same booking and writes nothing new', async () => {
    const { db, tables, token, seams, deps } = await open()
    const first = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)
    const again = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'DANA@initech.example' }, via: 'link' }, deps)
    expect(first.ok && again.ok).toBe(true)
    if (!first.ok || !again.ok) return
    expect(again.already).toBe(true)
    expect(again.booking.id).toBe(first.booking.id)
    expect(again.manageUrl).toBe(first.manageUrl)
    expect(tables.meeting_booking).toHaveLength(1)
    expect(seams.createEvent).toHaveBeenCalledTimes(1)
    // Another time, or another email, is told it's booked.
    expect(await acceptOffer(db, { offer: { token }, slotStart: SLOTS[1], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)).toMatchObject({ ok: false, code: 'BOOKED' })
    expect(await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Lee', email: 'lee@umbrella.example' }, via: 'link' }, deps)).toMatchObject({ ok: false, code: 'BOOKED' })
  })

  it('two picks at once make exactly one booking', async () => {
    const { db, tables, token, deps } = await open()
    const [a, b] = await Promise.all([
      acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps),
      acceptOffer(db, { offer: { token }, slotStart: SLOTS[2], guest: { name: 'Lee', email: 'lee@umbrella.example' }, via: 'link' }, deps),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect([a, b].find((r) => !r.ok)).toMatchObject({ code: 'BOOKED' })
    expect(tables.meeting_booking).toHaveLength(1)
    expect(tables.host_time_claim.filter((c) => c.kind === 'booking')).toHaveLength(1)
    expect(tables.host_time_claim.filter((c) => c.kind === 'hold')).toHaveLength(0)
  })

  it('a time the host filled since fails the pick with the times still open, and lets that one go', async () => {
    const { db, tables, token, cal, deps } = await open()
    cal.checkFree.mockResolvedValueOnce({ known: true, busy: [true] })
    const result = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)
    expect(result).toMatchObject({ ok: false, code: 'SLOT_TAKEN' })
    expect(!result.ok && result.openSlots?.map((s) => s.startsAt)).toEqual([SLOTS[1], SLOTS[2]])
    expect(tables.host_time_claim.map((c) => c.starts_at)).toEqual([SLOTS[1], SLOTS[2]])
    expect(tables.time_offer_failure).toHaveLength(1)
    expect(tables.meeting_booking).toHaveLength(0)
  })

  it('an unknown calendar books nothing (never free because unread)', async () => {
    const { db, tables, token, cal, deps } = await open()
    cal.checkFree.mockResolvedValueOnce({ known: false, reason: 'down' } as never)
    expect(await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)).toMatchObject({ ok: false, code: 'CALENDAR_UNKNOWN' })
    expect(tables.meeting_booking).toHaveLength(0)
    expect(tables.host_time_claim).toHaveLength(3)
  })

  it('a time that is not one of the offer\'s, an expired or withdrawn offer, a missing email, an unknown token: each refused', async () => {
    const { db, tables, token, deps } = await open({ recipient: { name: 'Dana Reyes' } })
    expect(await acceptOffer(db, { offer: { token }, slotStart: hoursFromNow(30, NOW), guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)).toMatchObject({ ok: false, code: 'BAD_INPUT' })
    expect(await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana' }, via: 'link' }, deps)).toMatchObject({ ok: false, code: 'NEEDS_EMAIL' })
    expect(await acceptOffer(db, { offer: { token: 'A'.repeat(24) }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    tables.time_offer[0].expires_at = new Date(NOW - 1000).toISOString()
    expect(await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)).toMatchObject({ ok: false, code: 'EXPIRED' })
    tables.time_offer[0].state = 'withdrawn'
    expect(await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)).toMatchObject({ ok: false, code: 'WITHDRAWN' })
  })
})

describe('acceptOffer for the agents: the offer\'s own recipient only', () => {
  it("the host's agent books the stored recipient, never anyone a message named; only the offer's own host may", async () => {
    const { db, offer, seams, deps } = await open()
    expect(await acceptOffer(db, { offer: { id: offer.id, workspaceId: WS }, slotStart: SLOTS[0], via: 'host', actingUserId: 'user-other' }, deps)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    // Guest details passed by the agent are ignored: the offer's own recipient is booked.
    const result = await acceptOffer(db, { offer: { id: offer.id, workspaceId: WS }, slotStart: SLOTS[0], via: 'host', actingUserId: HOST, guest: { name: 'Mallory', email: 'mallory@evil.example' } }, deps)
    expect(result).toMatchObject({ ok: true, booking: { guestName: 'Dana Reyes', guestEmail: 'dana@initech.example', guestPhone: '+13125550142' } })
    expect((seams.createEvent.mock.calls[0] as unknown as [string, { attendees: string[] }])[1].attendees).toEqual(['dana@initech.example'])
    // Another workspace never finds it.
    expect(await acceptOffer(db, { offer: { id: offer.id, workspaceId: 'ws-other' }, slotStart: SLOTS[0], via: 'host', actingUserId: HOST }, deps)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it("the business's assistant books only an offer made to the number the customer texts from", async () => {
    const { db, offer, deps } = await open()
    expect(await acceptOffer(db, { offer: { id: offer.id, workspaceId: WS }, slotStart: SLOTS[0], via: 'customer', guestPhone: '+13125550199' }, deps)).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    expect(await acceptOffer(db, { offer: { id: offer.id, workspaceId: WS }, slotStart: SLOTS[2], via: 'customer', guestPhone: '+1 312 555 0142' }, deps)).toMatchObject({ ok: true, booking: { guestName: 'Dana Reyes', startsAt: SLOTS[2] } })
  })
})

describe('finishBooking: the provider event, retried', () => {
  it('a provider that fails leaves the booking in booking (the sweep retries with the same key); the last try fails it, lets its time go and tells the host', async () => {
    const { db, tables, token, seams, deps } = await open()
    seams.createEvent.mockRejectedValue(new Error('Google Calendar create error: 503'))
    const result = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)
    expect(result).toMatchObject({ ok: true, booking: { state: 'booking', attempts: 1, lastError: 'Google Calendar create error: 503' } })
    if (!result.ok) return
    expect(tables.host_time_claim.filter((c) => c.booking_id === result.booking.id)).toHaveLength(1)
    expect(await finishBooking(db, result.booking.id, deps)).toMatchObject({ state: 'booking', attempts: 2 })
    const failed = await finishBooking(db, result.booking.id, deps)
    expect(failed).toMatchObject({ state: 'failed', attempts: 3 })
    expect(tables.host_time_claim).toHaveLength(0)
    const keys = seams.createEvent.mock.calls.map((c) => (c as unknown as [unknown, unknown, unknown, { idempotencyKey: string }])[3].idempotencyKey)
    expect(new Set(keys)).toEqual(new Set([result.booking.id]))
    expect(seams.tellHost).toHaveBeenCalledWith(expect.objectContaining({ messageId: `meeting-booking:${result.booking.id}:failed`, routes: true, text: expect.stringContaining("couldn't be put on your calendar") }))
    // Any event its key made is looked for and taken off before the host is told: none here.
    expect(seams.deleteEventByKey).toHaveBeenCalledWith(HOST, result.booking.id, { accountId: 'acct-google' })
    expect(seams.tellHost).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining('so they got no invitation') }))
    // A finished booking is left alone.
    expect(await finishBooking(db, result.booking.id, deps)).toMatchObject({ state: 'failed', attempts: 3 })
    expect(seams.createEvent).toHaveBeenCalledTimes(3)
  })

  it('a last try whose event the provider made anyway takes it off, and the host hears so; one that can’t be told says to check', async () => {
    for (const [found, words] of [['deleted', 'taken off again'], ['unknown', 'If the event shows on your calendar anyway, delete it there']] as const) {
      const { db, token, seams, deps } = await open()
      seams.createEvent.mockRejectedValue(new Error('Google Calendar create error: 502'))
      if (found === 'deleted') seams.deleteEventByKey.mockResolvedValue('deleted')
      else seams.deleteEventByKey.mockRejectedValue(new Error('token expired'))
      const result = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)
      if (!result.ok) throw new Error('not booked')
      await finishBooking(db, result.booking.id, deps)
      expect(await finishBooking(db, result.booking.id, deps)).toMatchObject({ state: 'failed' })
      expect(seams.tellHost).toHaveBeenLastCalledWith(expect.objectContaining({ text: expect.stringContaining(words) }))
    }
  })

  it('a provider write that hangs counts as a failed try, well inside the time the sweep waits', async () => {
    const { db, token, seams, deps } = await open()
    seams.createEvent.mockImplementationOnce(() => new Promise(() => {}))
    const result = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, { ...deps, providerTimeoutMs: 20 })
    expect(result).toMatchObject({ ok: true, booking: { state: 'booking', attempts: 1, lastError: expect.stringContaining('the calendar took over') } })
    const { BOOKING_PROVIDER_TIMEOUT_MS, BOOKING_STUCK_MS } = await import('../types')
    expect(BOOKING_PROVIDER_TIMEOUT_MS).toBeLessThan(BOOKING_STUCK_MS)
  })

  it('an attempt that finds the booking confirmed by another (the same key: the same event) leaves the event alone', async () => {
    const { db, tables, token, seams, deps } = await open()
    seams.createEvent.mockImplementationOnce(async (_u, event, accountId) => {
      Object.assign(tables.meeting_booking[0], { state: 'confirmed', calendar_event_id: 'evt-1' })
      return { id: 'evt-1', title: event.title, start: event.start, end: event.end, calendarId: 'primary', accountId } as never
    })
    const result = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)
    expect(result).toMatchObject({ ok: true, booking: { state: 'confirmed', calendarEventId: 'evt-1' } })
    expect(seams.deleteEvent).not.toHaveBeenCalled()
  })

  it('a forwarded link books the offer’s own address, whatever its holder types, and never hands back the booking', async () => {
    const { db, token, seams, deps } = await open()
    const result = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Mallory', email: 'mallory@evil.example' }, via: 'link' }, deps)
    expect(result).toMatchObject({ ok: true, booking: { guestEmail: 'dana@initech.example' } })
    const [, event] = seams.createEvent.mock.calls[0] as unknown as [string, { attendees: string[] }]
    expect(event.attendees).toEqual(['dana@initech.example'])
    expect(await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Mallory', email: 'mallory@evil.example' }, via: 'link' }, deps)).toMatchObject({ ok: false, code: 'BOOKED' })
  })

  it('a booking cancelled while its event was being written: the event goes too', async () => {
    const { db, tables, token, seams, deps } = await open()
    seams.createEvent.mockImplementationOnce(async (_u, event, accountId) => {
      tables.meeting_booking[0].state = 'cancelled'
      return { id: 'evt-late', title: event.title, start: event.start, end: event.end, calendarId: 'primary', accountId } as never
    })
    const result = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, deps)
    expect(result).toMatchObject({ ok: true, booking: { state: 'cancelled' } })
    expect(seams.deleteEvent).toHaveBeenCalledWith(HOST, 'evt-late', { accountId: 'acct-google', notifyAttendees: true })
  })
})

describe('finishBooking: meeting on a call here (one of our meeting links, migration 585)', () => {
  const CALL = 'https://app.example/m/AbCdEfGhIjKlMnOpQrStUvWxYz012345'

  it('the link is the event\'s place and the booking\'s conference link; no provider video link; the description leads with it', async () => {
    const { db, token, seams, deps } = await open()
    const meetingUrl = vi.fn(async () => CALL)
    const result = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, { ...deps, meetingUrl })
    expect(result).toMatchObject({ ok: true, booking: { state: 'confirmed', conferenceUrl: CALL } })
    if (!result.ok) return
    expect(meetingUrl).toHaveBeenCalledWith(expect.objectContaining({ id: result.booking.id, title: 'Intro call', startsAt: SLOTS[0] }))
    const [, event, , options] = seams.createEvent.mock.calls[0] as unknown as [string, { location?: string; description: string }, string, Record<string, unknown>]
    expect(options).toMatchObject({ video: false, idempotencyKey: result.booking.id })
    expect(event.location).toBe(CALL)
    expect(event.description.split('\n')[0]).toBe(`Join the meeting: ${CALL}`)
    expect(event.description).toContain(result.manageUrl)
  })

  it('a booking that doesn\'t meet here (or where calling isn\'t set up: no link) keeps the provider\'s video link', async () => {
    const { db, token, seams, deps } = await open()
    const result = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, { ...deps, meetingUrl: async () => null })
    expect(result).toMatchObject({ ok: true, booking: { conferenceUrl: 'https://meet.example/abc-defg-hij' } })
    const [, event, , options] = seams.createEvent.mock.calls[0] as unknown as [string, { location?: string; description: string }, string, Record<string, unknown>]
    expect(options).toMatchObject({ video: true })
    expect(event.location).toBeUndefined()
    expect(event.description).not.toContain('Join the meeting')
  })

  it('an offer asked to meet here keeps the choice only where calling is set up', async () => {
    const unset = await open({ callHere: true })
    expect(unset.tables.time_offer[0].call_here).toBeUndefined()
    vi.stubEnv('LIVEKIT_URL', 'wss://lk.example')
    vi.stubEnv('LIVEKIT_API_KEY', 'APIkey')
    vi.stubEnv('LIVEKIT_API_SECRET', 'a-secret-of-at-least-32-characters!!')
    const set = await open({ callHere: true })
    vi.unstubAllEnvs()
    expect(set.tables.time_offer[0].call_here).toBe(true)
  })

  it('a meeting link that can\'t be had never fails the booking: confirmed, with the provider\'s video link instead', async () => {
    const { db, token, seams, deps } = await open()
    const meetingUrl = vi.fn(async () => {
      throw new Error('meetings: booking meeting not made: down')
    })
    const result = await acceptOffer(db, { offer: { token }, slotStart: SLOTS[0], guest: { name: 'Dana', email: 'dana@initech.example' }, via: 'link' }, { ...deps, meetingUrl })
    expect(result).toMatchObject({ ok: true, booking: { state: 'confirmed', attempts: 1, conferenceUrl: 'https://meet.example/abc-defg-hij', lastError: null } })
    const [, event, , options] = seams.createEvent.mock.calls[0] as unknown as [string, { location?: string; description: string }, string, Record<string, unknown>]
    expect(options).toMatchObject({ video: true })
    expect(event.location).toBeUndefined()
    expect(event.description).not.toContain('Join the meeting')
    expect(seams.tellHost).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('picked') }))
  })
})

