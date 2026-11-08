/**
 * The public booking link (roadmap B4, ../booking-link.ts): the page shows
 * open times only, and a request goes the same way as one by text, capped
 * per business and per number; plus getting the business its number
 * (../numbers.ts) through Twilio's REST API, which is never called for real.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { BOOKING_LINK_HOURLY_CAP, BOOKING_LINK_PHONE_DAILY_CAP, handleBookingLinkPost, loadBookingPage, pageSlots, type BookingLinkDeps } from '../booking-link'
import { attachBusinessNumber, buyBusinessNumber, findBusinessNumber } from '../numbers'
import { parseProfilePatch, readClock, slugFromName } from '../profile-input'
import type { BusinessProfile } from '../types'

const PROFILE: BusinessProfile = {
  workspaceId: 'ws-rug',
  ownerUserId: 'user-owner',
  businessName: 'Bright Loom',
  customerFacts: 'Cleaning $5/sq ft',
  timeZone: 'America/New_York',
  bookingDays: [1, 2, 3, 4, 5],
  bookingStart: '09:00',
  bookingEnd: '17:00',
  slotMinutes: 60,
  leadHours: 24,
  horizonDays: 14,
  bookingKind: 'pickup',
  bookingSlug: 'bright-loom',
}
const SLOT = { start: '2026-11-02T15:00:00.000Z', end: '2026-11-02T16:00:00.000Z' }

function deps(over: Partial<BookingLinkDeps> = {}) {
  const d: BookingLinkDeps = {
    profileBySlug: vi.fn(async (slug) => (slug === 'bright-loom' ? PROFILE : null)),
    businessPhone: vi.fn(async () => '+16465550173'),
    openSlots: vi.fn(async () => ({ slots: [SLOT], timeZone: 'America/New_York', kind: 'pickup' })),
    countLinkRequestsSince: vi.fn(async () => 0),
    request: vi.fn(async () => ({ ok: true as const, booking: { id: 'b-1' } as never, approvalId: 'a-1', label: 'Mon, Nov 2, 10:00 AM' })),
    ...over,
  }
  return d
}

const post = (body: Record<string, unknown>) => new Request('https://dial8.ai/api/public/book/bright-loom', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
const GOOD = { start: SLOT.start, name: 'Sarah Lee', phone: '(212) 555-0199', address: '12 Elm St' }

describe('the page', () => {
  it("shows the business's open times, labelled in its zone, and its number", async () => {
    const state = await loadBookingPage('bright-loom', deps())
    expect(state).toEqual({ kind: 'open', businessName: 'Bright Loom', bookingKind: 'pickup', timeZone: 'America/New_York', phone: '+16465550173', slots: [{ ...SLOT, label: 'Mon, Nov 2, 10:00 AM', day: 'Mon, Nov 2', time: '10:00 AM' }] })
    expect(JSON.stringify(state)).not.toContain('Cleaning $5')
  })

  it('an unknown link is missing; a calendar that can’t be read says to text instead', async () => {
    expect(await loadBookingPage('nope', deps())).toEqual({ kind: 'missing' })
    expect(await loadBookingPage('bright-loom', deps({ openSlots: async () => { throw new Error('token') } }))).toEqual({ kind: 'unavailable', businessName: 'Bright Loom', phone: '+16465550173' })
  })

  it('groups slots by day', () => {
    expect(pageSlots([SLOT, { start: '2026-11-03T14:00:00.000Z', end: '2026-11-03T15:00:00.000Z' }], 'America/New_York').map((s) => s.day)).toEqual(['Mon, Nov 2', 'Tue, Nov 3'])
  })
})

describe('a request from the page', () => {
  it('asks the owner the same way as by text (source link), with their number in E.164', async () => {
    const d = deps()
    const res = await handleBookingLinkPost(post(GOOD), 'bright-loom', d)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, status: 'requested', when: 'Mon, Nov 2, 10:00 AM' })
    expect(d.request).toHaveBeenCalledWith({ workspaceId: 'ws-rug', ownerUserId: 'user-owner' }, { start: SLOT.start, name: 'Sarah Lee', phone: '+12125550199', address: '12 Elm St', note: null })
  })

  it('needs a time, a name and a US or Canadian mobile', async () => {
    expect((await handleBookingLinkPost(post({ ...GOOD, start: '' }), 'bright-loom', deps())).status).toBe(400)
    expect((await handleBookingLinkPost(post({ ...GOOD, name: ' ' }), 'bright-loom', deps())).status).toBe(400)
    expect((await handleBookingLinkPost(post({ ...GOOD, phone: '+447700900123' }), 'bright-loom', deps())).status).toBe(400)
  })

  it('is capped per business per hour and per number per day', async () => {
    expect((await handleBookingLinkPost(post(GOOD), 'bright-loom', deps({ countLinkRequestsSince: async (_w, _s, phone) => (phone ? 0 : BOOKING_LINK_HOURLY_CAP) }))).status).toBe(429)
    expect((await handleBookingLinkPost(post(GOOD), 'bright-loom', deps({ countLinkRequestsSince: async (_w, _s, phone) => (phone ? BOOKING_LINK_PHONE_DAILY_CAP : 0) }))).status).toBe(429)
  })

  it('a taken slot is 409; an unknown page 404; a honeypot is answered as if taken and asks no one', async () => {
    expect((await handleBookingLinkPost(post(GOOD), 'bright-loom', deps({ request: async () => ({ ok: false, code: 'SLOT_TAKEN', message: 'x' }) }))).status).toBe(409)
    expect((await handleBookingLinkPost(post(GOOD), 'nope', deps())).status).toBe(404)
    const d = deps()
    expect((await handleBookingLinkPost(post({ ...GOOD, website: 'spam' }), 'bright-loom', d)).status).toBe(200)
    expect(d.request).not.toHaveBeenCalled()
  })
})

describe('the business profile input', () => {
  it('reads days by name, clocks loosely, and refuses bad shapes with a sentence', () => {
    expect(parseProfilePatch({ booking_days: ['mon', 'Tuesday', 5], booking_start: '9am', booking_end: '5:30pm', slot_minutes: 90, booking_slug: 'Bright-Loom' })).toEqual({
      patch: { bookingDays: [1, 2, 5], bookingStart: '09:00', bookingEnd: '17:30', slotMinutes: 90, bookingSlug: 'bright-loom' },
    })
    expect(parseProfilePatch({ booking_start: '5pm', booking_end: '9am' })).toEqual({ error: 'booking_start must be before booking_end.' })
    expect(parseProfilePatch({ time_zone: 'Mars/Olympus' })).toMatchObject({ error: expect.stringContaining('IANA') })
    expect(parseProfilePatch({ booking_slug: 'a b' })).toMatchObject({ error: expect.stringContaining('booking_slug') })
    expect(readClock('12am')).toBe('00:00')
    expect(readClock('13pm')).toBeNull()
    expect(slugFromName('Bright Loom Cleaning Co.')).toBe('bright-loom-cleaning-co')
  })
})

describe("the business's number", () => {
  const config = { accountSid: 'AC1', authToken: 't', fromNumber: '+18885550100', messagingServiceSid: 'MG1' }
  const db = () => memoryDb({ business_phone_number: [] }, { business_phone_number: (a, b) => a.state === 'active' && b.state === 'active' && (a.phone_e164 === b.phone_e164 || a.workspace_id === b.workspace_id) })

  it("buys a local number in the area code and points its SMS webhook at Native Intelligence's, never into Native Intelligence's messaging service", async () => {
    const calls: Array<{ url: string; body: string | null }> = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: typeof init.body === 'string' ? init.body : null })
      if (url.includes('AvailablePhoneNumbers')) return Response.json({ available_phone_numbers: [{ phone_number: '+19295550123' }] })
      if (url.endsWith('IncomingPhoneNumbers.json')) return Response.json({ sid: 'PN9' }, { status: 201 })
      return Response.json({}, { status: 200 })
    })
    const supabase = db()
    const out = await buyBusinessNumber(supabase, { workspaceId: 'ws-rug', ownerUserId: 'user-owner', areaCode: '929', businessName: 'Bright Loom' }, { fetch: fetch as never, config, webhookUrl: 'https://dial8.ai/api/twilio/sms' })
    expect(out).toMatchObject({ ok: true, number: { phone: '+19295550123', twilioSid: 'PN9', workspaceId: 'ws-rug' } })
    expect(calls[0].url).toContain('AvailablePhoneNumbers/US/Local.json?AreaCode=929&SmsEnabled=true')
    expect(new URLSearchParams(calls[1].body!).get('SmsUrl')).toBe('https://dial8.ai/api/twilio/sms')
    // Never in Native Intelligence's sender pool: Twilio could pick it for a Native Intelligence text.
    expect(calls.some((c) => c.url.includes('messaging.twilio.com'))).toBe(false)
    expect((await findBusinessNumber(supabase, '+19295550123'))?.workspaceId).toBe('ws-rug')
    // One per business.
    expect(await buyBusinessNumber(supabase, { workspaceId: 'ws-rug', ownerUserId: 'user-owner', areaCode: '929', businessName: 'R' }, { fetch: fetch as never, config })).toEqual({ ok: false, reason: 'has_number' })
  })

  it('attaches a number already in the account; refuses the Native Intelligence number itself and one not in the account', async () => {
    const fetch = vi.fn(async (url: string) => (url.includes('PhoneNumber=%2B16465550173') ? Response.json({ incoming_phone_numbers: [{ sid: 'PN1' }] }) : url.includes('IncomingPhoneNumbers.json?') ? Response.json({ incoming_phone_numbers: [] }) : Response.json({})))
    const supabase = db()
    expect(await attachBusinessNumber(supabase, { workspaceId: 'ws-rug', ownerUserId: 'u', phone: '(646) 555-0173' }, { fetch: fetch as never, config })).toMatchObject({ ok: true, number: { phone: '+16465550173' } })
    expect(await attachBusinessNumber(db(), { workspaceId: 'ws-2', ownerUserId: 'u', phone: '+18885550100' }, { fetch: fetch as never, config })).toMatchObject({ ok: false, reason: 'bad_input' })
    expect(await attachBusinessNumber(db(), { workspaceId: 'ws-2', ownerUserId: 'u', phone: '+12125550000' }, { fetch: fetch as never, config })).toEqual({ ok: false, reason: 'not_in_account' })
  })

  it('a number bought but not recorded (a double submit lost the race) is given back to Twilio', async () => {
    const calls: Array<{ url: string; method: string }> = []
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, method: String(init.method) })
      if (url.includes('AvailablePhoneNumbers')) return Response.json({ available_phone_numbers: [{ phone_number: '+19295550124' }] })
      if (url.endsWith('IncomingPhoneNumbers.json')) return Response.json({ sid: 'PN10' }, { status: 201 })
      return Response.json({}, { status: 200 })
    })
    // The other submit recorded its number between this one's check and its insert.
    const supabase = memoryDb(
      { business_phone_number: [{ id: 'bn-raced', workspace_id: 'ws-rug-2', phone_e164: '+19295550124', state: 'active' }] },
      { business_phone_number: (a, b) => a.state === 'active' && b.state === 'active' && a.phone_e164 === b.phone_e164 },
    )
    const out = await buyBusinessNumber(supabase, { workspaceId: 'ws-rug', ownerUserId: 'u', areaCode: '929', businessName: 'R' }, { fetch: fetch as never, config })
    expect(out).toEqual({ ok: false, reason: 'taken' })
    expect(calls.at(-1)).toEqual({ url: expect.stringContaining('IncomingPhoneNumbers/PN10.json'), method: 'DELETE' })
  })

  it('with no Twilio set up, nothing is bought', async () => {
    expect(await buyBusinessNumber(db(), { workspaceId: 'w', ownerUserId: 'u', areaCode: '929', businessName: 'R' }, { config: null })).toEqual({ ok: false, reason: 'not_configured' })
    expect(await findBusinessNumber(db(), 'not a number')).toBeNull()
  })
})
