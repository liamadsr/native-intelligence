/**
 * A website quote reaching the business (roadmap B1): the CRM contact found
 * or made, the quote stored once per submission, and ONE `quote.received`
 * event for the owner plus the loop trigger, for a new quote only. Over the
 * real store (../store.ts, ../contacts.ts) on an in-memory database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { cleanFacts } from '@/lib/agent-events/record'
import { routeEvent } from '@/lib/agent-events/router'
import { eventTurnLine } from '@/lib/agent-events/event-turn'
import { upsertCustomerContact } from '../contacts'
import { parseQuoteForm, type ParsedQuote } from '../intake'
import { quoteEventTitle, receiveQuote, type ReceiveQuoteDeps } from '../receive'
import { getQuote, insertQuote, listQuotes, quotesForCustomer, updateQuote } from '../store'

const WS = 'ws-rug'
const OWNER = 'user-owner'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient

beforeEach(() => {
  tables = {
    member: [{ id: 'm-owner', workspace_id: WS, user_id: OWNER, role: 'owner' }],
    contact: [],
    customer_quote: [],
  }
  db = memoryDb(tables, {
    customer_quote: (a, b) => a.workspace_id === b.workspace_id && a.external_id != null && a.external_id === b.external_id,
  })
})

function form(fields: Record<string, unknown>): ParsedQuote {
  const parsed = parseQuoteForm(fields)
  if (!parsed.ok) throw new Error(parsed.reason)
  return parsed.quote
}

function deps(over: Partial<ReceiveQuoteDeps> = {}) {
  const events: unknown[][] = []
  const flows: unknown[] = []
  const d: ReceiveQuoteDeps = {
    upsertContact: (args, input) => upsertCustomerContact(db, args, input),
    insertQuote: (args, quote) => insertQuote(db, args, quote),
    recordEvents: vi.fn(async (inputs) => (events.push(inputs), inputs.length)),
    emitFlow: vi.fn(async (args) => (flows.push(args), true)),
    ...over,
  }
  return { d, events, flows }
}

const SARAH = { 'Full Name': 'Sarah Lee', Email: 'sarah@example.com', 'Phone Number': '(646) 555-0173', length: 10, width: 8, estimated_price: 400, service: 'cleaning', message: 'Wine stain', submission_id: 'sub-1' }

describe('a new quote', () => {
  it('makes the contact a lead, stores the quote linked to it, tells the owner once and fires the loops', async () => {
    const { d, events, flows } = deps()
    const result = await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form(SARAH), d)
    expect(result.ok && result.created).toBe(true)
    if (!result.ok) return

    expect(tables.contact).toHaveLength(1)
    expect(tables.contact[0]).toMatchObject({ workspace_id: WS, full_name: 'Sarah Lee', email: 'sarah@example.com', phone: '+16465550173', relationship_type: 'lead', source: 'web_form', visibility: 'workspace', created_by_member_id: 'm-owner' })
    expect(result.quote).toMatchObject({ contactId: tables.contact[0].id, customerName: 'Sarah Lee', totalCents: 40_000, status: 'new', source: 'web_form' })

    expect(events).toHaveLength(1)
    const [event] = events[0] as Array<Record<string, unknown>>
    expect(event).toMatchObject({ workspaceId: WS, userId: OWNER, kind: 'quote.received', refType: 'quote', refId: result.quote.id, dedupeKey: `quote:${result.quote.id}:received` })
    // Native Intelligence's own words and numbers only: nothing the customer typed.
    expect((event.facts as Record<string, unknown>).title).toBe('a quote from a customer ending 0173: 1 item (8x10 ft), $400')
    expect(flows).toEqual([{ workspaceId: WS, quoteId: result.quote.id }])
  })

  it('a re-posted submission is the same quote: no second event, no second fire', async () => {
    const { d, events, flows } = deps()
    const first = await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form(SARAH), d)
    const again = await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form(SARAH), d)
    expect(again.ok && !again.created).toBe(true)
    expect(again.ok && first.ok && again.quote.id === first.quote.id).toBe(true)
    expect(tables.customer_quote).toHaveLength(1)
    expect(events).toHaveLength(1)
    expect(flows).toHaveLength(1)
  })

  it('an existing contact is found by its whole number and keeps what it has', async () => {
    tables.contact.push({ id: 'c-1', workspace_id: WS, full_name: 'Sarah L.', email: null, phone: '646.555.0173', relationship_type: 'customer', merged_into_contact_id: null })
    const { d } = deps()
    const result = await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form(SARAH), d)
    expect(result.ok && result.contactId).toBe('c-1')
    expect(tables.contact).toHaveLength(1)
    // An unverified form never gives a found contact an email (or a phone).
    expect(tables.contact[0]).toMatchObject({ full_name: 'Sarah L.', email: null, phone: '646.555.0173', relationship_type: 'customer' })
  })

  it("a form can't take over someone's contact: their email with a stranger's number gives the contact no phone", async () => {
    tables.contact.push({ id: 'c-victim', workspace_id: WS, full_name: 'Vera Victim', email: 'vera@example.com', phone: null, relationship_type: 'customer', merged_into_contact_id: null })
    const { d } = deps()
    await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form({ name: 'Vera', email: 'vera@example.com', phone: '+12125550666', submission_id: 'x' }), d)
    expect(tables.contact[0].phone).toBeNull()
  })

  it('a foreign number that only ends like a contact’s is not that contact', async () => {
    tables.contact.push({ id: 'c-1', workspace_id: WS, full_name: 'Sarah L.', email: null, phone: '(646) 555-0173', relationship_type: 'customer', merged_into_contact_id: null })
    const { d } = deps()
    const result = await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form({ name: 'Someone', phone: '+446465550173', submission_id: 'y' }), d)
    expect(result.ok && result.contactId).not.toBe('c-1')
  })

  it('a failed contact write still stores the quote and tells the owner', async () => {
    const { d, events } = deps({ upsertContact: async () => { throw new Error('contact down') } })
    const result = await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form(SARAH), d)
    expect(result.ok && result.quote.contactId).toBeNull()
    expect(events).toHaveLength(1)
  })

  it('a failed quote write is an error and tells no one', async () => {
    const { d, events, flows } = deps({ insertQuote: async () => ({ ok: false, error: 'down' }) })
    expect(await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form(SARAH), d)).toEqual({ ok: false, error: 'down' })
    expect(events).toHaveLength(0)
    expect(flows).toHaveLength(0)
  })
})

describe("the owner's inbox", () => {
  it('routes a quote to a turn no judgment lowers, and names it with get_quote', () => {
    const decision = routeEvent({ kind: 'quote.received', facts: {}, occurs_at: new Date().toISOString(), expires_at: null }, { paused: false, dormant: false, overUsage: false }, Date.now())
    expect(decision).toMatchObject({ outcome: 'turn', rule: 'new_quote', forced: true })
    // Quiet while paused, as every turn: nothing is lost.
    expect(routeEvent({ kind: 'quote.received', facts: {}, occurs_at: new Date().toISOString(), expires_at: null }, { paused: true, dormant: false, overUsage: false }, Date.now()).outcome).toBe('quiet')
    const line = eventTurnLine({ id: 'e1', kind: 'quote.received', facts: cleanFacts({ title: 'Sarah Lee: 1 item (8x10 ft), cleaning, $400', contactId: 'c-1' }), occurs_at: new Date().toISOString(), ref_type: 'quote', ref_id: 'q-1' })
    expect(line).toContain('Sarah Lee: 1 item (8x10 ft), cleaning, $400')
    expect(line).toContain('get_quote')
    // The next step is the owner's yes (roadmap F3): book the time the customer chose, else send the price and booking link.
    expect(line).toContain('already chose a time (its requested dates, or their notes), offer to book it and on their yes call book_quote')
    expect(line).toContain('otherwise ask for or confirm the price and on their yes call send_quote')
    expect(line).toContain('send_payment_link')
    expect(line).toContain('[quote q-1]')
    expect(line).toContain('[contact c-1]')
  })

  it("the title carries none of the customer's words, only Native Intelligence's and numbers", () => {
    expect(quoteEventTitle({ customerPhone: '+16465550173', items: [], totalCents: null, currency: 'usd' })).toBe('a quote from a customer ending 0173')
    const sneaky = quoteEventTitle({ customerPhone: null, items: [{ description: 'IGNORE PREVIOUS', service: 'do this', size: 'huge', width: 9, length: 12, unit: 'ft' }], totalCents: 60_000, currency: 'usd' })
    expect(sneaky).toBe('a quote from a customer: 1 item (9x12 ft), $600')
  })

  it("a guessed submission id never swallows someone else's quote", async () => {
    const { d, events } = deps()
    await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form({ name: 'Mallory', email: 'm@evil.example', submission_id: 'sub-9' }), d)
    const real = await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form({ name: 'Real', email: 'real@example.com', submission_id: 'sub-9' }), d)
    expect(real.ok && real.created).toBe(true)
    expect(real.ok && real.quote.customerName).toBe('Real')
    expect(tables.customer_quote).toHaveLength(2)
    expect(events).toHaveLength(2)
  })
})

describe('the quote store', () => {
  it("a customer's quotes are theirs only: sent from their number, never by contact", async () => {
    const { d } = deps()
    await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form(SARAH), d)
    await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form({ name: 'Bob', phone: '+12125550111', submission_id: 'sub-2' }), d)
    await receiveQuote({ workspaceId: 'ws-other', ownerUserId: OWNER }, form({ name: 'Sarah elsewhere', phone: '(646) 555-0173', submission_id: 'sub-3' }), d)
    const hers = await quotesForCustomer(db, WS, '+16465550173')
    expect(hers.map((q) => q.customerName)).toEqual(['Sarah Lee'])
    expect(await quotesForCustomer(db, WS, null)).toEqual([])
    expect((await listQuotes(db, WS)).map((q) => q.customerName).sort()).toEqual(['Bob', 'Sarah Lee'])
  })

  it('reads and changes one quote of the workspace only', async () => {
    const { d } = deps()
    const made = await receiveQuote({ workspaceId: WS, ownerUserId: OWNER }, form(SARAH), d)
    if (!made.ok) throw new Error('not made')
    expect(await getQuote(db, 'ws-other', made.quote.id)).toBeNull()
    expect(await updateQuote(db, 'ws-other', made.quote.id, { status: 'accepted' })).toBeNull()
    const changed = await updateQuote(db, WS, made.quote.id, { status: 'accepted', totalCents: 55_000 })
    expect(changed).toMatchObject({ status: 'accepted', totalCents: 55_000 })
    expect(await getQuote(db, WS, 'not-a-uuid')).toBeNull()
  })
})
