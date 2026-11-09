/**
 * The owner's agent's front-door tools (roadmap B, ../business.ts): what
 * customers are told and the website form's link change only for an owner
 * of the workspace; any member reads; a non-member gets nothing. The owner's
 * answer to a quote (send_quote, book_quote, roadmap F3) runs only as the
 * replay of their own card (src/lib/customers/__tests__/quote-reply.test.ts
 * covers what it sends). The owner's own move or cancel of a booking runs in
 * their turn, never an unattended run's
 * (src/lib/customers/__tests__/booking-changes.test.ts covers the rest).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, unknown>>>, sms: [] as unknown[][] }))
vi.mock('@/lib/admin', async () => {
  const { memoryDb } = await import('@/test/memory-db')
  return { getServiceClient: () => memoryDb(db.tables) }
})
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: vi.fn() }))
vi.mock('@/lib/integrations/calendar', () => ({
  getCalendarProvider: vi.fn(async () => null),
  createCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(async () => ({})),
  deleteCalendarEvent: vi.fn(async () => {}),
  listCalendarEventsUnified: vi.fn(async () => []),
}))
vi.mock('@/lib/crm/email-client', () => ({ sendEmail: vi.fn() }))
vi.mock('@/lib/twilio/client', () => ({ sendSms: vi.fn(async (...args: unknown[]) => (db.sms.push(args), { ok: true, sid: 'SM1' })) }))

import { createBusinessTools } from '../business'
import { quoteReplyHold } from '@/lib/customers/quote-reply'
import { getServiceClient } from '@/lib/admin'

const WS = 'ws-rug'
type Exec = { execute: (input: unknown, ctx: unknown) => Promise<Record<string, unknown>> }
const run = (userId: string, name: string, input: unknown = {}) =>
  (createBusinessTools(userId, {} as never, WS) as unknown as Record<string, Exec>)[name].execute(input, { toolCallId: 't', messages: [] })

beforeEach(() => {
  db.tables = {
    member: [
      { id: 'm-owner', workspace_id: WS, user_id: 'user-owner', role: 'owner' },
      { id: 'm-sam', workspace_id: WS, user_id: 'user-sam', role: 'member' },
    ],
    business_profile: [],
    quote_intake_key: [],
    business_phone_number: [],
    customer_quote: [],
  }
  db.sms = []
})

describe('owner-only changes', () => {
  it('a member who is not an owner can neither rewrite what customers are told nor rotate the form link', async () => {
    expect(await run('user-sam', 'update_business_profile', { business_name: 'Sam Co', customer_facts: 'Everything is free' })).toMatchObject({ success: false, error: expect.stringContaining('Only an owner') })
    expect(await run('user-sam', 'create_quote_form_link', {})).toMatchObject({ success: false })
    expect(db.tables.business_profile).toHaveLength(0)
    expect(db.tables.quote_intake_key).toHaveLength(0)
  })

  it('the owner can, and the first write makes them the business’s owner', async () => {
    const out = await run('user-owner', 'update_business_profile', { business_name: 'Bright Weave', customer_facts: 'Cleaning $5 per sq ft', booking_days: ['mon', 'tue'], make_booking_link: true })
    expect(out).toMatchObject({ success: true, profile: { businessName: 'Bright Weave', ownerUserId: 'user-owner', bookingDays: [1, 2], bookingSlug: 'bright-weave' } })
    expect(String(out.booking_link)).toMatch(/\/book\/bright-weave$/)
    const link = await run('user-owner', 'create_quote_form_link', { allowed_origins: ['https://brightweave.com'] })
    expect(String(link.url)).toMatch(/\/api\/intake\/quotes\/qk_[A-Za-z0-9_-]{43}$/)
    expect(db.tables.quote_intake_key).toHaveLength(1)
    expect(db.tables.quote_intake_key[0].key_hash).not.toContain(String(link.url).split('/').pop())
  })

  it('any member reads; a non-member gets nothing', async () => {
    expect(await run('user-sam', 'get_business_profile')).toMatchObject({ success: true, profile: null, quote_form: { connected: false } })
    expect(await run('user-stranger', 'list_quotes')).toEqual({ success: false, error: 'Not a workspace member' })
  })
})

describe("the owner's answer to a quote (roadmap F3)", () => {
  const QUOTE = '33333333-3333-4333-8333-333333333333'
  const seed = () => {
    db.tables.business_profile = [{ workspace_id: WS, owner_user_id: 'user-owner', business_name: 'Northside Tutoring', customer_facts: null, time_zone: 'America/Denver', booking_days: [1, 2, 3, 4, 5], booking_start: '15:00', booking_end: '19:00', slot_minutes: 60, lead_hours: 12, horizon_days: 14, booking_kind: 'session', booking_slug: null }]
    db.tables.business_phone_number = [{ id: 'bn-1', workspace_id: WS, owner_user_id: 'user-owner', phone_e164: '+17205550100', twilio_sid: 'PN1', state: 'active' }]
    db.tables.customer_quote = [{ id: QUOTE, workspace_id: WS, contact_id: null, source: 'web_form', status: 'new', customer_name: 'Lee Park', customer_email: null, customer_phone: '+17205550177', address: null, service: 'Algebra', items: [], total_cents: null, currency: 'usd', requested_dates: [], notes: null, created_at: '2026-11-01T15:00:00Z', updated_at: '2026-11-01T15:00:00Z' }]
    db.tables.sms_message = []
  }

  it('never runs in the turn: unapproved it refuses and nothing reaches the customer; a plain member is refused outright', async () => {
    seed()
    expect(await run('user-owner', 'send_quote', { quote_id: QUOTE, price: 80 })).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    // A week ahead of today, so the time is never in the past (that refusal comes first).
    const nextWeek = `${new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)}T16:00`
    expect(await run('user-owner', 'book_quote', { quote_id: QUOTE, start: nextWeek })).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(await run('user-sam', 'send_quote', { quote_id: QUOTE, price: 80 })).toMatchObject({ success: false, code: 'NOT_ALLOWED' })
    expect(db.sms).toHaveLength(0)
    expect(db.tables.customer_quote[0]).toMatchObject({ status: 'new', total_cents: null })
  })

  it("runs as the replay of the owner's own card (approvedCall), from the business's number", async () => {
    seed()
    const input = { quote_id: QUOTE, price: 80 }
    const hold = await quoteReplyHold(getServiceClient(), { workspaceId: WS, userId: 'user-owner', toolName: 'send_quote', input })
    const tools = createBusinessTools('user-owner', {} as never, WS, { approvedCall: { approvalId: 'appr-1', tool: 'send_quote', quoteReply: hold!.context.quoteReply } }) as unknown as Record<string, Exec>
    expect(await tools.send_quote.execute(input, { toolCallId: 't', messages: [] })).toMatchObject({ success: true, sent_via: 'text' })
    expect(db.sms).toEqual([['+17205550177', expect.stringContaining('Northside Tutoring: here is your quote for algebra: $80. Reply here to pick a time.'), { from: '+17205550100' }]])
    expect(db.tables.customer_quote[0]).toMatchObject({ status: 'sent', total_cents: 8000 })
  })
})

describe("the owner's own move or cancel of a booking (issue #11's follow-up)", () => {
  const BOOKING = '44444444-4444-4444-8444-444444444444'
  const seed = () => {
    db.tables.business_profile = [{ workspace_id: WS, owner_user_id: 'user-owner', business_name: 'Northside Tutoring', customer_facts: null, time_zone: 'America/Denver', booking_days: [1, 2, 3, 4, 5], booking_start: '15:00', booking_end: '19:00', slot_minutes: 60, lead_hours: 12, horizon_days: 14, booking_kind: 'session', booking_slug: null, reminders: true }]
    db.tables.business_phone_number = [{ id: 'bn-1', workspace_id: WS, owner_user_id: 'user-owner', phone_e164: '+17205550100', twilio_sid: 'PN1', state: 'active' }]
    // Far ahead, so it is never in the past: Tue, Jan 8, 2030, 4:00 PM in Denver.
    db.tables.customer_booking = [
      {
        id: BOOKING, workspace_id: WS, owner_user_id: 'user-owner', quote_id: null, contact_id: null, guest_id: null, source: 'sms', kind: 'session',
        starts_at: '2030-01-08T23:00:00.000Z', ends_at: '2030-01-09T00:00:00.000Z', customer_name: 'Lee Park', customer_phone: '+17205550177',
        address: null, note: null, state: 'confirmed', approval_id: null, calendar_event_id: null, customer_confirmed_at: null, created_at: '2026-11-01T12:00:00Z',
      },
    ]
    db.tables.customer_reminder = []
    db.tables.sms_message = []
  }

  it("runs in the owner's own turn, and the customer is texted from the business's number", async () => {
    seed()
    expect(await run('user-owner', 'move_booking', { booking_id: BOOKING, start: '2030-01-09T16:00' })).toMatchObject({ success: true, status: 'moved', when: 'Wed, Jan 9, 4:00 PM' })
    expect(db.tables.customer_booking[0]).toMatchObject({ starts_at: '2030-01-09T23:00:00.000Z', ends_at: '2030-01-10T00:00:00.000Z' })
    expect(await run('user-owner', 'cancel_booking', { booking_id: BOOKING })).toMatchObject({ success: true, status: 'cancelled' })
    expect(db.tables.customer_booking[0].state).toBe('cancelled')
    expect(db.sms).toEqual([
      ['+17205550177', expect.stringContaining("Northside Tutoring: your session has moved to Wed, Jan 9, 4:00 PM. Reply here if that time doesn't work."), { from: '+17205550100' }],
      ['+17205550177', expect.stringContaining("Northside Tutoring: your session on Wed, Jan 9, 4:00 PM is cancelled. Reply here if you'd like another time."), { from: '+17205550100' }],
    ])
  })

  it('never in an unattended run, never for a plain member, and the start is a local time', async () => {
    seed()
    const unattended = createBusinessTools('user-owner', {} as never, WS, { unattended: true }) as unknown as Record<string, Exec & { inputSchema: { safeParse: (v: unknown) => { success: boolean } } }>
    expect(await unattended.move_booking.execute({ booking_id: BOOKING, start: '2030-01-09T16:00' }, { toolCallId: 't', messages: [] })).toMatchObject({ success: false, code: 'NEEDS_PERSON' })
    expect(await unattended.cancel_booking.execute({ booking_id: BOOKING }, { toolCallId: 't', messages: [] })).toMatchObject({ success: false, code: 'NEEDS_PERSON' })
    expect(await run('user-sam', 'move_booking', { booking_id: BOOKING, start: '2030-01-09T16:00' })).toMatchObject({ success: false, code: 'NOT_ALLOWED' })
    expect(await run('user-sam', 'cancel_booking', { booking_id: BOOKING })).toMatchObject({ success: false, code: 'NOT_ALLOWED' })
    expect(db.tables.customer_booking[0]).toMatchObject({ state: 'confirmed', starts_at: '2030-01-08T23:00:00.000Z' })
    expect(db.sms).toHaveLength(0)
    expect(unattended.move_booking.inputSchema.safeParse({ booking_id: BOOKING, start: '2030-01-09T16:00' }).success).toBe(true)
    expect(unattended.move_booking.inputSchema.safeParse({ booking_id: BOOKING, start: '2030-01-09T23:00:00Z' }).success).toBe(false)
    expect(unattended.cancel_booking.inputSchema.safeParse({ booking_id: 'not-a-booking' }).success).toBe(false)
  })
})
