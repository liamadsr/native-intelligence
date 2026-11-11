/**
 * The time offer tools (../time-offers.ts): what each hands the offer code,
 * and what the model reads back. offer_times passes the approved call (its
 * card's replay) and this turn's zone; accept_time_offer passes only the
 * offer and the start, the person as the host, never a guest; an unattended
 * run cancels no meeting; list_time_offers shows the person's own. The offer
 * code is mocked: src/lib/time-offers/__tests__ covers it.
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
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/time-offers/send', () => ({ runOfferTimes: mocks.runOfferTimes }))
vi.mock('@/lib/time-offers/accept', () => ({ acceptOffer: mocks.acceptOffer }))
vi.mock('@/lib/time-offers/offers', () => ({ withdrawOffer: mocks.withdrawOffer }))
vi.mock('@/lib/time-offers/manage', () => ({ hostBooking: mocks.hostBooking, cancelMeeting: mocks.cancelMeeting }))
vi.mock('@/lib/time-offers/store', () => ({ listOffers: mocks.listOffers, listBookings: mocks.listBookings }))

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
    expect(mocks.runOfferTimes).toHaveBeenCalledWith({ service: true }, { userId: HOST, workspaceId: WS, approvedCall, browserTimeZone: 'Europe/Lisbon' }, input)
    expect(await call(createTimeOfferTools(HOST, undefined), 'offer_times', input)).toMatchObject({ success: false })
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
    mocks.cancelMeeting.mockResolvedValueOnce({ ok: true, booking: { ...BOOKING, state: 'cancelled' } })
    const out = await call(createTimeOfferTools(HOST, WS), 'cancel_offered_meeting', { booking_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601' })
    expect(mocks.hostBooking).toHaveBeenCalledWith({ service: true }, { workspaceId: WS, userId: HOST, bookingId: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601' })
    expect(mocks.cancelMeeting).toHaveBeenCalledWith({ service: true }, { booking: BOOKING, by: 'host' })
    expect(out).toMatchObject({ success: true, state: 'cancelled', message: expect.stringContaining('sent them the cancellation') })
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

  it('withdraw passes the person and the offer', async () => {
    mocks.withdrawOffer.mockResolvedValueOnce({ ok: true, offer: { ...OFFER, state: 'withdrawn' } })
    expect(await call(createTimeOfferTools(HOST, WS), 'withdraw_time_offer', { offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601' })).toMatchObject({ success: true, offer: { state: 'withdrawn' } })
    expect(mocks.withdrawOffer).toHaveBeenCalledWith({ service: true }, { workspaceId: WS, userId: HOST, offerId: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601' })
  })
})
