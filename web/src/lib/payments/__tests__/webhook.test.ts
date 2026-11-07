/**
 * The Connect webhook (src/lib/payments/webhook.ts) over its real store
 * (webhook-store.ts) and an in-memory database: a payment marks the request
 * paid once and queues its follow-ups; a forged or foreign event does
 * nothing; refunds and disputes are logged and nothing acts on them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'

const hoisted = vi.hoisted(() => ({ queued: [] as Array<{ id: string }>, notified: [] as unknown[] }))

vi.mock('../paid', () => ({
  queuePaidFollowups: vi.fn(async (supabase: { from: (t: string) => { update: (r: unknown) => { eq: (k: string, v: string) => Promise<unknown> } } }, request: { id: string }) => {
    hoisted.queued.push(request)
    await supabase.from('payment_request').update({ paid_followups_queued_at: '2026-11-03T12:00:00.000Z' }).eq('id', request.id)
  }),
}))
vi.mock('../setup', () => ({
  notifyIfReady: vi.fn(async (_s: unknown, synced: unknown) => {
    hoisted.notified.push(synced)
    return true
  }),
}))

import { handleConnectEvent } from '../webhook'
import { connectWebhookDeps } from '../webhook-store'
import { memDb, type MemDb } from './mem-db'

const OWNER_ACCOUNT = 'acct_owner123'

function seed(): MemDb {
  return memDb(
    {
      payment_request: [
        {
          id: 'req-1',
          workspace_id: 'ws-1',
          stripe_account_id: OWNER_ACCOUNT,
          stripe_payment_link_id: 'plink_123',
          amount_cents: 60_000,
          status: 'open',
          paid_followups_queued_at: null,
          stripe_payment_intent_id: null,
          amount_refunded_cents: 0,
        },
      ],
      stripe_connect_account: [
        { workspace_id: 'ws-1', stripe_account_id: OWNER_ACCOUNT, status: 'onboarding', linked_via: 'created', livemode: false, charges_enabled: false, payouts_enabled: false, details_submitted: false, connected_by: 'user-1', application_fee_bps: 0, application_fee_cents: 0, ready_at: null, ready_notified_at: null },
      ],
      stripe_connect_event: [],
    },
    { stripe_connect_event: [['event_id']] },
  )
}

function fakeStripe(account: Partial<Stripe.Account> = { charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [], past_due: [] } as never }) {
  return { accounts: { retrieve: vi.fn(async () => account) } }
}

let n = 0
function event(type: string, object: Record<string, unknown>, over: Partial<Stripe.Event> = {}): Stripe.Event {
  return { id: `evt_${++n}`, type, account: OWNER_ACCOUNT, livemode: false, created: 1_793_000_000, data: { object }, ...over } as unknown as Stripe.Event
}

const paidSession = (over: Record<string, unknown> = {}) => ({
  id: 'cs_test_1',
  object: 'checkout.session',
  payment_link: 'plink_123',
  payment_status: 'paid',
  payment_intent: 'pi_123',
  amount_total: 60_000,
  currency: 'usd',
  metadata: { dial8_payment_request_id: 'req-1' },
  ...over,
})

beforeEach(() => {
  hoisted.queued.length = 0
  hoisted.notified.length = 0
})

describe('a payment', () => {
  it('marks the request paid with what Stripe says, and queues its follow-ups once', async () => {
    const db = seed()
    const deps = connectWebhookDeps(db.client, fakeStripe() as never)
    expect(await handleConnectEvent(event('checkout.session.completed', paidSession()), deps)).toBe('paid')
    expect(db.tables.payment_request[0]).toMatchObject({
      status: 'paid',
      stripe_checkout_session_id: 'cs_test_1',
      stripe_payment_intent_id: 'pi_123',
      amount_paid_cents: 60_000,
      paid_at: new Date(1_793_000_000 * 1000).toISOString(),
    })
    expect(hoisted.queued.map((r) => r.id)).toEqual(['req-1'])
    expect(db.tables.stripe_connect_event[0]).toMatchObject({ outcome: 'paid', workspace_id: 'ws-1', payment_request_id: 'req-1' })
    expect(db.tables.stripe_connect_event[0].processed_at).toBeTruthy()
  })

  it('a replayed event does nothing', async () => {
    const db = seed()
    const deps = connectWebhookDeps(db.client, fakeStripe() as never)
    const e = event('checkout.session.completed', paidSession())
    await handleConnectEvent(e, deps)
    expect(await handleConnectEvent(e, deps)).toBe('duplicate')
    expect(hoisted.queued).toHaveLength(1)
  })

  it('a second event for an already-paid request queues nothing more', async () => {
    const db = seed()
    const deps = connectWebhookDeps(db.client, fakeStripe() as never)
    await handleConnectEvent(event('checkout.session.completed', paidSession()), deps)
    expect(await handleConnectEvent(event('checkout.session.async_payment_succeeded', paidSession()), deps)).toBe('already_paid')
    expect(hoisted.queued).toHaveLength(1)
  })

  it('a retry after the follow-ups failed to queue queues them', async () => {
    const db = seed()
    db.tables.payment_request[0].status = 'paid'
    const deps = connectWebhookDeps(db.client, fakeStripe() as never)
    expect(await handleConnectEvent(event('checkout.session.completed', paidSession()), deps)).toBe('already_paid')
    expect(hoisted.queued.map((r) => r.id)).toEqual(['req-1'])
  })

  it('an event that failed midway runs again on Stripe’s retry', async () => {
    const db = seed()
    db.tables.stripe_connect_event.push({ event_id: 'evt_retry', type: 'checkout.session.completed', processed_at: null })
    const deps = connectWebhookDeps(db.client, fakeStripe() as never)
    expect(await handleConnectEvent(event('checkout.session.completed', paidSession(), { id: 'evt_retry' }), deps)).toBe('paid')
  })

  it('a delayed payment method waits for async_payment_succeeded', async () => {
    const db = seed()
    const deps = connectWebhookDeps(db.client, fakeStripe() as never)
    expect(await handleConnectEvent(event('checkout.session.completed', paidSession({ payment_status: 'unpaid' })), deps)).toBe('awaiting_async_payment')
    expect(db.tables.payment_request[0].status).toBe('open')
    expect(await handleConnectEvent(event('checkout.session.async_payment_succeeded', paidSession()), deps)).toBe('paid')
    expect(hoisted.queued).toHaveLength(1)
  })
})

describe('trust', () => {
  it('an event from ANOTHER account naming our request (forged metadata) marks nothing paid', async () => {
    const db = seed()
    const deps = connectWebhookDeps(db.client, fakeStripe() as never)
    const forged = event('checkout.session.completed', paidSession({ payment_link: 'plink_attacker' }), { account: 'acct_attacker99' })
    expect(await handleConnectEvent(forged, deps)).toBe('unknown_payment')
    const sameLinkWrongAccount = event('checkout.session.completed', paidSession(), { account: 'acct_attacker99' })
    expect(await handleConnectEvent(sameLinkWrongAccount, deps)).toBe('unknown_payment')
    expect(db.tables.payment_request[0].status).toBe('open')
    expect(hoisted.queued).toHaveLength(0)
  })

  it('a checkout with no payment link of ours is ignored', async () => {
    const db = seed()
    const deps = connectWebhookDeps(db.client, fakeStripe() as never)
    expect(await handleConnectEvent(event('checkout.session.completed', paidSession({ payment_link: null })), deps)).toBe('ignored')
    expect(db.tables.payment_request[0].status).toBe('open')
  })
})

describe('refunds and disputes: logged, never acted on', () => {
  async function paid(db: MemDb) {
    const deps = connectWebhookDeps(db.client, fakeStripe() as never)
    await handleConnectEvent(event('checkout.session.completed', paidSession()), deps)
    hoisted.queued.length = 0
    return deps
  }

  it('a partial refund is logged and the request stays paid; a full one marks it refunded', async () => {
    const db = seed()
    const deps = await paid(db)
    expect(await handleConnectEvent(event('charge.refunded', { id: 'ch_1', payment_intent: 'pi_123', amount_refunded: 10_000, refunded: false }), deps)).toBe('refund_logged')
    expect(db.tables.payment_request[0]).toMatchObject({ status: 'paid', amount_refunded_cents: 10_000 })
    expect(await handleConnectEvent(event('charge.refunded', { id: 'ch_1', payment_intent: 'pi_123', amount_refunded: 60_000, refunded: true }), deps)).toBe('refund_logged')
    expect(db.tables.payment_request[0]).toMatchObject({ status: 'refunded', amount_refunded_cents: 60_000 })
    expect(hoisted.queued).toHaveLength(0)
    expect(db.tables.stripe_connect_event.filter((e) => e.outcome === 'refund_logged')).toHaveLength(2)
  })

  it('a dispute is logged on the request and in the event log; a won one leaves it paid', async () => {
    const db = seed()
    const deps = await paid(db)
    expect(await handleConnectEvent(event('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_123', status: 'needs_response', reason: 'fraudulent', amount: 60_000 }), deps)).toBe('dispute_logged')
    expect(db.tables.payment_request[0]).toMatchObject({ status: 'disputed', dispute_status: 'needs_response' })
    expect(db.tables.stripe_connect_event.at(-1)?.summary).toMatchObject({ disputeStatus: 'needs_response', reason: 'fraudulent' })
    expect(await handleConnectEvent(event('charge.dispute.closed', { id: 'dp_1', payment_intent: 'pi_123', status: 'won' }), deps)).toBe('dispute_logged')
    expect(db.tables.payment_request[0]).toMatchObject({ status: 'paid', dispute_status: 'won' })
    expect(hoisted.queued).toHaveLength(0)
  })

  it('a refund on another account’s payment intent touches nothing', async () => {
    const db = seed()
    const deps = await paid(db)
    expect(await handleConnectEvent(event('charge.refunded', { id: 'ch_1', payment_intent: 'pi_123', amount_refunded: 60_000, refunded: true }, { account: 'acct_attacker99' }), deps)).toBe('unknown_payment')
    expect(db.tables.payment_request[0].status).toBe('paid')
  })
})

describe('account events', () => {
  it('account.updated re-reads the account from Stripe, and the ready text is claimed once', async () => {
    const db = seed()
    const stripe = fakeStripe()
    const deps = connectWebhookDeps(db.client, stripe as never)
    expect(await handleConnectEvent(event('account.updated', { id: OWNER_ACCOUNT }), deps)).toBe('account_synced')
    expect(stripe.accounts.retrieve).toHaveBeenCalledWith(OWNER_ACCOUNT)
    expect(db.tables.stripe_connect_account[0]).toMatchObject({ status: 'ready', charges_enabled: true })
    expect(db.tables.stripe_connect_account[0].ready_notified_at).toBeTruthy()
    expect((hoisted.notified[0] as { becameReady: boolean }).becameReady).toBe(true)
    await handleConnectEvent(event('account.updated', { id: OWNER_ACCOUNT }), deps)
    expect((hoisted.notified[1] as { becameReady: boolean }).becameReady).toBe(false)
  })

  it('an account still missing details stays onboarding', async () => {
    const db = seed()
    const deps = connectWebhookDeps(db.client, fakeStripe({ charges_enabled: false, details_submitted: false, requirements: { currently_due: ['external_account'], past_due: [] } as never }) as never)
    await handleConnectEvent(event('account.updated', { id: OWNER_ACCOUNT }), deps)
    expect(db.tables.stripe_connect_account[0]).toMatchObject({ status: 'onboarding', ready_notified_at: null })
  })

  it('the owner removing Dial8 marks the account disconnected', async () => {
    const db = seed()
    const deps = connectWebhookDeps(db.client, fakeStripe() as never)
    expect(await handleConnectEvent(event('account.application.deauthorized', { id: 'ca_x' }), deps)).toBe('account_disconnected')
    expect(db.tables.stripe_connect_account[0]).toMatchObject({ status: 'disconnected', charges_enabled: false })
  })

  it('an account Dial8 does not know is logged, not acted on', async () => {
    const db = seed()
    const deps = connectWebhookDeps(db.client, fakeStripe() as never)
    expect(await handleConnectEvent(event('account.updated', { id: 'acct_unknown1' }, { account: 'acct_unknown1' }), deps)).toBe('unknown_account')
  })
})
