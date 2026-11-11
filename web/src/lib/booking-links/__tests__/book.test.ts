/**
 * Booking a time on a link (../book.ts): the time read again live, the host
 * chosen (one, all attending, or the least booked of any), the booking and a
 * claim per attending host in one transaction (two at once make one), then
 * the provider event with the guest (and the other hosts) invited, or the
 * host's yes first (a link that asks first, or a guest who gave only a
 * mobile number); the yes books it and a mobile-only guest is texted; a no
 * or no answer lets the time go and contacts no one. Over the one booking
 * model in memory; the studio and its guests are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: vi.fn() }))

import { claimsOf } from '@/test/booking-db'
import { confirmBooking, settleBookingApproval } from '@/lib/customers/booking'
import { insertBooking } from '@/lib/customers/store'
import { cancelMeeting, rescheduleMeeting } from '@/lib/time-offers/manage'
import { getBooking, listBookings } from '@/lib/time-offers/store'
import { sweepTimeOffers } from '@/lib/time-offers/sweep'
import { manageTokenFor, manageTokenHash } from '@/lib/time-offers/tokens'
import { bookFromLink, confirmLinkRequest, readGuest, readGuestAnswers, requestCard, settleLinkRequest } from '../book'
import { LINK_REQUEST_HOLD_MS } from '../types'
import { AVA, BEN, hoursAhead, linkOf, NY, openAt, seams, studioDb, WS } from './fixtures'

const NOW = Date.now()
const T1 = hoursAhead(30, NOW)
const T2 = hoursAhead(54, NOW)
const DANA = { name: 'Dana Reyes', email: 'Dana@Initech.example', answers: { company: 'Initech' } }

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a guest books straight on', () => {
  it('the time is held for the host and booked: the provider event with the guest invited, the answers kept, the manage link, the host told', async () => {
    const { db, tables } = studioDb()
    const s = seams({ readTimes: openAt([T1]) })
    const result = await bookFromLink(db, { link: linkOf(), input: { start: T1, ...DANA, note: 'Can we talk pricing?', timeZone: 'America/Chicago' } }, s.deps)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const b = result.booking
    expect(b).toMatchObject({ state: 'confirmed', source: 'link', hostUserId: AVA, hostName: 'Ava Lin', guestName: 'Dana Reyes', guestEmail: 'dana@initech.example', guestTimeZone: 'America/Chicago', title: 'Intro call', video: true, calendarEventId: 'evt-1', hostTimeZone: NY })
    expect(b.answers).toEqual([{ id: 'company', label: 'Company', answer: 'Initech' }])
    expect(b.linkId).toBe(linkOf().id)
    expect(result.manageUrl).toBe(`https://app.example/b/${manageTokenFor(b.id, 'test-secret')}`)
    expect(tables.meeting_booking[0].manage_token_hash).toBe(manageTokenHash(manageTokenFor(b.id, 'test-secret')))
    expect(tables.host_time_claim.map((c) => [c.host_user_id, c.booking_id, c.expires_at])).toEqual([[AVA, b.id, null]])
    const [, event, accountId, options] = s.createEvent.mock.calls[0] as unknown as [string, { attendees: string[]; description: string }, string, { sendInvites: boolean; video: boolean; idempotencyKey: string }]
    expect(event.attendees).toEqual(['dana@initech.example'])
    expect(event.description).toContain('Can we talk pricing?')
    expect(accountId).toBe('acct-google')
    expect(options).toEqual({ sendInvites: true, video: true, idempotencyKey: b.id })
    expect(s.tellHost).toHaveBeenCalledWith(expect.objectContaining({ userId: AVA, messageId: `meeting-booking:${b.id}:booked`, routes: false }))
    expect(s.textGuest).not.toHaveBeenCalled()
  })

  it('everyone attends an `all` link: a claim for each host, the first organizes, the others are invited', async () => {
    const { db, tables } = studioDb()
    const s = seams({ readTimes: openAt([T1], [AVA, BEN]) })
    const link = linkOf({ hostMode: 'all', hosts: [{ userId: AVA, position: 0 }, { userId: BEN, position: 1 }] })
    const result = await bookFromLink(db, { link, input: { start: T1, ...DANA } }, s.deps)
    expect(result.ok && result.booking).toMatchObject({ hostUserId: AVA, otherHostIds: [BEN], hostName: 'Ava Lin and Ben Ruiz', state: 'confirmed' })
    expect(tables.host_time_claim.map((c) => c.host_user_id).sort()).toEqual([AVA, BEN])
    expect((s.createEvent.mock.calls[0] as unknown as [string, { attendees: string[] }])[1].attendees).toEqual(['dana@initech.example', 'ben@fernhill.example'])
  })

  it('an `any` link goes to the least booked host who is free then', async () => {
    // Ava already has two meetings this month; Ben one.
    const busy = (id: string, host: string, hours: number) => claimsOf({ id, workspace_id: WS, host_user_id: host, starts_at: hoursAhead(hours, NOW), ends_at: hoursAhead(hours + 1, NOW) })
    const { db } = studioDb({ host_time_claim: [...busy('b-a1', AVA, 100), ...busy('b-a2', AVA, 120), ...busy('b-b1', BEN, 140)] })
    const link = linkOf({ hostMode: 'any', hosts: [{ userId: AVA, position: 0 }, { userId: BEN, position: 1 }] })
    const result = await bookFromLink(db, { link, input: { start: T1, ...DANA } }, seams({ readTimes: openAt([T1], [AVA, BEN]) }).deps)
    expect(result.ok && result.booking.hostUserId).toBe(BEN)
    // Of those free then: only Ava can take T2, so it is hers.
    const second = await bookFromLink(db, { link, input: { start: T2, name: 'Lee Park', email: 'lee@globex.example', answers: { company: 'Globex' } } }, seams({ readTimes: openAt([T2], [AVA]) }).deps)
    expect(second.ok && second.booking.hostUserId).toBe(AVA)
  })
})

describe('never twice', () => {
  it('two guests at once for one time: exactly one booking, the other told it was taken', async () => {
    const { db, tables } = studioDb()
    const [a, b] = await Promise.all([
      bookFromLink(db, { link: linkOf(), input: { start: T1, ...DANA } }, seams({ readTimes: openAt([T1]) }).deps),
      bookFromLink(db, { link: linkOf(), input: { start: T1, name: 'Lee Park', email: 'lee@globex.example', answers: { company: 'Globex' } } }, seams({ readTimes: openAt([T1]) }).deps),
    ])
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
    expect([a, b].find((r) => !r.ok)).toMatchObject({ ok: false, code: 'SLOT_TAKEN' })
    expect(tables.meeting_booking).toHaveLength(1)
    expect(tables.host_time_claim).toHaveLength(1)
  })

  it('a time another booking of the host’s holds (an offer, a customer’s job) is taken: nothing is written', async () => {
    const { db, tables } = studioDb({ host_time_claim: claimsOf({ id: 'job-1', workspace_id: 'ws-other', host_user_id: AVA, starts_at: T1, ends_at: new Date(Date.parse(T1) + 3_600_000).toISOString() }) })
    const result = await bookFromLink(db, { link: linkOf(), input: { start: T1, ...DANA } }, seams({ readTimes: openAt([T1]) }).deps)
    expect(result).toMatchObject({ ok: false, code: 'SLOT_TAKEN' })
    expect(tables.meeting_booking).toHaveLength(0)
  })

  it('the same guest again (a double click) answers the booking it made', async () => {
    const { db, tables } = studioDb()
    const s = seams({ readTimes: openAt([T1]) })
    const first = await bookFromLink(db, { link: linkOf(), input: { start: T1, ...DANA } }, s.deps)
    const again = await bookFromLink(db, { link: linkOf(), input: { start: T1, ...DANA, email: 'dana@initech.example' } }, s.deps)
    expect(again).toMatchObject({ ok: true, already: true })
    expect(first.ok && again.ok && again.booking.id === first.booking.id).toBe(true)
    expect(tables.meeting_booking).toHaveLength(1)
    expect(s.createEvent).toHaveBeenCalledTimes(1)
  })
})

describe('what stops a booking', () => {
  it('a time that isn’t open, a calendar that can’t be read, no calendar to write to, a page turned off', async () => {
    const { db, tables } = studioDb()
    expect(await bookFromLink(db, { link: linkOf(), input: { start: T2, ...DANA } }, seams({ readTimes: openAt([T1]) }).deps)).toMatchObject({ ok: false, code: 'SLOT_TAKEN' })
    expect(await bookFromLink(db, { link: linkOf(), input: { start: T1, ...DANA } }, seams({ readTimes: vi.fn(async () => ({ known: false as const, reason: 'x' })) }).deps)).toMatchObject({ ok: false, code: 'UNAVAILABLE' })
    expect(await bookFromLink(db, { link: linkOf(), input: { start: T1, ...DANA } }, seams({ readTimes: openAt([T1]), calendarAccount: vi.fn(async () => null) }).deps)).toMatchObject({ ok: false, code: 'NO_CALENDAR' })
    expect(await bookFromLink(db, { link: linkOf({ active: false }), input: { start: T1, ...DANA } }, seams({ readTimes: openAt([T1]) }).deps)).toMatchObject({ ok: false, code: 'CLOSED' })
    expect(await bookFromLink(db, { link: linkOf({ purpose: 'job' }), input: { start: T1, ...DANA } }, seams({ readTimes: openAt([T1]) }).deps)).toMatchObject({ ok: false, code: 'CLOSED' })
    expect(tables.meeting_booking).toHaveLength(0)
  })

  it('a guest is a name and an email or a US or Canadian mobile; required answers are required', async () => {
    expect(readGuest({ start: T1, name: '  ' })).toMatchObject({ ok: false, code: 'BAD_INPUT', field: 'name' })
    expect(readGuest({ start: T1, name: 'Dana' })).toMatchObject({ ok: false, code: 'NEEDS_CONTACT' })
    expect(readGuest({ start: T1, name: 'Dana', email: 'not-an-email' })).toMatchObject({ ok: false, code: 'BAD_INPUT', field: 'email' })
    expect(readGuest({ start: T1, name: 'Dana', phone: '+44 20 7946 0958' })).toMatchObject({ ok: false, code: 'BAD_INPUT', field: 'phone' })
    expect(readGuest({ start: T1, name: 'Dana', phone: '(312) 555-0142' })).toEqual({ ok: true, name: 'Dana', email: null, phone: '+13125550142' })
    const link = linkOf({ questions: [{ id: 'company', label: 'Company', required: true, kind: 'text' }, { id: 'goals', label: 'What should we cover?', required: false, kind: 'long' }] })
    expect(readGuestAnswers(link, {})).toMatchObject({ ok: false, code: 'BAD_INPUT', field: 'company' })
    expect(readGuestAnswers(link, { company: '  Initech\n Inc ', goals: 'Line one\r\nLine two', stray: 'ignored' })).toEqual({
      ok: true,
      answers: [
        { id: 'company', label: 'Company', answer: 'Initech Inc' },
        { id: 'goals', label: 'What should we cover?', answer: 'Line one\nLine two' },
      ],
    })
  })

  it('a mobile-only guest needs a workspace that can text them; without a number they are asked for an email', async () => {
    const { db } = studioDb()
    const result = await bookFromLink(db, { link: linkOf(), input: { start: T1, name: 'Sam Ortiz', phone: '+13125550177', answers: { company: 'Hooli' } } }, seams({ readTimes: openAt([T1]), canText: vi.fn(async () => false) }).deps)
    expect(result).toMatchObject({ ok: false, code: 'NEEDS_EMAIL', field: 'email' })
  })
})

describe("the host's yes first", () => {
  it('a link that asks first holds the time and asks the organizer on one card; nothing goes on the calendar yet', async () => {
    const { db, tables } = studioDb()
    const s = seams({ readTimes: openAt([T1]), now: () => NOW })
    const result = await bookFromLink(db, { link: linkOf({ askFirst: true }), input: { start: T1, ...DANA } }, s.deps)
    expect(result.ok && result.booking.state).toBe('requested')
    if (!result.ok) return
    const claim = tables.host_time_claim[0]
    expect(Date.parse(String(claim.expires_at))).toBe(NOW + LINK_REQUEST_HOLD_MS)
    expect(s.createEvent).not.toHaveBeenCalled()
    expect(s.createApproval).toHaveBeenCalledTimes(1)
    const approval = (s.createApproval.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(approval).toMatchObject({ door: 'chat', userId: AVA, workspaceId: WS, toolName: 'confirm_booking', sideEffect: 'external-write', conversationId: null, reason: 'booking_link' })
    expect(approval.context).toEqual({ booking: { bookingId: result.booking.id }, tools: { origin: { actor: 'agent', depth: 1 } } })
    expect(approval.input).toMatchObject({ booking_id: result.booking.id, guest: 'Dana Reyes', email: 'dana@initech.example', link: 'Intro call' })
    expect((approval.card as { title: string }).title).toMatch(/^Intro call with Dana Reyes, .+\?$/)
    expect(tables.meeting_booking[0].approval_id).toBe('appr-1')
  })

  it('a guest who gave only a mobile number waits for the host’s yes even on a link that books straight on', async () => {
    const { db } = studioDb()
    const s = seams({ readTimes: openAt([T1]) })
    const result = await bookFromLink(db, { link: linkOf(), input: { start: T1, name: 'Sam Ortiz', phone: '312-555-0177', answers: { company: 'Hooli' } } }, s.deps)
    expect(result.ok && result.booking).toMatchObject({ state: 'requested', guestPhone: '+13125550177', guestEmail: null })
    expect(requestCard({ linkTitle: 'Intro call', guestName: 'Sam Ortiz', label: 'Tue, Jan 7, 10:00 AM EST', invited: false }).why).toContain('texts them a confirmation from the business number')
  })

  it('no card, no hold: the request is cancelled and its time let go', async () => {
    const { db, tables } = studioDb()
    const result = await bookFromLink(db, { link: linkOf({ askFirst: true }), input: { start: T1, ...DANA } }, seams({ readTimes: openAt([T1]), createApproval: vi.fn(async () => ({ ok: false as const, code: 'TOO_MANY_PENDING' as const, error: 'x' })) as never }).deps)
    expect(result).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING' })
    expect(tables.meeting_booking[0].state).toBe('cancelled')
    expect(tables.host_time_claim).toHaveLength(0)
  })

  async function requested(input: Record<string, unknown> = {}) {
    const studio = studioDb()
    const s = seams({ readTimes: openAt([T1]) })
    const made = await bookFromLink(studio.db, { link: linkOf({ askFirst: true }), input: { start: T1, ...DANA, ...input } }, s.deps)
    if (!made.ok) throw new Error(made.message)
    return { ...studio, s, booking: made.booking }
  }
  const free = vi.fn(async (input: { spans: readonly unknown[] }) => ({ known: true as const, busy: input.spans.map(() => false) }))

  it('yes: every host’s calendar read again (its own claim left out), the claim kept for good, the event written and the guest invited', async () => {
    const { db, tables, s, booking } = await requested()
    const checkFree = vi.fn(free)
    const result = await confirmLinkRequest(db, { userId: AVA, workspaceId: WS, bookingId: booking.id }, { checkFree, accept: s.deps.accept })
    expect(result).toMatchObject({ success: true, booking_id: booking.id, state: 'confirmed' })
    expect(checkFree).toHaveBeenCalledWith(expect.objectContaining({ userId: AVA, exceptClaims: { bookingId: booking.id } }))
    expect(tables.host_time_claim.map((c) => c.expires_at)).toEqual([null])
    expect((await getBooking(db, booking.id))?.state).toBe('confirmed')
    expect(s.createEvent).toHaveBeenCalledTimes(1)
    // Once only: a second yes changes nothing.
    expect(await confirmLinkRequest(db, { userId: AVA, workspaceId: WS, bookingId: booking.id }, { checkFree, accept: s.deps.accept })).toMatchObject({ success: false })
    expect(s.createEvent).toHaveBeenCalledTimes(1)
  })

  it('yes to a mobile-only guest: booked, and they are texted the confirmation with their manage link', async () => {
    const { db, s, booking } = await requested({ email: null, phone: '+13125550177', name: 'Sam Ortiz' })
    await confirmLinkRequest(db, { userId: AVA, workspaceId: WS, bookingId: booking.id }, { checkFree: free, accept: s.deps.accept })
    expect(s.textGuest).toHaveBeenCalledTimes(1)
    const [to, body] = s.textGuest.mock.calls[0] as unknown as [{ guestPhone: string }, string]
    expect(to.guestPhone).toBe('+13125550177')
    expect(body).toMatch(/^You're booked with Ava Lin: Intro call, .+ EST\. To move or cancel it: https:\/\/app\.example\/b\/[A-Za-z0-9_-]{24}$/)
    expect(s.tellHost).toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('they got a confirmation text') }))
  })

  it('yes after the time filled (or a calendar that can’t be read): not booked, the time let go, the guest not contacted', async () => {
    const { db, tables, s, booking } = await requested()
    const busy = vi.fn(async () => ({ known: true as const, busy: [true] }))
    expect(await confirmLinkRequest(db, { userId: AVA, workspaceId: WS, bookingId: booking.id }, { checkFree: busy, accept: s.deps.accept })).toMatchObject({ success: false, code: 'SLOT_TAKEN' })
    expect(tables.meeting_booking[0].state).toBe('declined')
    expect(tables.host_time_claim).toHaveLength(0)
    expect(s.createEvent).not.toHaveBeenCalled()
    expect(s.textGuest).not.toHaveBeenCalled()
  })

  it("someone else's yes, or another workspace's, never books it", async () => {
    const { db, booking, s } = await requested()
    expect(await confirmLinkRequest(db, { userId: BEN, workspaceId: WS, bookingId: booking.id }, { checkFree: free, accept: s.deps.accept })).toMatchObject({ success: false, error: 'That booking is gone.' })
    expect(await confirmLinkRequest(db, { userId: AVA, workspaceId: 'ws-other', bookingId: booking.id }, { checkFree: free, accept: s.deps.accept })).toMatchObject({ success: false })
  })

  it('the customer booking’s card runs it: confirm_booking hands a link’s request here, and its no or lapse settles it with no text', async () => {
    const { db, tables, booking } = await requested()
    const confirmLink = vi.fn(async () => ({ success: true }))
    expect(await confirmBooking(db, { userId: AVA, workspaceId: WS, bookingId: booking.id }, { confirmLink })).toEqual({ success: true })
    expect(confirmLink).toHaveBeenCalledWith({ userId: AVA, workspaceId: WS, bookingId: booking.id })
    const textCustomer = vi.fn(async () => true)
    await settleBookingApproval(db, { workspace_id: WS, context: { booking: { bookingId: booking.id } } }, 'denied', { textCustomer })
    expect(tables.meeting_booking[0].state).toBe('declined')
    expect(tables.host_time_claim).toHaveLength(0)
    expect(textCustomer).not.toHaveBeenCalled()
    // Settled once: a second settle changes nothing.
    expect(await settleLinkRequest(db, booking.id, 'expired')).toBe(false)
  })

  it('no answer: the sweep expires a request whose hold ran out, and its time is free again', async () => {
    const { db, tables, booking } = await requested()
    tables.host_time_claim[0].expires_at = new Date(Date.now() - 60_000).toISOString()
    const result = await sweepTimeOffers(db, { now: () => Date.now() })
    expect(result.lapsedRequests).toBe(1)
    expect(tables.meeting_booking[0].state).toBe('expired')
    expect(tables.host_time_claim).toHaveLength(0)
    expect((await getBooking(db, booking.id))?.state).toBe('expired')
  })

  it('the guest can take back a request from their manage page: cancelled, its time let go', async () => {
    const { db, tables, booking } = await requested()
    const result = await cancelMeeting(db, { booking, by: 'guest' }, { tellHost: vi.fn(async () => true) })
    expect(result.ok && result.booking.state).toBe('cancelled')
    expect(tables.host_time_claim).toHaveLength(0)
  })
})

describe('one model for every booking', () => {
  it("a customer's request for a time a link's meeting holds is taken; the host's lists keep offers' and links' apart from customers' jobs", async () => {
    const { db, tables } = studioDb()
    const made = await bookFromLink(db, { link: linkOf(), input: { start: T1, ...DANA } }, seams({ readTimes: openAt([T1]) }).deps)
    expect(made.ok).toBe(true)
    const job = await insertBooking(db, { workspaceId: WS, ownerUserId: AVA, source: 'sms', kind: 'pickup', startsAt: T1, endsAt: new Date(Date.parse(T1) + 3_600_000).toISOString(), customerName: 'Sarah Lee', customerPhone: '+12125550199' })
    expect(job).toEqual({ ok: false, reason: 'taken' })
    const later = await insertBooking(db, { workspaceId: WS, ownerUserId: AVA, source: 'sms', kind: 'pickup', startsAt: T2, endsAt: new Date(Date.parse(T2) + 3_600_000).toISOString(), customerName: 'Sarah Lee', customerPhone: '+12125550199', timeZone: NY })
    expect(later.ok && later.booking).toMatchObject({ origin: 'customer', source: 'sms', state: 'requested', kind: 'pickup' })
    expect(tables.meeting_booking.find((r) => r.source === 'customer')).toMatchObject({ channel: 'sms', title: 'Pickup: Sarah Lee', host_time_zone: NY, manage_token_hash: expect.stringMatching(/^none:/) })
    expect(tables.host_time_claim.find((c) => c.booking_id === (later.ok && later.booking.id))?.expires_at).not.toBeNull()
    expect((await listBookings(db, { workspaceId: WS })).map((b) => b.source)).toEqual(['link'])
  })

  it('a meeting every host attends moves with a claim for each of them, the old ones let go', async () => {
    const { db, tables } = studioDb()
    const link = linkOf({ hostMode: 'all', hosts: [{ userId: AVA, position: 0 }, { userId: BEN, position: 1 }] })
    const made = await bookFromLink(db, { link, input: { start: T1, ...DANA } }, seams({ readTimes: openAt([T1], [AVA, BEN]) }).deps)
    if (!made.ok) throw new Error(made.message)
    const to = Date.parse(T2)
    const updateEvent = vi.fn(async () => ({}) as never)
    const moved = await rescheduleMeeting(db, { booking: made.booking, start: T2, by: 'guest' }, { updateEvent, tellHost: vi.fn(async () => true), freeTime: async () => ({ known: true, free: [{ start: to, end: to + 3_600_000 }], timeZone: NY }) })
    expect(moved.ok && moved.booking.startsAt).toBe(T2)
    expect(tables.host_time_claim.map((c) => [c.host_user_id, c.starts_at]).sort()).toEqual([[AVA, T2], [BEN, T2]])
    expect(updateEvent).toHaveBeenCalledTimes(1)
  })
})
