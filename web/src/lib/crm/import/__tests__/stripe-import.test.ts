/**
 * Importing a connected Stripe account's customers (roadmap #10): payments
 * become each customer's timeline, people who paid without a Stripe customer
 * come in by their billing email, the import only starts when Stripe is
 * connected, and an export file and a direct import of one account find the
 * same contacts by the customer's id. Made-up people and ids only.
 */
import type Stripe from 'stripe'
import { describe, expect, it, vi } from 'vitest'
import { applyPendingItems, createImportBatch, stageRecords } from '../batch'
import { startStripeImport } from '../connected'
import { contactFileRecords, readContactFile } from '../file'
import type { ImportRecord } from '../record'
import { chargeToJob, foldCharges, readStripePayments, stripeCustomerToRecord, stripeGuestToRecord, type StripeGuest } from '../sources/stripe'
import { contactRow, memDb } from './mem-db'

const WS = 'ws-1'
const USER = 'user-1'
const DAY = 86_400

const charge = (c: Partial<Stripe.Charge> & { id: string }): Stripe.Charge =>
  ({ status: 'succeeded', paid: true, amount: 48_000, amount_refunded: 0, currency: 'usd', created: 1_740_787_200, description: null, customer: null, billing_details: {}, ...c }) as unknown as Stripe.Charge

const customer = (c: Partial<Stripe.Customer> & { id: string }): Stripe.Customer => ({ object: 'customer', name: null, email: null, phone: null, address: null, shipping: null, description: null, ...c }) as unknown as Stripe.Customer

describe('Stripe payments as past payments', () => {
  it('keeps what came in: succeeded, minus refunds; a failed or fully refunded charge is none', () => {
    expect(chargeToJob(charge({ id: 'ch_1', description: 'Rug wash, 8x10', amount_refunded: 8_000 }))).toEqual({
      kind: 'invoice',
      title: 'Rug wash, 8x10',
      occurredAt: '2025-03-01T00:00:00.000Z',
      amountCents: 40_000,
      currency: 'usd',
    })
    expect(chargeToJob(charge({ id: 'ch_2' }))?.title).toBe('Stripe payment')
    expect(chargeToJob(charge({ id: 'ch_3', status: 'failed', paid: false }))).toBeNull()
    expect(chargeToJob(charge({ id: 'ch_4', amount_refunded: 48_000 }))).toBeNull()
  })

  it("groups payments by customer, and a guest's by their billing email with the latest details first", () => {
    const into = { byCustomer: new Map(), guests: new Map<string, StripeGuest>() }
    foldCharges(into, [
      charge({ id: 'ch_1', customer: 'cus_ana', created: 1_740_787_200 + 30 * DAY }),
      charge({ id: 'ch_2', customer: 'cus_ana' }),
      charge({ id: 'ch_3', billing_details: { email: 'Ben@Example.com', name: 'Ben Ode', phone: '626-555-0102', address: null } as never }),
      charge({ id: 'ch_4', billing_details: { email: 'ben@example.com', name: 'B. Ode', phone: null, address: { line1: '9 Oak Ave', city: 'Pasadena', state: 'CA', postal_code: '91103', country: 'US', line2: null } } as never }),
      // No customer and no email: nobody to put it on.
      charge({ id: 'ch_5' }),
    ])
    expect(into.byCustomer.get('cus_ana')).toHaveLength(2)
    expect([...into.guests.values()]).toEqual([
      { email: 'ben@example.com', name: 'Ben Ode', phone: '626-555-0102', address: '9 Oak Ave, Pasadena, CA 91103, US', jobs: [expect.any(Object), expect.any(Object)] },
    ])
  })

  it('reads every page of charges on the connected account, and stops at the cap', async () => {
    const list = vi.fn(async (params: { starting_after?: string }, _opts?: { stripeAccount: string }) =>
      params.starting_after ? { data: [charge({ id: 'ch_2', customer: 'cus_ana' })], has_more: false } : { data: [charge({ id: 'ch_1', customer: 'cus_ana' })], has_more: true },
    )
    const stripe = { charges: { list } } as unknown as Stripe
    const read = await readStripePayments(stripe, 'acct_1')
    expect(list.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      [{ limit: 100 }, { stripeAccount: 'acct_1' }],
      [{ limit: 100, starting_after: 'ch_1' }, { stripeAccount: 'acct_1' }],
    ])
    expect(read).toMatchObject({ byCustomer: [['cus_ana', [expect.any(Object), expect.any(Object)]]], guests: [], truncated: false })

    const endless = { charges: { list: vi.fn(async () => ({ data: [charge({ id: 'ch_x' })], has_more: true })) } } as unknown as Stripe
    expect((await readStripePayments(endless, 'acct_1')).truncated).toBe(true)
  })
})

describe('Stripe customers as records', () => {
  it('a customer: name, email, phone, address, notes, their payments, a customer of the business', () => {
    const job = chargeToJob(charge({ id: 'ch_1' }))!
    expect(
      stripeCustomerToRecord(
        customer({ id: 'cus_ana', name: 'Ana Ruiz', email: 'ana@example.com', phone: '+16265550101', description: 'Prefers mornings', address: { line1: '12 Elm St', line2: null, city: 'Pasadena', state: 'CA', postal_code: '91101', country: 'US' } }),
        [job],
      ),
    ).toEqual({
      kind: 'contact',
      externalId: 'cus_ana',
      fullName: 'Ana Ruiz',
      emails: ['ana@example.com'],
      phones: ['+16265550101'],
      address: '12 Elm St, Pasadena, CA 91101, US',
      notes: 'Prefers mornings',
      history: [job],
      relationship: 'customer',
    })
    // Shipping details may be a gift's recipient: never taken as the customer's.
    expect(stripeCustomerToRecord(customer({ id: 'cus_b', email: 'ben@example.com', shipping: { name: 'Cy Lane', phone: '626-555-0103', address: { line1: '9 Oak Ave', city: 'Pasadena' } } as never }))).toMatchObject({
      fullName: null,
      emails: ['ben@example.com'],
      phones: [],
      address: null,
    })
    expect(stripeGuestToRecord({ email: 'cy@example.com', name: null, phone: null, address: null, jobs: [] })).toMatchObject({ emails: ['cy@example.com'], relationship: 'customer' })
  })

  it('no payment of theirs among every payment read: a lead; with the oldest payments left out, a customer still', () => {
    expect(stripeCustomerToRecord(customer({ id: 'cus_q', name: 'Quinn Rae' }), [], { allPaymentsRead: true }).relationship).toBe('lead')
    expect(stripeCustomerToRecord(customer({ id: 'cus_q', name: 'Quinn Rae' }), [], { allPaymentsRead: false }).relationship).toBe('customer')
    expect(stripeCustomerToRecord(customer({ id: 'cus_q', name: 'Quinn Rae' }), [chargeToJob(charge({ id: 'ch_9' }))!], { allPaymentsRead: true }).relationship).toBe('customer')
  })
})

describe('starting a Stripe import', () => {
  const db = (account: Record<string, unknown> | null) =>
    memDb({ stripe_connect_account: account ? [{ workspace_id: WS, stripe_account_id: 'acct_1', linked_via: 'oauth', livemode: true, status: 'ready', ...account }] : [], contact_import_batch: [] })

  it('only with Stripe connected: otherwise it says how to bring them in with an export', async () => {
    for (const d of [db(null), db({ status: 'disconnected' })]) {
      const send = vi.fn()
      const out = await startStripeImport(d.client, { userId: USER, workspaceId: WS }, { send })
      expect(out).toEqual({ ok: false, error: expect.stringContaining('export their customers from Stripe') })
      expect(send).not.toHaveBeenCalled()
      expect(d.tables.contact_import_batch).toHaveLength(0)
    }
  })

  it('opens a Stripe batch and starts reading it; asking again while it runs returns that one', async () => {
    const d = db({})
    const send = vi.fn(async () => undefined)
    const first = await startStripeImport(d.client, { userId: USER, workspaceId: WS }, { send })
    expect(first).toEqual({ ok: true, batchId: expect.any(String), alreadyRunning: false })
    expect(d.tables.contact_import_batch).toEqual([expect.objectContaining({ source: 'stripe', workspace_id: WS, user_id: USER, notify: true, status: 'staging' })])
    expect(send).toHaveBeenCalledWith({ name: 'crm/import.stripe', data: { batchId: first.ok ? first.batchId : '', workspaceId: WS } })
    const again = await startStripeImport(d.client, { userId: USER, workspaceId: WS }, { send })
    expect(again).toEqual({ ok: true, batchId: first.ok ? first.batchId : '', alreadyRunning: true })
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('an export file and a direct import of one Stripe account', () => {
  async function importAs(d: ReturnType<typeof memDb>, records: ImportRecord[]) {
    const created = await createImportBatch(d.client, { workspaceId: WS, userId: USER, source: 'stripe', notify: false })
    if (!created.ok) throw new Error(created.error)
    await stageRecords(d.client, created.batch, records)
    for (;;) if (!(await applyPendingItems(d.client, created.batch.id)).remaining) break
    return d.tables.contact_import_item.filter((i) => i.batch_id === created.batch.id)
  }

  it('find the same contacts by the customer id, whatever the name or email says now', async () => {
    const d = memDb({ contact: [contactRow({ id: 'c-ana', full_name: 'Ana Ruiz', email: 'ana@example.com' })], member: [{ id: 'm-1', user_id: USER, workspace_id: WS }], contact_interaction: [], company: [] })
    const csv = ['id,Email,Name,Created (UTC),Card Last4,Total Spend,Payment Count', 'cus_ana,ana@example.com,Ana Ruiz,2024-05-02 18:20:11,4242,480.00,1'].join('\n')
    const file = await readContactFile(new TextEncoder().encode(csv), 'unified_customers.csv')
    if (!file.ok || file.format !== 'spreadsheet') throw new Error('not read')
    expect(file.source).toBe('stripe')
    const fromFile = await importAs(d, contactFileRecords(file))
    expect(fromFile.map((i) => [i.outcome, i.contact_id])).toEqual([['matched', 'c-ana']])

    // Later, the direct import: her email changed in Stripe, the id did not.
    const direct = await importAs(d, [stripeCustomerToRecord(customer({ id: 'cus_ana', name: 'Ana Ruiz', email: 'ana.ruiz@example.net' }))])
    expect(direct.map((i) => i.contact_id)).toEqual(['c-ana'])
    expect(d.tables.contact).toHaveLength(1)
    expect(d.tables.crm_source_link).toEqual([expect.objectContaining({ source: 'stripe', kind: 'contact', external_id: 'cus_ana', entity_id: 'c-ana' })])
  })
})
