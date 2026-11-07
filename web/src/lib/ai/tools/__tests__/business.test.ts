/**
 * The owner's agent's front-door tools (roadmap B, ../business.ts): what
 * customers are told and the website form's link change only for an owner
 * of the workspace; any member reads; a non-member gets nothing. The owner's
 * answer to a quote (send_quote, book_quote, roadmap F3) runs only as the
 * replay of their own card (src/lib/customers/__tests__/quote-reply.test.ts
 * covers what it sends).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const db = vi.hoisted(() => ({ tables: {} as Record<string, Array<Record<string, unknown>>>, sms: [] as unknown[][] }))
vi.mock('@/lib/admin', async () => {
  const { memoryDb } = await import('@/test/memory-db')
  return { getServiceClient: () => memoryDb(db.tables) }
})
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: vi.fn() }))
vi.mock('@/lib/integrations/calendar', () => ({ getCalendarProvider: vi.fn(async () => null), createCalendarEvent: vi.fn(), listCalendarEventsUnified: vi.fn(async () => []) }))
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
