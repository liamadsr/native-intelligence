/**
 * The owner's answer to a quote (roadmap F3, ../quote-reply.ts), for any
 * service business: send_quote texts the customer the price and the booking
 * link from the business's own number (else emails it from the owner's
 * mailbox) and marks the quote sent; book_quote books the time the customer
 * chose through the same confirmBooking a customer's request gets, with no
 * second card. Both run only as the replay of the owner's card, whose words
 * pin what goes out. Owners and admins only. Over the real store on an
 * in-memory database; the business is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const mocks = vi.hoisted(() => ({
  createApproval: vi.fn(),
  sendEmail: vi.fn(async () => ({ id: 'msg-1' })),
}))
vi.mock('@/lib/safety/approvals', () => ({ createToolApproval: mocks.createApproval }))
vi.mock('@/lib/crm/email-client', () => ({ sendEmail: mocks.sendEmail }))
vi.mock('@/lib/integrations/calendar', () => ({
  getCalendarProvider: vi.fn(async () => 'google'),
  createCalendarEvent: vi.fn(),
  listCalendarEventsUnified: vi.fn(async () => []),
}))

import type { SupabaseClient } from '@supabase/supabase-js'
import { bookingDb, customerRows } from '@/test/booking-db'
import { bookingConfirmedText, textBookingCustomer } from '../booking'
import {
  bookQuoteCard,
  planBookQuote,
  quoteReplyCardHash,
  quoteReplyHold,
  runBookQuote,
  runSendQuote,
  type QuoteReplyDeps,
} from '../quote-reply'
import { localStartInstant } from '../slots'
import { BOOK_QUOTE_TOOL, LINKISH, QUOTE_CARD_TITLE_MAX, QUOTE_CARD_WHY_MAX, SEND_QUOTE_TOOL } from '../quote-reply-input'
import { CUSTOMER_TOOLS } from '../customer-tools-list'
import { GUEST_NEVER_TOOLS, GUEST_OFFERABLE_TOOLS } from '@/lib/guests/presets'
import type { ApprovedCall } from '@/lib/safety/approved-call'

const WS = 'ws-brightside'
const OWNER = 'user-owner'
const ADMIN = 'user-admin'
const MEMBER = 'user-member'
const CHICAGO = 'America/Chicago'
const BUSINESS_NUMBER = '+13125550100'
const DANA = '+13125550142'
const QUOTE = '22222222-2222-4222-8222-222222222222'
const NOW = Date.parse('2026-11-01T18:00:00Z')

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient
let send: ReturnType<typeof vi.fn>

beforeEach(() => {
  mocks.createApproval.mockReset()
  mocks.sendEmail.mockClear()
  send = vi.fn(async () => ({ ok: true as const, sid: `SM${send.mock.calls.length}` }))
  tables = {
    member: [
      { id: 'm-1', workspace_id: WS, user_id: OWNER, role: 'owner' },
      { id: 'm-2', workspace_id: WS, user_id: ADMIN, role: 'admin' },
      { id: 'm-3', workspace_id: WS, user_id: MEMBER, role: 'member' },
    ],
    workspace: [{ id: WS, name: 'Brightside HQ' }],
    business_profile: [{ workspace_id: WS, owner_user_id: OWNER, business_name: 'Brightside Window Washing', customer_facts: null, time_zone: CHICAGO, booking_days: [1, 2, 3, 4, 5], booking_start: '08:00', booking_end: '17:00', slot_minutes: 90, lead_hours: 12, horizon_days: 21, booking_kind: 'visit', booking_slug: 'brightside' }],
    business_phone_number: [{ id: 'bn-1', workspace_id: WS, owner_user_id: OWNER, phone_e164: BUSINESS_NUMBER, twilio_sid: 'PN1', state: 'active' }],
    customer_quote: [{ id: QUOTE, workspace_id: WS, contact_id: 'c-dana', source: 'web_form', status: 'new', customer_name: 'Dana Ruiz', customer_email: 'dana@example.com', customer_phone: DANA, address: '400 Lake St, Oak Park', service: 'Exterior windows', items: [{ description: 'Two-story house', quantity: 1 }], total_cents: null, currency: 'usd', requested_dates: [], notes: null, created_at: '2026-11-01T15:00:00Z', updated_at: '2026-11-01T15:00:00Z' }],
    sms_message: [],
  }
  db = bookingDb(tables)
})

const quote = () => tables.customer_quote[0]
const deps = (over: QuoteReplyDeps = {}): QuoteReplyDeps => ({ now: () => NOW, origin: 'https://nativeintelligence.dev', send: send as never, ...over })

/** The owner's yes to the card the gate would make for this call: the replay's approvedCall. */
async function approvedFor(tool: string, input: Record<string, unknown>, userId = OWNER, d: QuoteReplyDeps = deps()): Promise<ApprovedCall> {
  const hold = await quoteReplyHold(db, { workspaceId: WS, userId, toolName: tool, input }, d)
  if (!hold) throw new Error('no card')
  return { approvalId: 'appr-1', tool, quoteReply: hold.context.quoteReply }
}

describe('send_quote', () => {
  it('the card says exactly who gets what text, from the business number; its yes sends that text from that number, sets the price and marks the quote sent', async () => {
    const hold = await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input: { quote_id: QUOTE, price: 240 } }, deps())
    const text = 'Brightside Window Washing: here is your quote for 1 item, exterior windows: $240. Pick a time at https://nativeintelligence.dev/book/brightside or reply here.'
    expect(hold?.card).toEqual({
      title: 'Text Dana Ruiz (+1 312-555-0142) their quote, $240?',
      why: `From the business number +1 312-555-0100: “${text}” Then the quote is marked sent at $240. It runs once, exactly as shown, when you accept.`,
    })
    expect(hold?.context.quoteReply).toEqual({ kind: 'send', quote_id: QUOTE, card_hash: quoteReplyCardHash(hold!.card) })

    const out = await runSendQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: await approvedFor(SEND_QUOTE_TOOL, { quote_id: QUOTE, price: 240 }) }, { quote_id: QUOTE, price: 240 }, deps())
    expect(out).toMatchObject({ success: true, sent_via: 'text', to: DANA, price: '$240' })
    // From the business's own number, never the Native Intelligence one; the exact words the card showed.
    expect(send).toHaveBeenCalledWith(DANA, text, { from: BUSINESS_NUMBER })
    expect(quote()).toMatchObject({ status: 'sent', total_cents: 24_000 })
    expect(tables.sms_message).toEqual([expect.objectContaining({ direction: 'out', kind: 'notice', phone_e164: DANA })])
    expect(mocks.sendEmail).not.toHaveBeenCalled()
  })

  it('unapproved, nothing goes out and the quote is untouched', async () => {
    expect(await runSendQuote(db, { userId: OWNER, workspaceId: WS }, { quote_id: QUOTE, price: 240 }, deps())).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    // Another tool's approval is not this one's.
    const other = { approvalId: 'appr-9', tool: 'send_payment_link' }
    expect(await runSendQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: other }, { quote_id: QUOTE, price: 240 }, deps())).toMatchObject({ code: 'APPROVAL_REQUIRED' })
    expect(send).not.toHaveBeenCalled()
    expect(quote()).toMatchObject({ status: 'new', total_cents: null })
  })

  it("the card's words pin the replay: a price changed since the card sends nothing", async () => {
    quote().total_cents = 24_000
    const approvedCall = await approvedFor(SEND_QUOTE_TOOL, { quote_id: QUOTE })
    quote().total_cents = 31_000
    expect(await runSendQuote(db, { userId: OWNER, workspaceId: WS, approvedCall }, { quote_id: QUOTE }, deps())).toMatchObject({ success: false, code: 'CARD_CHANGED' })
    // Nor does an approval with no words to check against.
    expect(await runSendQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: { approvalId: 'a', tool: SEND_QUOTE_TOOL } }, { quote_id: QUOTE }, deps())).toMatchObject({ code: 'CARD_CHANGED' })
    expect(send).not.toHaveBeenCalled()
    expect(quote().status).toBe('new')
  })

  it('without a booking link the customer is asked to reply to pick a time', async () => {
    tables.business_profile[0].booking_slug = null
    quote().total_cents = 18_050
    const hold = await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input: { quote_id: QUOTE, message: 'We can come this week.' } }, deps())
    expect(hold?.card.why).toContain('“Brightside Window Washing: here is your quote for 1 item, exterior windows: $180.50. We can come this week. Reply here to pick a time.”')
    expect(hold?.card.why).toContain('Then the quote is marked sent. It runs once')
  })

  it('with no business number it emails from the owner’s own mailbox (never a Native Intelligence number)', async () => {
    tables.business_phone_number[0].state = 'released'
    const input = { quote_id: QUOTE, price: '240' }
    const hold = await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input }, deps())
    expect(hold?.card).toEqual({
      title: 'Email Dana Ruiz (dana@example.com) their quote, $240?',
      why: 'From your mailbox, subject “Your quote, $240”: “Hi Dana, Brightside Window Washing: here is your quote for 1 item, exterior windows: $240. Pick a time at https://nativeintelligence.dev/book/brightside or reply to this email.” Then the quote is marked sent at $240. It runs once, exactly as shown, when you accept.',
    })
    const out = await runSendQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: await approvedFor(SEND_QUOTE_TOOL, input) }, input, deps())
    expect(out).toMatchObject({ success: true, sent_via: 'email', to: 'dana@example.com' })
    expect(mocks.sendEmail).toHaveBeenCalledWith(OWNER, WS, expect.objectContaining({
      to: ['dana@example.com'],
      subject: 'Your quote, $240',
      body_text: 'Hi Dana,\n\nBrightside Window Washing: here is your quote for 1 item, exterior windows: $240. Pick a time at https://nativeintelligence.dev/book/brightside or reply to this email.',
      body_html: expect.stringContaining('<a href="https://nativeintelligence.dev/book/brightside">https://nativeintelligence.dev/book/brightside</a>'),
    }))
    expect(send).not.toHaveBeenCalled()
    expect(quote().status).toBe('sent')
  })

  it('a number that said STOP, or one outside the US and Canada, is emailed instead; with no email nothing is held', async () => {
    tables.sms_message.push({ direction: 'in', kind: 'stop', phone_e164: DANA, created_at: '2026-10-01T00:00:00Z' })
    expect((await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input: { quote_id: QUOTE, price: 240 } }, deps()))?.card.title).toBe('Email Dana Ruiz (dana@example.com) their quote, $240?')
    tables.sms_message = []
    db = bookingDb(tables)
    quote().customer_phone = '+447700900123'
    expect((await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input: { quote_id: QUOTE, price: 240 } }, deps()))?.card.title).toBe('Email Dana Ruiz (dana@example.com) their quote, $240?')
    quote().customer_email = null
    expect(await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input: { quote_id: QUOTE, price: 240 } }, deps())).toBeNull()
    expect(await runSendQuote(db, { userId: OWNER, workspaceId: WS }, { quote_id: QUOTE, price: 240 }, deps())).toMatchObject({ success: false, code: 'NO_WAY_TO_REACH', error: expect.stringContaining('outside the US and Canada') })
  })

  it('a quote with no price needs one; a booked, done or cancelled quote is not sent', async () => {
    expect(await runSendQuote(db, { userId: OWNER, workspaceId: WS }, { quote_id: QUOTE }, deps())).toMatchObject({ code: 'NEEDS_PRICE' })
    expect(await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input: { quote_id: QUOTE } }, deps())).toBeNull()
    for (const status of ['booked', 'done', 'cancelled']) {
      quote().status = status
      expect(await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input: { quote_id: QUOTE, price: 240 } }, deps())).toBeNull()
    }
    expect(send).not.toHaveBeenCalled()
  })

  it("the owner's line may hold no link or web address, and at most 160 characters; the customer's own words carry none either", async () => {
    quote().total_cents = 24_000
    for (const message of ['Book at https://example.com/x', 'see www.example.com', 'details at example.com', 'email me: bob@example.org']) {
      expect(await runSendQuote(db, { userId: OWNER, workspaceId: WS }, { quote_id: QUOTE, message }, deps())).toMatchObject({ success: false, code: 'MESSAGE_HAS_LINK', error: expect.stringContaining("can't hold a link") })
      expect(await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input: { quote_id: QUOTE, message } }, deps())).toBeNull()
    }
    expect(await runSendQuote(db, { userId: OWNER, workspaceId: WS }, { quote_id: QUOTE, message: 'x'.repeat(161) }, deps())).toMatchObject({ code: 'BAD_INPUT' })
    // A web form's name or service can't smuggle a link into the business's text.
    quote().customer_name = 'Dana visit evil.example/win now'
    quote().service = 'Windows www.evil.example'
    const hold = await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input: { quote_id: QUOTE, message: 'Thanks, Mr. Lee.' } }, deps())
    expect(hold?.card.title).toBe('Text Dana visit now (+1 312-555-0142) their quote, $240?')
    expect(hold?.card.why.match(new RegExp(LINKISH.source, 'gi'))).toEqual(['https://nativeintelligence.dev/book/brightside'])
  })

  it('owners and admins only: a plain member gets no card and sends nothing; an admin emails from their own mailbox', async () => {
    expect(await quoteReplyHold(db, { workspaceId: WS, userId: MEMBER, toolName: SEND_QUOTE_TOOL, input: { quote_id: QUOTE, price: 240 } }, deps())).toBeNull()
    expect(await runSendQuote(db, { userId: MEMBER, workspaceId: WS, approvedCall: { approvalId: 'a', tool: SEND_QUOTE_TOOL } }, { quote_id: QUOTE, price: 240 }, deps())).toMatchObject({ code: 'NOT_ALLOWED' })
    expect(await runSendQuote(db, { userId: 'user-stranger', workspaceId: WS }, { quote_id: QUOTE, price: 240 }, deps())).toMatchObject({ code: 'NOT_A_MEMBER' })
    tables.business_phone_number = []
    const input = { quote_id: QUOTE, price: 240 }
    expect(await runSendQuote(db, { userId: ADMIN, workspaceId: WS, approvedCall: await approvedFor(SEND_QUOTE_TOOL, input, ADMIN) }, input, deps())).toMatchObject({ success: true, sent_via: 'email' })
    expect(mocks.sendEmail).toHaveBeenCalledWith(ADMIN, WS, expect.anything())
  })
})

describe('book_quote', () => {
  const START = '2026-11-04T09:30'
  const STARTS_AT = '2026-11-04T15:30:00.000Z' // 9:30 in Chicago, standard time (UTC-6)
  const confirmDeps = () => {
    const createEvent = vi.fn(async () => ({ id: 'evt-1' }))
    return {
      createEvent,
      hasCalendar: vi.fn(async () => true),
      isSlotFree: vi.fn(async () => true),
      textCustomer: (b: Parameters<typeof textBookingCustomer>[1], body: string) => textBookingCustomer(db, b, body, { send: send as never }),
    }
  }

  it("the card says who, when in the business's own zone, where, and the text they get; its yes books it through confirmBooking with no second card", async () => {
    const confirm = confirmDeps()
    const d = deps({ confirm: confirm as never })
    const hold = await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: BOOK_QUOTE_TOOL, input: { quote_id: QUOTE, start: START } }, d)
    const text = bookingConfirmedText('Brightside Window Washing', { kind: 'visit', address: '400 Lake St, Oak Park' }, 'Wed, Nov 4, 9:30 AM')
    expect(hold?.card).toEqual({
      title: 'Book Dana Ruiz (+1 312-555-0142) for Wed, Nov 4, 9:30 AM?',
      why: `90 min for 1 item, exterior windows. Yes puts it on your calendar and marks the quote booked; they get, from the business number +1 312-555-0100: “${text}” It runs once, exactly as shown, when you accept.`,
    })

    const out = await runBookQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: await approvedFor(BOOK_QUOTE_TOOL, { quote_id: QUOTE, start: START }, OWNER, d) }, { quote_id: QUOTE, start: START }, d)
    expect(out).toMatchObject({ success: true, when: 'Wed, Nov 4, 9:30 AM', calendar_event_id: 'evt-1', customer_texted: true, quote_id: QUOTE })
    expect(customerRows(tables)).toEqual([expect.objectContaining({ source: 'owner', state: 'confirmed', starts_at: STARTS_AT, ends_at: '2026-11-04T17:00:00.000Z', customer_name: 'Dana Ruiz', customer_phone: DANA, address: '400 Lake St, Oak Park', quote_id: QUOTE, contact_id: 'c-dana', guest_id: null, owner_user_id: OWNER, kind: 'visit', calendar_event_id: 'evt-1' })])
    expect(confirm.createEvent).toHaveBeenCalledWith(OWNER, expect.objectContaining({ start: STARTS_AT, end: '2026-11-04T17:00:00.000Z', location: '400 Lake St, Oak Park' }))
    expect(quote().status).toBe('booked')
    expect(send).toHaveBeenCalledWith(DANA, text, { from: BUSINESS_NUMBER })
    // The owner's card was the yes: no request_booking approval, no second card.
    expect(mocks.createApproval).not.toHaveBeenCalled()
  })

  it('unapproved, nothing is booked and nobody is texted', async () => {
    const confirm = confirmDeps()
    expect(await runBookQuote(db, { userId: OWNER, workspaceId: WS }, { quote_id: QUOTE, start: START }, deps({ confirm: confirm as never }))).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED', error: expect.stringContaining('Nothing was booked') })
    expect(customerRows(tables)).toHaveLength(0)
    expect(confirm.createEvent).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('no calendar connected: it says so, holds nothing and texts nobody', async () => {
    const confirm = { ...confirmDeps(), hasCalendar: vi.fn(async () => false) }
    const d = deps({ confirm: confirm as never })
    const out = await runBookQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: await approvedFor(BOOK_QUOTE_TOOL, { quote_id: QUOTE, start: START }, OWNER, d) }, { quote_id: QUOTE, start: START }, d)
    expect(out).toMatchObject({ success: false, code: 'NO_CALENDAR', error: expect.stringContaining('No Google or Outlook calendar') })
    expect(customerRows(tables)).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
    expect(quote().status).toBe('new')
  })

  it('a time already taken: nothing held, nobody texted', async () => {
    const confirm = { ...confirmDeps(), isSlotFree: vi.fn(async () => false) }
    const d = deps({ confirm: confirm as never })
    const out = await runBookQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: await approvedFor(BOOK_QUOTE_TOOL, { quote_id: QUOTE, start: START }, OWNER, d) }, { quote_id: QUOTE, start: START }, d)
    expect(out).toMatchObject({ success: false, code: 'SLOT_TAKEN' })
    expect(customerRows(tables)).toHaveLength(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('a yes that fails after the booking is held never leaves it requested, and texts nobody', async () => {
    // The slot reads free before the hold, then the calendar can't be read inside confirmBooking.
    const isSlotFree = vi.fn().mockResolvedValueOnce(true).mockRejectedValueOnce(new Error('calendar down'))
    const confirm = { ...confirmDeps(), isSlotFree }
    const d = deps({ confirm: confirm as never })
    const out = await runBookQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: await approvedFor(BOOK_QUOTE_TOOL, { quote_id: QUOTE, start: START }, OWNER, d) }, { quote_id: QUOTE, start: START }, d)
    expect(out).toMatchObject({ success: false })
    expect(customerRows(tables)).toEqual([expect.objectContaining({ source: 'owner', state: 'cancelled' })])
    expect(send).not.toHaveBeenCalled()
    // The start is free again: a new yes can book it.
    const again = await runBookQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: await approvedFor(BOOK_QUOTE_TOOL, { quote_id: QUOTE, start: START }, OWNER, deps({ confirm: confirmDeps() as never })) }, { quote_id: QUOTE, start: START }, deps({ confirm: confirmDeps() as never }))
    expect(again).toMatchObject({ success: true })
  })

  it("a slot that fills between the check and the yes is released without the customer's \"we can't\" text", async () => {
    const isSlotFree = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const confirm = { ...confirmDeps(), isSlotFree }
    const d = deps({ confirm: confirm as never })
    const out = await runBookQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: await approvedFor(BOOK_QUOTE_TOOL, { quote_id: QUOTE, start: START }, OWNER, d) }, { quote_id: QUOTE, start: START }, d)
    expect(out).toMatchObject({ success: false, code: 'SLOT_TAKEN', error: expect.stringContaining('Dana Ruiz was not told') })
    expect(customerRows(tables)).toEqual([expect.objectContaining({ source: 'owner', state: 'declined' })])
    expect(send).not.toHaveBeenCalled()
  })

  it("an admin books onto the business owner's calendar, and says so; a plain member can't", async () => {
    const confirm = confirmDeps()
    const d = deps({ confirm: confirm as never })
    const planned = await planBookQuote(db, { workspaceId: WS, userId: ADMIN }, { quote_id: QUOTE, start: START, minutes: 60 }, d)
    expect(planned.ok && bookQuoteCard(planned.plan).why).toContain("Yes puts it on the owner's calendar")
    const out = await runBookQuote(db, { userId: ADMIN, workspaceId: WS, approvedCall: await approvedFor(BOOK_QUOTE_TOOL, { quote_id: QUOTE, start: START, minutes: 60 }, ADMIN, d) }, { quote_id: QUOTE, start: START, minutes: 60 }, d)
    expect(out).toMatchObject({ success: true })
    expect(customerRows(tables)[0]).toMatchObject({ owner_user_id: OWNER, ends_at: '2026-11-04T16:30:00.000Z' })
    expect(await quoteReplyHold(db, { workspaceId: WS, userId: MEMBER, toolName: BOOK_QUOTE_TOOL, input: { quote_id: QUOTE, start: START } }, d)).toBeNull()
    expect(await runBookQuote(db, { userId: MEMBER, workspaceId: WS }, { quote_id: QUOTE, start: START }, d)).toMatchObject({ code: 'NOT_ALLOWED' })
  })

  it('without a texting number the card says no text goes; a past time or one that does not exist is refused', async () => {
    tables.business_phone_number = []
    const planned = await planBookQuote(db, { workspaceId: WS, userId: OWNER }, { quote_id: QUOTE, start: START }, deps())
    expect(planned.ok && bookQuoteCard(planned.plan).why).toContain('No confirmation text goes (the business has no texting number yet): tell them yourself.')
    expect(await runBookQuote(db, { userId: OWNER, workspaceId: WS }, { quote_id: QUOTE, start: '2026-10-30T09:00' }, deps())).toMatchObject({ code: 'PAST' })
    expect(await runBookQuote(db, { userId: OWNER, workspaceId: WS }, { quote_id: QUOTE, start: '2026-11-31T09:00' }, deps())).toMatchObject({ code: 'BAD_START' })
    expect(await runBookQuote(db, { userId: OWNER, workspaceId: WS }, { quote_id: QUOTE, start: '2026-11-04T09:30Z' }, deps())).toMatchObject({ code: 'BAD_INPUT' })
  })

  it("reads start as the business's wall clock across a daylight-saving change, and refuses an hour the clocks skip", () => {
    expect(new Date(localStartInstant('2026-10-30T09:30', CHICAGO)!).toISOString()).toBe('2026-10-30T14:30:00.000Z') // CDT, UTC-5
    expect(new Date(localStartInstant('2026-11-02T09:30', CHICAGO)!).toISOString()).toBe('2026-11-02T15:30:00.000Z') // CST, UTC-6
    expect(new Date(localStartInstant('2026-11-02T09:30', 'Asia/Tokyo')!).toISOString()).toBe('2026-11-02T00:30:00.000Z')
    expect(localStartInstant('2026-03-08T02:30', CHICAGO)).toBeNull()
    expect(localStartInstant('2026-02-30T10:00', CHICAGO)).toBeNull()
  })
})

describe('the card shows every word, within what the app and a text show', () => {
  /** The longest inputs every field allows (the profile's and quote's own caps), plus the longest owner's line. */
  function worstCase() {
    Object.assign(tables.business_profile[0], { business_name: 'Brightside Family Window, Gutter & Pressure Washing Services of the Greater Lakeshore and Western Suburbs, Inc'.padEnd(120, 'x').slice(0, 120), booking_slug: 'b'.repeat(48), booking_kind: 'k'.repeat(40) })
    Object.assign(quote(), {
      customer_name: 'Alexandria Margarethe Konstantinopoulou-Vanderbilt '.repeat(3).slice(0, 120),
      customer_email: `${'a'.repeat(108)}@example.com`,
      address: '1200 North Lake Shore Drive, Apartment 4407, Building C, '.repeat(6).slice(0, 300),
      service: 'Complete exterior and interior window washing with screen repair '.repeat(2).slice(0, 120),
      items: Array.from({ length: 50 }, (_, i) => ({ description: `Window ${i}`, service: `Service number ${i} `.repeat(6).slice(0, 120), width: 123.45, length: 678.9, unit: 'ft', quantity: 99 })),
    })
    return { quote_id: QUOTE, price: 1_000_000, message: 'We can come any weekday morning before nine, or on Saturdays, and we bring every ladder and squeegee we need. '.repeat(2).slice(0, 160) }
  }
  const fits = (card: { title: string; why: string } | undefined) => {
    expect(card).toBeTruthy()
    expect(card!.title.length).toBeLessThanOrEqual(QUOTE_CARD_TITLE_MAX)
    expect(card!.why.length).toBeLessThanOrEqual(QUOTE_CARD_WHY_MAX)
  }

  it('send_quote by text and by email: the title names who, the why holds the exact words, both inside their limits', async () => {
    const input = worstCase()
    const text = await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input }, deps())
    fits(text?.card)
    expect(text!.card.title).toContain('(+1 312-555-0142)')
    expect(text!.card.why).toContain('https://nativeintelligence.dev/book/' + 'b'.repeat(48))
    // What is sent is exactly the quoted words of the card.
    await runSendQuote(db, { userId: OWNER, workspaceId: WS, approvedCall: { approvalId: 'a', tool: SEND_QUOTE_TOOL, quoteReply: text!.context.quoteReply } }, input, deps())
    expect(text!.card.why).toContain(`“${send.mock.calls[0][1]}”`)
    tables.business_phone_number = []
    quote().status = 'new'
    const email = await quoteReplyHold(db, { workspaceId: WS, userId: OWNER, toolName: SEND_QUOTE_TOOL, input }, deps())
    fits(email?.card)
    expect(email!.card.title).toContain(`(${'a'.repeat(108)}@example.com)`)
  })

  it("book_quote with and without a text, for an admin (the owner's calendar), a date next year: inside their limits", async () => {
    const { quote_id } = worstCase()
    const input = { quote_id, start: '2027-11-24T12:30', minutes: 480 }
    const withText = await quoteReplyHold(db, { workspaceId: WS, userId: ADMIN, toolName: BOOK_QUOTE_TOOL, input }, deps())
    fits(withText?.card)
    expect(withText!.card.title).toMatch(/^Book Alexandria .* \(\+1 312-555-0142\) for Wed, Nov 24, 2027, 12:30 PM\?$/)
    expect(withText!.card.why).toContain(`your ${'k'.repeat(40)} is booked for Wed, Nov 24, 12:30 PM at 1200 North Lake Shore`)
    // The confirmation as it will be texted (the SMS formatter's ASCII "..."), not as it was written.
    expect(withText!.card.why).not.toContain('…')
    tables.business_phone_number = []
    const noText = await quoteReplyHold(db, { workspaceId: WS, userId: ADMIN, toolName: BOOK_QUOTE_TOOL, input }, deps())
    fits(noText?.card)
    expect(noText!.card.why).toContain('No confirmation text goes (the business has no texting number yet)')
  })
})

describe('who holds them', () => {
  it("a customer's agent never gets them, nor does any guest", () => {
    for (const name of [SEND_QUOTE_TOOL, BOOK_QUOTE_TOOL]) {
      expect(CUSTOMER_TOOLS as readonly string[]).not.toContain(name)
      expect(GUEST_NEVER_TOOLS.has(name)).toBe(true)
      expect(GUEST_OFFERABLE_TOOLS).not.toContain(name)
    }
  })
})
