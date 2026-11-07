/**
 * The Connect webhook routes at the edge (roadmap C2): the snapshot endpoint
 * and the v2 thin-event destination. Signed with Stripe's own scheme (the
 * real SDK verifies), they fail closed with no secret, refuse a bad
 * signature, drop a platform (non-Connect) event and any event from the mode
 * Connect isn't running in, and answer 500 on a store failure so Stripe
 * retries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'

const hoisted = vi.hoisted(() => ({
  handle: vi.fn(async (): Promise<string> => 'paid'),
  deps: {
    beginEvent: vi.fn(async () => true),
    finishEvent: vi.fn(async () => {}),
    syncAccount: vi.fn(async (): Promise<{ workspaceId: string } | null> => ({ workspaceId: 'ws-1' })),
  },
}))

const stripe = new Stripe('sk_test_dummy')
vi.mock('@/lib/stripe', () => ({ getStripe: () => stripe }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))
vi.mock('@/lib/payments/webhook', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/payments/webhook')>()),
  handleConnectEvent: hoisted.handle,
}))
vi.mock('@/lib/payments/webhook-store', () => ({ connectWebhookDeps: () => hoisted.deps }))

import { POST as snapshotPOST } from '../route'
import { POST as thinPOST } from '../v2/route'

const SECRET = 'whsec_test_connect'
const V2_SECRET = 'whsec_test_connect_v2'
const env = { ...process.env }

function signed(url: string, payload: string, secret = SECRET, signature?: string) {
  const header = signature ?? stripe.webhooks.generateTestHeaderString({ payload, secret })
  return new Request(url, { method: 'POST', headers: { 'stripe-signature': header, 'content-type': 'application/json' }, body: payload })
}

const snapshot = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', account: 'acct_owner123', livemode: false, created: 1, data: { object: { id: 'cs_1', payment_link: 'plink_1' } }, ...over })

const thin = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    id: 'evt_thin_1',
    object: 'v2.core.event',
    type: 'v2.core.account[requirements].updated',
    livemode: false,
    created: '2026-11-02T15:00:00.000Z',
    related_object: { id: 'acct_owner123', type: 'v2.core.account', url: '/v2/core/accounts/acct_owner123' },
    ...over,
  })

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_platform'
  process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET
  process.env.STRIPE_CONNECT_V2_WEBHOOK_SECRET = V2_SECRET
  delete process.env.STRIPE_CONNECT_LIVE
  hoisted.handle.mockClear()
  hoisted.handle.mockResolvedValue('paid')
  hoisted.deps.beginEvent.mockClear()
  hoisted.deps.beginEvent.mockResolvedValue(true)
  hoisted.deps.syncAccount.mockClear()
  hoisted.deps.finishEvent.mockClear()
})
afterEach(() => {
  process.env = { ...env }
})

describe('POST /api/webhooks/stripe-connect', () => {
  const url = 'http://localhost:3000/api/webhooks/stripe-connect'

  it('hands a verified connected-account event to the handler', async () => {
    const res = await snapshotPOST(signed(url, snapshot()))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ received: true, outcome: 'paid' })
    expect(hoisted.handle).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt_1', account: 'acct_owner123' }), hoisted.deps)
  })

  it('fails closed with no secret, and refuses a missing or bad signature', async () => {
    delete process.env.STRIPE_CONNECT_WEBHOOK_SECRET
    expect((await snapshotPOST(signed(url, snapshot()))).status).toBe(503)
    process.env.STRIPE_CONNECT_WEBHOOK_SECRET = SECRET
    expect((await snapshotPOST(signed(url, snapshot(), 'whsec_someone_else'))).status).toBe(400)
    expect((await snapshotPOST(new Request(url, { method: 'POST', body: snapshot() }))).status).toBe(400)
    expect(hoisted.handle).not.toHaveBeenCalled()
  })

  it('a platform event (no connected account) is not handled here', async () => {
    const res = await snapshotPOST(signed(url, snapshot({ account: undefined })))
    expect(await res.json()).toEqual({ received: true, outcome: 'not_connect' })
    expect(hoisted.handle).not.toHaveBeenCalled()
  })

  it('a live event while live Connect is off (and a test event under live) is never acted on', async () => {
    expect(await (await snapshotPOST(signed(url, snapshot({ livemode: true })))).json()).toEqual({ received: true, outcome: 'mode_off' })
    process.env.STRIPE_SECRET_KEY = 'sk_live_platform'
    process.env.STRIPE_CONNECT_LIVE = '1'
    expect(await (await snapshotPOST(signed(url, snapshot({ livemode: false })))).json()).toEqual({ received: true, outcome: 'mode_off' })
    expect(hoisted.handle).not.toHaveBeenCalled()
  })

  it('a store failure answers 500 so Stripe retries', async () => {
    hoisted.handle.mockRejectedValueOnce(new Error('db down'))
    expect((await snapshotPOST(signed(url, snapshot()))).status).toBe(500)
  })
})

describe('POST /api/webhooks/stripe-connect/v2', () => {
  const url = 'http://localhost:3000/api/webhooks/stripe-connect/v2'

  it('re-reads the account a verified thin event names, once', async () => {
    const res = await thinPOST(signed(url, thin(), V2_SECRET))
    expect(await res.json()).toEqual({ received: true, outcome: 'account_synced' })
    expect(hoisted.deps.beginEvent).toHaveBeenCalledWith({ id: 'evt_thin_1', type: 'v2.core.account[requirements].updated', account: 'acct_owner123', livemode: false })
    expect(hoisted.deps.syncAccount).toHaveBeenCalledWith('acct_owner123')
    expect(hoisted.deps.finishEvent).toHaveBeenCalledWith('evt_thin_1', { outcome: 'account_synced', workspaceId: 'ws-1' })

    hoisted.deps.beginEvent.mockResolvedValueOnce(false)
    expect(await (await thinPOST(signed(url, thin(), V2_SECRET))).json()).toEqual({ received: true, outcome: 'duplicate' })
    expect(hoisted.deps.syncAccount).toHaveBeenCalledTimes(1)
  })

  it('refuses the snapshot endpoint’s secret, and ignores other event types', async () => {
    expect((await thinPOST(signed(url, thin(), SECRET))).status).toBe(400)
    expect(await (await thinPOST(signed(url, thin({ type: 'v2.core.event_destination.ping' }), V2_SECRET))).json()).toEqual({ received: true, outcome: 'ignored' })
    expect(hoisted.deps.syncAccount).not.toHaveBeenCalled()
  })

  it('fails closed with no secret', async () => {
    delete process.env.STRIPE_CONNECT_V2_WEBHOOK_SECRET
    expect((await thinPOST(signed(url, thin(), V2_SECRET))).status).toBe(503)
  })
})
