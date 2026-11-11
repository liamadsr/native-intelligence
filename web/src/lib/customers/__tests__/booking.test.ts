/**
 * Booking on the owner's yes (roadmap B4, ../booking.ts): a request holds an
 * open slot and asks the owner on one approval card (tool confirm_booking,
 * external-write, its context naming the booking); the yes puts it on the
 * calendar, confirms it, marks the quote booked and texts the customer from
 * the business's number; a no or no answer frees the slot and tells them.
 * Over the real booking store on an in-memory database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: vi.fn() }))

import type { SupabaseClient } from '@supabase/supabase-js'
import { bookingDb, customerRows, seedBookings } from '@/test/booking-db'
import { CONFIRM_BOOKING_TOOL, bookingApprovalPermits, bookingCard, bookingConfirmedText, bookingDeclinedText, confirmBooking, requestBooking, settleBookingApproval, textBookingCustomer, type BookingDeps } from '../booking'
import { countLiveRequests, insertBooking } from '../store'
import type { NewApproval } from '@/lib/safety/approvals'
import { BOOKING_REQUEST_TTL_MS } from '../types'

const WS = 'ws-rug'
const OWNER = 'user-owner'
const NY = 'America/New_York'
const SLOT = { start: '2026-11-02T15:00:00.000Z', end: '2026-11-02T16:00:00.000Z' }
const SARAH = '+12125550199'
const RUG = '+16465550173'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient

beforeEach(() => {
  tables = {
    business_profile: [{ workspace_id: WS, owner_user_id: OWNER, business_name: 'Bright Loom', customer_facts: null, time_zone: NY, booking_days: [1, 2, 3, 4, 5], booking_start: '09:00', booking_end: '17:00', slot_minutes: 60, lead_hours: 24, horizon_days: 14, booking_kind: 'pickup', booking_slug: 'bright-loom' }],
    business_phone_number: [{ id: 'bn-1', workspace_id: WS, owner_user_id: OWNER, phone_e164: RUG, twilio_sid: 'PN1', state: 'active' }],
    customer_quote: [{ id: '11111111-1111-4111-8111-111111111111', workspace_id: WS, contact_id: 'c-1', source: 'web_form', status: 'new', customer_name: 'Sarah Lee', customer_phone: SARAH, items: [{ description: 'Rug', width: 8, length: 10, unit: 'ft' }], total_cents: 40_000, currency: 'usd', requested_dates: [], created_at: '2026-10-30T12:00:00Z', updated_at: '2026-10-30T12:00:00Z' }],
    agent_guest: [{ id: 'g-sarah', owner_user_id: OWNER, workspace_id: WS, state: 'active', preset: 'customer' }],
    sms_message: [],
  }
  db = bookingDb(tables)
})

const QUOTE_ID = '11111111-1111-4111-8111-111111111111'
const NOW = Date.parse('2026-10-30T13:00:00Z')
const GUEST = { id: 'g-sarah', displayName: 'Sarah Lee', contactId: 'c-1', phone: SARAH }

function bookingDeps(over: Partial<BookingDeps> = {}) {
  const approvals: NewApproval[] = []
  const d: BookingDeps = {
    openSlotAt: vi.fn(async (_s, _b, start: string) => ({ slot: start === SLOT.start ? SLOT : null, timeZone: NY, rules: { bookingKind: 'pickup' } as never })),
    insertBooking: (booking) => insertBooking(db, booking),
    createApproval: vi.fn(async (approval) => (approvals.push(approval), { ok: true as const, approvalId: `appr-${approvals.length}`, cardId: 'card-1' })),
    canBook: async () => true,
    countLiveRequests: (workspaceId, sinceIso, who) => countLiveRequests(db, workspaceId, sinceIso, who),
    now: () => NOW,
    ...over,
  }
  return { d, approvals }
}

const ask = (over: Record<string, unknown> = {}) => ({ start: SLOT.start, name: 'Sarah Lee', address: '12 Elm St, Brooklyn', quoteId: QUOTE_ID, ...over })

describe('a request', () => {
  it("holds the slot and asks the owner once: confirm_booking, external-write, the card saying who, when, where and the price", async () => {
    const { d, approvals } = bookingDeps()
    const result = await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask() }, d)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.label).toBe('Mon, Nov 2, 10:00 AM')
    expect(customerRows(tables)).toHaveLength(1)
    expect(customerRows(tables)[0]).toMatchObject({ state: 'requested', starts_at: SLOT.start, ends_at: SLOT.end, customer_name: 'Sarah Lee', customer_phone: SARAH, guest_id: 'g-sarah', quote_id: QUOTE_ID, contact_id: 'c-1', source: 'sms', kind: 'pickup', approval_id: 'appr-1' })
    // Created after the clock the test runs at: a fresh request, not a lapsed one.
    expect(Date.parse(customerRows(tables)[0].created_at as string)).toBeGreaterThan(NOW - BOOKING_REQUEST_TTL_MS)

    expect(approvals).toHaveLength(1)
    const [approval] = approvals
    expect(approval).toMatchObject({ door: 'chat', userId: OWNER, workspaceId: WS, toolName: CONFIRM_BOOKING_TOOL, sideEffect: 'external-write', conversationId: null, reason: 'customer_booking' })
    expect(approval.context).toEqual({ booking: { bookingId: result.booking.id }, tools: { origin: { actor: 'agent', depth: 1 } }, guest: { guestId: 'g-sarah', name: 'Sarah Lee' } })
    expect(approval.input).toMatchObject({ booking_id: result.booking.id, when: 'Mon, Nov 2, 10:00 AM', customer: 'Sarah Lee', phone: SARAH, address: '12 Elm St, Brooklyn', quote: '1 item (8x10 ft), $400' })
    expect(approval.card.title).toBe('Pickup for Sarah Lee, Mon, Nov 2, 10:00 AM, 12 Elm St, Brooklyn, $400')
    expect(approval.card.why).toContain('picked this time by text')
  })

  it("a slot that isn't open, or that someone just took, is SLOT_TAKEN and asks no one", async () => {
    const { d, approvals } = bookingDeps()
    const closed = await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask({ start: '2026-11-02T03:00:00.000Z' }) }, d)
    expect(closed).toMatchObject({ ok: false, code: 'SLOT_TAKEN' })
    await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask() }, d)
    const raced = await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'link', input: ask({ name: 'Bob', phone: '+12125550111', quoteId: null }) }, d)
    expect(raced).toMatchObject({ ok: false, code: 'SLOT_TAKEN' })
    expect(approvals).toHaveLength(1)
  })

  it("only the customer's own quote is attached; someone else's id is ignored", async () => {
    tables.customer_quote.push({ ...tables.customer_quote[0], id: '22222222-2222-4222-8222-222222222222', contact_id: 'c-bob', customer_phone: '+12125550111' })
    const { d, approvals } = bookingDeps()
    const result = await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask({ quoteId: '22222222-2222-4222-8222-222222222222' }) }, d)
    expect(result.ok && result.booking.quoteId).toBeNull()
    expect((approvals[0].input as Record<string, unknown>).quote).toBeUndefined()
  })

  it('a stale request (its approval lapsed) leaves the slot first', async () => {
    seedBookings(tables, [{ id: 'b-old', workspace_id: WS, owner_user_id: OWNER, state: 'requested', starts_at: SLOT.start, ends_at: SLOT.end, customer_name: 'Old', created_at: new Date(NOW - BOOKING_REQUEST_TTL_MS - 1000).toISOString() }])
    const { d } = bookingDeps()
    expect((await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask() }, d)).ok).toBe(true)
    expect(customerRows(tables).find((b) => b.id === 'b-old')?.state).toBe('expired')
  })

  it('no approval, no hold: the booking is cancelled and the customer told to try later', async () => {
    const { d } = bookingDeps({ createApproval: async () => ({ ok: false, code: 'TOO_MANY_PENDING', error: 'x' }) })
    expect(await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask() }, d)).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING' })
    expect(customerRows(tables)[0].state).toBe('cancelled')
  })

  it('a calendar that can’t be read holds nothing', async () => {
    const { d } = bookingDeps({ openSlotAt: async () => { throw new Error('token expired') } })
    expect(await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask() }, d)).toMatchObject({ ok: false, code: 'CALENDAR_UNAVAILABLE' })
    expect(customerRows(tables)).toHaveLength(0)
  })

  it("nothing is held when the owner has no calendar a yes could write to", async () => {
    const { d, approvals } = bookingDeps({ canBook: async () => false })
    expect(await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask() }, d)).toMatchObject({ ok: false, code: 'CALENDAR_UNAVAILABLE' })
    expect(customerRows(tables)).toHaveLength(0)
    expect(approvals).toHaveLength(0)
  })

  it('one customer can hold only so many requests at once; the page, one', async () => {
    const SLOTS = ['2026-11-02T15:00:00.000Z', '2026-11-02T16:00:00.000Z', '2026-11-02T17:00:00.000Z']
    const d = bookingDeps({ openSlotAt: async (_s, _b, start: string) => ({ slot: { start, end: new Date(Date.parse(start) + 3600_000).toISOString() }, timeZone: NY, rules: { bookingKind: 'pickup' } as never }) }).d
    const byText = (start: string) => requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask({ start, quoteId: null }) }, d)
    expect((await byText(SLOTS[0])).ok).toBe(true)
    expect((await byText(SLOTS[1])).ok).toBe(true)
    expect(await byText(SLOTS[2])).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING' })
    const page = (start: string) => requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'link', input: { start, name: 'Bob', phone: '+12125550111' } }, d)
    expect((await page('2026-11-03T15:00:00.000Z')).ok).toBe(true)
    expect(await page('2026-11-03T16:00:00.000Z')).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING' })
  })

  it('the business as a whole can have only so many requests waiting on the owner', async () => {
    for (let i = 0; i < 10; i++) seedBookings(tables, [{ id: `b-${i}`, workspace_id: WS, state: 'requested', starts_at: `2026-11-1${i % 9}T15:00:00.000Z`, created_at: new Date(NOW).toISOString(), customer_phone: `+1212555020${i}` }])
    const { d } = bookingDeps()
    expect(await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask() }, d)).toMatchObject({ ok: false, code: 'TOO_MANY_PENDING' })
  })

  it('needs a name', async () => {
    const { d } = bookingDeps()
    expect(await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask({ name: '  ' }) }, d)).toMatchObject({ ok: false, code: 'BAD_INPUT' })
  })
})

async function held(): Promise<string> {
  const { d } = bookingDeps()
  const result = await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'sms', guest: GUEST, input: ask() }, d)
  if (!result.ok) throw new Error('not held')
  return result.booking.id
}

describe("the owner's yes", () => {
  it('puts it on the calendar, confirms it, marks the quote booked and texts the customer from the business number', async () => {
    const bookingId = await held()
    const createEvent = vi.fn(async () => ({ id: 'evt-1' }) as never)
    const sent: Array<{ to: string; body: string; from?: string | null }> = []
    const send = vi.fn(async (to: string, body: string, deps?: { from?: string | null }) => (sent.push({ to, body, from: deps?.from }), { ok: true as const, sid: 'SMx' }))
    const out = await confirmBooking(db, { userId: OWNER, workspaceId: WS, bookingId }, {
      createEvent,
      hasCalendar: async () => true,
      isSlotFree: async () => true,
      textCustomer: (b, body) => textBookingCustomer(db, b, body, { send }),
    })
    expect(out).toMatchObject({ success: true, booking_id: bookingId, when: 'Mon, Nov 2, 10:00 AM', calendar_event_id: 'evt-1', customer_texted: true })
    expect(createEvent).toHaveBeenCalledWith(OWNER, expect.objectContaining({ title: 'Pickup: Sarah Lee', start: SLOT.start, end: SLOT.end, location: '12 Elm St, Brooklyn' }))
    expect(customerRows(tables)[0]).toMatchObject({ state: 'confirmed', calendar_event_id: 'evt-1' })
    expect(tables.customer_quote[0].status).toBe('booked')
    expect(sent).toEqual([{ to: SARAH, body: bookingConfirmedText('Bright Loom', { kind: 'pickup', address: '12 Elm St, Brooklyn' }, 'Mon, Nov 2, 10:00 AM'), from: RUG }])
    // Runs once: a second yes changes nothing.
    expect(await confirmBooking(db, { userId: OWNER, workspaceId: WS, bookingId }, { createEvent, hasCalendar: async () => true, isSlotFree: async () => true, textCustomer: async () => true })).toMatchObject({ success: false })
    expect(createEvent).toHaveBeenCalledTimes(1)
  })

  it('a slot filled since is declined, nothing goes on the calendar, and the customer is asked to pick again', async () => {
    const bookingId = await held()
    const createEvent = vi.fn()
    const texts: string[] = []
    const out = await confirmBooking(db, { userId: OWNER, workspaceId: WS, bookingId }, { createEvent, hasCalendar: async () => true, isSlotFree: async () => false, textCustomer: async (_b, body) => (texts.push(body), true) })
    expect(out).toMatchObject({ success: false, code: 'SLOT_TAKEN' })
    expect(createEvent).not.toHaveBeenCalled()
    expect(customerRows(tables)[0].state).toBe('declined')
    expect(texts).toEqual([bookingDeclinedText('Bright Loom', { kind: 'pickup' }, 'Mon, Nov 2, 10:00 AM')])
  })

  it('no calendar connected by then: nothing booked, the slot released, the customer told', async () => {
    const bookingId = await held()
    const texts: string[] = []
    expect(await confirmBooking(db, { userId: OWNER, workspaceId: WS, bookingId }, { hasCalendar: async () => false, timeZone: async () => NY, textCustomer: async (_b, body) => (texts.push(body), true) })).toMatchObject({ success: false, code: 'NO_CALENDAR' })
    expect(customerRows(tables)[0].state).toBe('cancelled')
    expect(texts).toHaveLength(1)
  })

  it('a calendar that refuses the event: nothing booked, the slot released, the customer told', async () => {
    const bookingId = await held()
    const texts: string[] = []
    const out = await confirmBooking(db, { userId: OWNER, workspaceId: WS, bookingId }, {
      hasCalendar: async () => true,
      isSlotFree: async () => true,
      timeZone: async () => NY,
      createEvent: async () => {
        throw new Error('403 insufficient permissions')
      },
      textCustomer: async (_b, body) => (texts.push(body), true),
    })
    expect(out).toMatchObject({ success: false, code: 'CALENDAR_FAILED' })
    expect(customerRows(tables)[0].state).toBe('cancelled')
    expect(texts[0]).toContain("we can't do the pickup")
  })

  it("an owner's own booking (book_quote) that can't be booked is released without a \"we can't\" text: its card never promised one", async () => {
    const owned = await insertBooking(db, { workspaceId: WS, ownerUserId: OWNER, source: 'owner', kind: 'pickup', startsAt: SLOT.start, endsAt: SLOT.end, customerName: 'Sarah Lee', customerPhone: SARAH })
    if (!owned.ok) throw new Error('not held')
    const texts: string[] = []
    const textCustomer = async (_b: unknown, body: string) => (texts.push(body), true)
    const noCalendar = await confirmBooking(db, { userId: OWNER, workspaceId: WS, bookingId: owned.booking.id }, { hasCalendar: async () => false, timeZone: async () => NY, textCustomer })
    expect(noCalendar).toMatchObject({ success: false, code: 'NO_CALENDAR', error: expect.stringContaining('Sarah Lee was not told.') })
    expect(customerRows(tables)[0].state).toBe('cancelled')
    const again = await insertBooking(db, { workspaceId: WS, ownerUserId: OWNER, source: 'owner', kind: 'pickup', startsAt: SLOT.start, endsAt: SLOT.end, customerName: 'Sarah Lee', customerPhone: SARAH })
    if (!again.ok) throw new Error('not held')
    expect(await confirmBooking(db, { userId: OWNER, workspaceId: WS, bookingId: again.booking.id }, { hasCalendar: async () => true, isSlotFree: async () => false, timeZone: async () => NY, textCustomer })).toMatchObject({ code: 'SLOT_TAKEN' })
    expect(customerRows(tables)[1].state).toBe('declined')
    expect(texts).toEqual([])
  })

  it("someone else's booking, or another workspace's, never runs", async () => {
    const bookingId = await held()
    expect(await confirmBooking(db, { userId: 'user-intruder', workspaceId: WS, bookingId }, { hasCalendar: async () => true })).toMatchObject({ success: false })
    expect(await confirmBooking(db, { userId: OWNER, workspaceId: 'ws-other', bookingId }, { hasCalendar: async () => true })).toMatchObject({ success: false })
  })
})

describe("the owner's no, or no answer", () => {
  it('frees the slot and tells the customer, once', async () => {
    const bookingId = await held()
    const texts: string[] = []
    const textCustomer = async (_b: unknown, body: string) => (texts.push(body), true)
    await settleBookingApproval(db, { workspace_id: WS, context: { booking: { bookingId } } }, 'denied', { textCustomer })
    await settleBookingApproval(db, { workspace_id: WS, context: { booking: { bookingId } } }, 'denied', { textCustomer })
    expect(customerRows(tables)[0].state).toBe('declined')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toContain("we can't do the pickup at Mon, Nov 2, 10:00 AM")
  })

  it("a booking-page number is never texted on a no or a lapse (only after the owner's yes)", async () => {
    const { d } = bookingDeps()
    const made = await requestBooking(db, { business: { workspaceId: WS, ownerUserId: OWNER }, source: 'link', input: { start: SLOT.start, name: 'Bob', phone: '+12125550111' } }, d)
    if (!made.ok) throw new Error('not held')
    const textCustomer = vi.fn(async () => true)
    await settleBookingApproval(db, { workspace_id: WS, context: { booking: { bookingId: made.booking.id } } }, 'denied', { textCustomer })
    expect(customerRows(tables)[0].state).toBe('declined')
    expect(textCustomer).not.toHaveBeenCalled()
  })

  it('a lapsed approval expires the booking', async () => {
    const bookingId = await held()
    await settleBookingApproval(db, { workspace_id: WS, context: { booking: { bookingId } } }, 'expired', { textCustomer: async () => true })
    expect(customerRows(tables)[0].state).toBe('expired')
  })

  it('an approval with no booking in it is left alone', async () => {
    await expect(settleBookingApproval(db, { workspace_id: WS, context: {} }, 'denied')).resolves.toBeUndefined()
  })
})

describe('the re-check at accept', () => {
  it('holds while the booking is still requested, the owner’s, and its texting customer still active', async () => {
    const bookingId = await held()
    const row = { workspace_id: WS, user_id: OWNER, tool: CONFIRM_BOOKING_TOOL, context: { booking: { bookingId }, guest: { guestId: 'g-sarah' } } }
    expect(await bookingApprovalPermits(db, row)).toBe(true)
    expect(await bookingApprovalPermits(db, { ...row, tool: 'create_calendar_event' })).toBe(false)
    expect(await bookingApprovalPermits(db, { ...row, user_id: 'user-intruder' })).toBe(false)
    tables.agent_guest[0].state = 'removed'
    expect(await bookingApprovalPermits(db, row)).toBe(false)
    tables.agent_guest[0].state = 'active'
    tables.meeting_booking[0].state = 'declined'
    expect(await bookingApprovalPermits(db, row)).toBe(false)
  })
})

describe('texting the customer', () => {
  it('never a number that said STOP, never outside the US and Canada, never without a business number', async () => {
    const send = vi.fn(async () => ({ ok: true as const, sid: 'SMx' }))
    const booking = { workspaceId: WS, customerPhone: SARAH, guestId: null }
    tables.sms_message.push({ direction: 'in', kind: 'stop', phone_e164: SARAH, created_at: '2026-10-30T00:00:00Z' })
    expect(await textBookingCustomer(db, booking, 'hi', { send })).toBe(false)
    expect(await textBookingCustomer(db, { ...booking, customerPhone: '+447700900123' }, 'hi', { send })).toBe(false)
    tables.sms_message.length = 0
    tables.business_phone_number[0].state = 'released'
    expect(await textBookingCustomer(db, booking, 'hi', { send })).toBe(false)
    expect(send).not.toHaveBeenCalled()
  })

  it('the card for a booking page names it', () => {
    expect(bookingCard({ kind: 'pickup', customerName: 'Bob', label: 'Tue, Nov 3, 9:00 AM', address: null, quote: null, source: 'link' })).toEqual({
      title: 'Pickup for Bob, Tue, Nov 3, 9:00 AM',
      why: 'Bob picked this time on your booking page. Yes puts it on your calendar and texts them a confirmation.',
    })
  })
})
