/**
 * The time offer tools (../time-offers.ts): what each hands the offer code,
 * and what the model reads back. offer_times passes the approved call (its
 * card's replay) and this turn's zone, and whether the person is at the
 * keyboard (an offer by link is then shown to them); accept_time_offer passes
 * only the offer and the start, the person as the host, never a guest, and
 * books from an offer whose guests the person never saw only as their card's
 * replay (as record_time_offer_answer and book_poll_time do); an unattended
 * run cancels no meeting; list_time_offers shows the person's own, a poll
 * with each guest's link and answer. A poll's own (phase 5):
 * record_time_offer_answer passes only the poll, its guest and the times,
 * the person as the host; book_poll_time is never an unattended run's;
 * nudge_time_offer passes the approved call. The offer code is mocked:
 * src/lib/time-offers/__tests__ covers it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runOfferTimes: vi.fn(async () => ({ success: true, link: 'https://app.example/t/abc' })),
  acceptOffer: vi.fn(),
  withdrawOffer: vi.fn(),
  hostBooking: vi.fn(),
  cancelMeeting: vi.fn(),
  listOffers: vi.fn(async () => []),
  listBookings: vi.fn(async () => []),
  recordAnswer: vi.fn(),
  bookPollAnyway: vi.fn(),
  runNudge: vi.fn(async () => ({ success: true, sent_via: 'link' })),
  withRecipients: vi.fn(async (_s: unknown, offers: unknown[]) => offers.map((o) => ({ recipients: [], ...(o as object) }))),
  getOffer: vi.fn(async (): Promise<unknown> => ({ id: 'offer-1', recipientsShown: true })),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/time-offers/send', () => ({ runOfferTimes: mocks.runOfferTimes }))
vi.mock('@/lib/time-offers/accept', () => ({ acceptOffer: mocks.acceptOffer }))
vi.mock('@/lib/time-offers/offers', () => ({ withdrawOffer: mocks.withdrawOffer }))
vi.mock('@/lib/time-offers/manage', () => ({ hostBooking: mocks.hostBooking, cancelMeeting: mocks.cancelMeeting }))
vi.mock('@/lib/time-offers/store', () => ({ listOffers: mocks.listOffers, listBookings: mocks.listBookings, getOffer: mocks.getOffer }))
vi.mock('@/lib/time-offers/polls', () => ({ recordAnswer: mocks.recordAnswer, bookPollAnyway: mocks.bookPollAnyway, recipientLink: (origin: string, id: string) => `${origin}/t/link-${id}` }))
vi.mock('@/lib/time-offers/poll-send', () => ({ runNudge: mocks.runNudge }))
vi.mock('@/lib/time-offers/poll-store', () => ({ withRecipients: mocks.withRecipients, getPoll: vi.fn(async () => null) }))

import { createTimeOfferTools } from '../time-offers'

const HOST = 'user-ava'
const WS = 'ws-fernhill'
const call = (tools: Record<string, unknown>, name: string, input: unknown) =>
  (tools[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, { toolCallId: 't', messages: [] })

const OFFER = {
  id: 'offer-1',
  state: 'open',
  recipientName: 'Dana Reyes',
  recipientEmail: 'dana@initech.example',
  recipientPhone: null,
  title: 'Intro call',
  durationMinutes: 30,
  sentVia: 'link',
  timeZone: 'America/New_York',
  expiresAt: '2026-11-17T15:00:00.000Z',
  bookingId: null,
  slots: [{ id: 's-1', startsAt: '2026-11-17T15:00:00.000Z', endsAt: '2026-11-17T15:30:00.000Z', state: 'open' }],
}
const BOOKING = { id: 'b-1', state: 'confirmed', guestName: 'Dana Reyes', guestEmail: 'dana@initech.example', title: 'Intro call', startsAt: '2026-11-17T15:00:00.000Z', conferenceUrl: 'https://meet.example/x', offerId: 'offer-1', lastError: null }

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockClear()
})

describe('offer_times', () => {
  it("hands the offer code the call, the approved call and this turn's zone", async () => {
    const approvedCall = { approvalId: 'appr-1', tool: 'offer_times', timeOffer: { offer_id: 'offer-1', card_hash: 'h' } }
    const tools = createTimeOfferTools(HOST, WS, { approvedCall, timeZone: 'Europe/Lisbon' })
    const input = { recipient: { name: 'Dana' }, title: 'Intro call', slots: ['2026-11-17T10:00:00-05:00', '2026-11-18T10:00:00-05:00'], duration_minutes: 30 }
    expect(await call(tools, 'offer_times', input)).toMatchObject({ success: true })
    expect(mocks.runOfferTimes).toHaveBeenCalledWith({ service: true }, { userId: HOST, workspaceId: WS, approvedCall, browserTimeZone: 'Europe/Lisbon', omitGrants: false, personAttended: false }, input)
    expect(await call(createTimeOfferTools(HOST, undefined), 'offer_times', input)).toMatchObject({ success: false })
  })

  it('says when the person is at the keyboard, so an offer by link is marked shown to them', async () => {
    const input = { recipient: { name: 'Dana' }, title: 'Intro call', slots: ['2026-11-17T10:00:00-05:00', '2026-11-18T10:00:00-05:00'], duration_minutes: 30 }
    await call(createTimeOfferTools(HOST, WS, { personAttended: true }), 'offer_times', input)
    expect(mocks.runOfferTimes).toHaveBeenLastCalledWith({ service: true }, expect.objectContaining({ personAttended: true }), input)
  })

  it("on a guest's or a linked agent's turn it reads no grant (no linked guest is answered from their calendar)", async () => {
    await call(createTimeOfferTools(HOST, WS, { omitGrants: true }), 'offer_times', { recipients: [{ name: 'Dana' }, { name: 'Sam' }] })
    expect(mocks.runOfferTimes).toHaveBeenCalledWith({ service: true }, expect.objectContaining({ omitGrants: true }), expect.anything())
  })
})

const POLL_ID = '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601'
const GUEST_ID = '8e2c3d4f-5061-4b72-9c83-0d94e5f60712'
const POLL = {
  ...OFFER,
  id: POLL_ID,
  mode: 'poll',
  coHostIds: ['user-lee'],
  recipientName: 'Dana Reyes and Sam Ortiz',
  recipients: [
    { id: GUEST_ID, name: 'Dana Reyes', email: 'dana@initech.example', phone: null, sent: true, answeredAt: '2026-11-11T12:00:00.000Z', answeredVia: 'calendar', works: ['s-1'], note: null, attending: null },
    { id: 'g-2', name: 'Sam Ortiz', email: null, phone: '+13125550143', sent: true, answeredAt: null, answeredVia: null, works: [], note: null, attending: null },
  ],
}

describe('record_time_offer_answer', () => {
  it("passes only the poll, its guest and the times, with the person as the host", async () => {
    mocks.recordAnswer.mockResolvedValueOnce({ ok: true, poll: POLL, recipient: POLL.recipients[0], booking: null, waiting: 1 })
    const tools = createTimeOfferTools(HOST, WS)
    const out = await call(tools, 'record_time_offer_answer', { offer_id: POLL_ID, guest_id: GUEST_ID, works: ['2026-11-17T15:00:00.000Z'], note: 'Mornings' })
    expect(mocks.recordAnswer).toHaveBeenCalledWith({ service: true }, { ref: { offerId: POLL_ID, workspaceId: WS, recipientId: GUEST_ID }, works: ['2026-11-17T15:00:00.000Z'], none: false, note: 'Mornings', via: 'host', actingUserId: HOST })
    expect(out).toMatchObject({ success: true, waiting: 1, message: expect.stringContaining('1 still to answer') })
    const schema = (tools.record_time_offer_answer as unknown as { inputSchema: { safeParse: (v: unknown) => { data?: unknown } } }).inputSchema
    expect(schema.safeParse({ offer_id: POLL_ID, guest_id: GUEST_ID, works: [], none_work: true, guest_email: 'mallory@evil.example' }).data).toEqual({ offer_id: POLL_ID, guest_id: GUEST_ID, works: [], none_work: true })
  })

  it('the last answer that booked comes back with the booking', async () => {
    mocks.recordAnswer.mockResolvedValueOnce({ ok: true, poll: { ...POLL, state: 'booked' }, recipient: POLL.recipients[1], booking: { ...BOOKING, source: 'poll' }, waiting: 0 })
    expect(await call(createTimeOfferTools(HOST, WS), 'record_time_offer_answer', { offer_id: POLL_ID, guest_id: GUEST_ID, works: ['2026-11-17T15:00:00.000Z'] })).toMatchObject({
      success: true,
      booking: { booking_id: 'b-1', from_poll: true },
      message: expect.stringContaining('Everyone has answered'),
    })
  })
})

describe('book_poll_time', () => {
  it('an unattended run books nothing; the person books with whoever can make it', async () => {
    expect(await call(createTimeOfferTools(HOST, WS, { unattended: true }), 'book_poll_time', { offer_id: POLL_ID, start: '2026-11-17T15:00:00.000Z' })).toMatchObject({ success: false, code: 'NEEDS_PERSON' })
    expect(mocks.bookPollAnyway).not.toHaveBeenCalled()
    mocks.bookPollAnyway.mockResolvedValueOnce({ ok: true, poll: { ...POLL, recipients: [{ ...POLL.recipients[0], attending: true }, { ...POLL.recipients[1], attending: false }] }, booking: { ...BOOKING, source: 'poll' }, left: [{ ...POLL.recipients[1], attending: false }] })
    const out = await call(createTimeOfferTools(HOST, WS), 'book_poll_time', { offer_id: POLL_ID, start: '2026-11-17T15:00:00.000Z', without: ['Sam'] })
    expect(mocks.bookPollAnyway).toHaveBeenCalledWith({ service: true }, { workspaceId: WS, userId: HOST, offerId: POLL_ID, start: '2026-11-17T15:00:00.000Z', without: ['Sam'] })
    expect(out).toMatchObject({ success: true, attending: ['Dana Reyes'], left_out: ['Sam Ortiz'] })
  })
})

describe('nudge_time_offer', () => {
  it('passes the approved call: by email or text it sends only as its card', async () => {
    const approvedCall = { approvalId: 'appr-1', tool: 'nudge_time_offer', timeOffer: { offer_id: POLL_ID, card_hash: 'h' } }
    await call(createTimeOfferTools(HOST, WS, { approvedCall }), 'nudge_time_offer', { offer_id: POLL_ID, send_by: 'email' })
    expect(mocks.runNudge).toHaveBeenCalledWith({ service: true }, { userId: HOST, workspaceId: WS, approvedCall }, { offer_id: POLL_ID, send_by: 'email' })
  })
})

describe('accept_time_offer', () => {
  it('passes only the offer and the start, with the person as the host; never a guest', async () => {
    mocks.acceptOffer.mockResolvedValueOnce({ ok: true, already: false, offer: OFFER, booking: BOOKING, manageUrl: 'https://app.example/b/x' })
    const tools = createTimeOfferTools(HOST, WS)
    const out = await call(tools, 'accept_time_offer', { offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', start: '2026-11-17T15:00:00.000Z' })
    expect(mocks.acceptOffer).toHaveBeenCalledWith({ service: true }, { offer: { id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', workspaceId: WS }, slotStart: '2026-11-17T15:00:00.000Z', via: 'host', actingUserId: HOST })
    expect(out).toMatchObject({ success: true, booking: { booking_id: 'b-1', state: 'confirmed', guest: { name: 'Dana Reyes' } }, message: expect.stringContaining('The calendar sent them the invitation.') })
    // Its schema takes nothing else.
    const schema = (tools.accept_time_offer as unknown as { inputSchema: { safeParse: (v: unknown) => { success: boolean; data?: unknown } } }).inputSchema
    expect(schema.safeParse({ offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', start: '2026-11-17T15:00:00.000Z', guest_email: 'mallory@evil.example' }).data).toEqual({ offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', start: '2026-11-17T15:00:00.000Z' })
  })

  it("from an offer whose guests the person never saw, it books only as the replay of the person's card", async () => {
    const offerId = '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601'
    for (const [name, input] of [
      ['accept_time_offer', { offer_id: offerId, start: '2026-11-17T15:00:00.000Z' }],
      ['record_time_offer_answer', { offer_id: offerId, guest_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f602', works: ['2026-11-17T15:00:00.000Z'] }],
      ['book_poll_time', { offer_id: offerId, start: '2026-11-17T15:00:00.000Z' }],
    ] as const) {
      mocks.getOffer.mockResolvedValueOnce({ id: offerId, recipientsShown: false })
      expect(await call(createTimeOfferTools(HOST, WS), name, input), name).toMatchObject({ success: false, code: 'NEEDS_PERSON' })
      mocks.getOffer.mockResolvedValueOnce({ id: offerId, recipientsShown: false })
      expect(await call(createTimeOfferTools(HOST, WS, { unattended: true }), name, input), name).toMatchObject({ success: false, code: 'NEEDS_PERSON' })
    }
    expect(mocks.acceptOffer).not.toHaveBeenCalled()
    expect(mocks.recordAnswer).not.toHaveBeenCalled()
    expect(mocks.bookPollAnyway).not.toHaveBeenCalled()
    // The replay of the person's own card for it runs (a home turn's card, book_poll_time too).
    mocks.getOffer.mockResolvedValue({ id: offerId, recipientsShown: false })
    mocks.acceptOffer.mockResolvedValueOnce({ ok: true, already: false, offer: OFFER, booking: BOOKING, manageUrl: 'https://app.example/b/x' })
    expect(await call(createTimeOfferTools(HOST, WS, { approvedCall: { approvalId: 'appr-9', tool: 'accept_time_offer' } }), 'accept_time_offer', { offer_id: offerId, start: '2026-11-17T15:00:00.000Z' })).toMatchObject({ success: true })
    mocks.bookPollAnyway.mockResolvedValueOnce({ ok: true, poll: { timeZone: 'America/New_York', recipients: [{ name: 'Dana Reyes', attending: true }] }, booking: BOOKING, left: [] })
    expect(await call(createTimeOfferTools(HOST, WS, { unattended: true, approvedCall: { approvalId: 'appr-9', tool: 'book_poll_time' } }), 'book_poll_time', { offer_id: offerId, start: '2026-11-17T15:00:00.000Z' })).toMatchObject({ success: true })
    // Another tool's approval is not this one's.
    expect(await call(createTimeOfferTools(HOST, WS, { approvedCall: { approvalId: 'appr-9', tool: 'offer_times' } }), 'accept_time_offer', { offer_id: offerId, start: '2026-11-17T15:00:00.000Z' })).toMatchObject({ code: 'NEEDS_PERSON' })
    mocks.getOffer.mockReset().mockResolvedValue({ id: 'offer-1', recipientsShown: true })
  })

  it("a time no longer open comes back with the times still open", async () => {
    mocks.acceptOffer.mockResolvedValueOnce({ ok: false, code: 'SLOT_TAKEN', message: 'That time is no longer available.', openSlots: [{ startsAt: '2026-11-18T19:00:00.000Z' }] })
    expect(await call(createTimeOfferTools(HOST, WS), 'accept_time_offer', { offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', start: '2026-11-17T15:00:00.000Z' })).toEqual({
      success: false,
      code: 'SLOT_TAKEN',
      error: 'That time is no longer available.',
      still_open: [{ start: '2026-11-18T19:00:00.000Z' }],
    })
  })
})

describe('cancel_offered_meeting', () => {
  it('an unattended run cancels nothing; the person cancels their own booking, the guest told by the calendar', async () => {
    expect(await call(createTimeOfferTools(HOST, WS, { unattended: true }), 'cancel_offered_meeting', { booking_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601' })).toMatchObject({ success: false, code: 'NEEDS_PERSON' })
    expect(mocks.hostBooking).not.toHaveBeenCalled()
    mocks.hostBooking.mockResolvedValueOnce(BOOKING)
    mocks.cancelMeeting.mockResolvedValueOnce({ ok: true, booking: { ...BOOKING, state: 'cancelled', calendarEventId: 'evt-1' } })
    const out = await call(createTimeOfferTools(HOST, WS), 'cancel_offered_meeting', { booking_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601' })
    expect(mocks.hostBooking).toHaveBeenCalledWith({ service: true }, { workspaceId: WS, userId: HOST, bookingId: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601' })
    expect(mocks.cancelMeeting).toHaveBeenCalledWith({ service: true }, { booking: BOOKING, by: 'host' })
    expect(out).toMatchObject({ success: true, state: 'cancelled', message: 'Cancelled Intro call with Dana Reyes. The calendar sent Dana Reyes the cancellation.' })
    // No event written yet (a request, a booking mid-write): nobody was told, and it says so.
    mocks.hostBooking.mockResolvedValueOnce(BOOKING)
    mocks.cancelMeeting.mockResolvedValueOnce({ ok: true, booking: { ...BOOKING, state: 'cancelled', calendarEventId: null } })
    expect((await call(createTimeOfferTools(HOST, WS), 'cancel_offered_meeting', { booking_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601' })).message).toMatch(/nobody was told/)
    mocks.hostBooking.mockResolvedValueOnce(null)
    expect(await call(createTimeOfferTools(HOST, WS), 'cancel_offered_meeting', { booking_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601' })).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })
})

describe('list_time_offers and withdraw_time_offer', () => {
  it("the person's own offers and bookings, with the times in the host's zone", async () => {
    mocks.listOffers.mockResolvedValueOnce([OFFER] as never)
    mocks.listBookings.mockResolvedValueOnce([BOOKING] as never)
    const out = await call(createTimeOfferTools(HOST, WS), 'list_time_offers', {})
    expect(mocks.listOffers).toHaveBeenCalledWith({ service: true }, expect.objectContaining({ workspaceId: WS, hostUserId: HOST }))
    expect(out).toMatchObject({
      success: true,
      offers: [{ offer_id: 'offer-1', state: 'open', times: [{ start: '2026-11-17T15:00:00.000Z', label: expect.stringMatching(/Tue, Nov 17, 10:00 AM E[SD]T/), state: 'open' }] }],
      bookings: [{ booking_id: 'b-1', when: expect.stringMatching(/10:00 AM/), video_link: 'https://meet.example/x' }],
    })
  })

  it("a poll lists each guest with their link and what they answered", async () => {
    mocks.listOffers.mockResolvedValueOnce([POLL] as never)
    mocks.listBookings.mockResolvedValueOnce([])
    const out = await call(createTimeOfferTools(HOST, WS), 'list_time_offers', {})
    expect(mocks.listBookings).toHaveBeenCalledWith({ service: true }, expect.objectContaining({ sources: ['offer', 'link', 'poll'] }))
    expect(out).toMatchObject({
      offers: [
        {
          offer_id: POLL_ID,
          mode: 'poll',
          co_hosts: 1,
          guests: [
            { guest_id: GUEST_ID, name: 'Dana Reyes', link: expect.stringContaining(`/t/link-${GUEST_ID}`), answered: true, works: ['2026-11-17T15:00:00.000Z'], from_calendar: true },
            { guest_id: 'g-2', name: 'Sam Ortiz', answered: false },
          ],
        },
      ],
    })
  })

  it('withdraw passes the person and the offer', async () => {
    mocks.withdrawOffer.mockResolvedValueOnce({ ok: true, offer: { ...OFFER, state: 'withdrawn' } })
    expect(await call(createTimeOfferTools(HOST, WS), 'withdraw_time_offer', { offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601' })).toMatchObject({ success: true, offer: { state: 'withdrawn' } })
    expect(mocks.withdrawOffer).toHaveBeenCalledWith({ service: true }, { workspaceId: WS, userId: HOST, offerId: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601' })
  })
})
