/**
 * Connecting the owner's Stripe from a texted link (roadmap C1): the
 * single-use, 15-minute link; the Accounts v2 account it makes (full
 * Dashboard, Stripe-owned fees and losses, direct-charge merchant); Stripe
 * OAuth for an account they already have, bound to the browser that tapped
 * the link; and the one "payments are on" text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({ texts: [] as Array<{ userId: string; body: string }>, sent: true }))
vi.mock('../deliver', () => ({
  textOwner: vi.fn(async (_s: unknown, userId: string, body: string) => {
    hoisted.texts.push({ userId, body })
    return hoisted.sent ? { sent: true } : { sent: false, reason: 'no_phone' }
  }),
}))

import { consumeSetupLink, createSetupLink, peekSetupLink, SETUP_LINK_TTL_MS } from '../setup-link'
import { completeOAuth, signStripeState, startExistingAccount, startNewAccount, verifyStripeState } from '../onboarding'
import { stateOfStripeAccount, syncConnectedAccount } from '../accounts'
import { notifyIfReady, textSetupLink } from '../setup'
import { connectAvailability } from '../config'
import { SETUP_RETURN_TTL_MS, signSetupReturn, verifySetupReturn } from '../return-token'
import { memDb } from './mem-db'

const T0 = Date.parse('2026-11-02T15:00:00Z')
const TOKEN = 'abcdefghijklmnopqrstuvwx'

const env = { ...process.env }
beforeEach(() => {
  hoisted.texts.length = 0
  hoisted.sent = true
  process.env.STRIPE_SECRET_KEY = 'sk_test_platform'
  process.env.STRIPE_CONNECT_CLIENT_ID = 'ca_testclient'
  delete process.env.STRIPE_CONNECT_LIVE
})
afterEach(() => {
  process.env = { ...env }
})

describe('the setup link', () => {
  it('works once, for 15 minutes, and a peek never uses it', async () => {
    const db = memDb()
    const made = await createSetupLink(db.client, { userId: 'u1', workspaceId: 'w1', origin: 'https://nativeintelligence.dev' }, { now: () => T0, token: () => TOKEN })
    expect(made).toMatchObject({ ok: true, url: `https://nativeintelligence.dev/payments/setup/${TOKEN}`, expiresAt: new Date(T0 + SETUP_LINK_TTL_MS).toISOString() })
    expect(SETUP_LINK_TTL_MS).toBe(15 * 60_000)
    // Only the hash is stored.
    expect(JSON.stringify(db.tables.stripe_connect_link)).not.toContain(TOKEN)

    expect(await peekSetupLink(db.client, TOKEN, { now: () => T0 + 1000 })).toMatchObject({ ok: true, link: { userId: 'u1', workspaceId: 'w1' } })
    expect(await peekSetupLink(db.client, TOKEN, { now: () => T0 + 2000 })).toMatchObject({ ok: true })
    expect(await consumeSetupLink(db.client, TOKEN, { now: () => T0 + 3000 })).toMatchObject({ ok: true, link: { userId: 'u1' } })
    expect(await consumeSetupLink(db.client, TOKEN, { now: () => T0 + 4000 })).toEqual({ ok: false, reason: 'used' })
    expect(await peekSetupLink(db.client, TOKEN, { now: () => T0 + 5000 })).toEqual({ ok: false, reason: 'used' })
  })

  it('expires', async () => {
    const db = memDb()
    await createSetupLink(db.client, { userId: 'u1', workspaceId: 'w1', origin: 'https://nativeintelligence.dev' }, { now: () => T0, token: () => TOKEN })
    expect(await consumeSetupLink(db.client, TOKEN, { now: () => T0 + SETUP_LINK_TTL_MS + 1 })).toEqual({ ok: false, reason: 'expired' })
  })

  it('refuses tokens of the wrong shape before any read', async () => {
    const db = memDb()
    expect(await peekSetupLink(db.client, 'short')).toEqual({ ok: false, reason: 'not_found' })
    expect(await consumeSetupLink(db.client, `${TOKEN}'--`)).toEqual({ ok: false, reason: 'not_found' })
  })

  it('is paced per workspace: one per two minutes', async () => {
    const db = memDb()
    const first = await createSetupLink(db.client, { userId: 'u1', workspaceId: 'w1', origin: 'o' }, { now: () => T0 })
    expect(first.ok).toBe(true)
    db.tables.stripe_connect_link[0].created_at = new Date(T0).toISOString()
    expect(await createSetupLink(db.client, { userId: 'u1', workspaceId: 'w1', origin: 'o' }, { now: () => T0 + 60_000 })).toMatchObject({ ok: false, reason: 'too_soon' })
    expect((await createSetupLink(db.client, { userId: 'u1', workspaceId: 'w1', origin: 'o' }, { now: () => T0 + 3 * 60_000 })).ok).toBe(true)
  })

  it('texting it needs an owner or admin, and says what the link is for', async () => {
    const db = memDb({ member: [{ workspace_id: 'w1', user_id: 'u1', role: 'owner' }, { workspace_id: 'w1', user_id: 'u2', role: 'member' }], workspace: [{ id: 'w1', name: 'Bright Weave' }] })
    expect(await textSetupLink(db.client, { workspaceId: 'w1', userId: 'u2' })).toMatchObject({ sent: false, reason: 'not_admin' })
    const sent = await textSetupLink(db.client, { workspaceId: 'w1', userId: 'u1', origin: 'https://nativeintelligence.dev' })
    expect(sent.sent).toBe(true)
    expect(hoisted.texts[0].userId).toBe('u1')
    expect(hoisted.texts[0].body).toMatch(/^To let customers pay Bright Weave by card, connect Stripe here \(works once, for 15 minutes\): https:\/\/nativeintelligence\.dev\/payments\/setup\/[A-Za-z0-9_-]{24}$/)
  })
})

describe('the live-mode switch', () => {
  it('a test key works; a live key needs STRIPE_CONNECT_LIVE=1', () => {
    expect(connectAvailability()).toEqual({ ok: true, livemode: false })
    process.env.STRIPE_SECRET_KEY = 'sk_live_platform'
    expect(connectAvailability()).toEqual({ ok: false, reason: 'live_not_enabled' })
    process.env.STRIPE_CONNECT_LIVE = '1'
    expect(connectAvailability()).toEqual({ ok: true, livemode: true })
    delete process.env.STRIPE_SECRET_KEY
    expect(connectAvailability()).toEqual({ ok: false, reason: 'no_key' })
  })
})

describe('a new Stripe account', () => {
  function fakeStripe() {
    return {
      v2: {
        core: {
          accounts: { create: vi.fn(async () => ({ id: 'acct_new12345' })) },
          accountLinks: { create: vi.fn(async () => ({ url: 'https://connect.stripe.com/setup/s/abc' })) },
        },
      },
    }
  }

  it('is Accounts v2 with the full Dashboard, Stripe-owned fees and losses, and card payments (direct charges)', async () => {
    const db = memDb({ workspace: [{ id: 'w1', name: 'Bright Weave' }] }, {}, { users: { u1: { email: 'owner@brightweave.test' } } })
    const stripe = fakeStripe()
    const started = await startNewAccount(db.client, stripe as never, { workspaceId: 'w1', userId: 'u1', origin: 'https://nativeintelligence.dev', linkId: 'link-1', livemode: false })
    expect(started).toEqual({ ok: true, redirectUrl: 'https://connect.stripe.com/setup/s/abc' })
    const [params, options] = stripe.v2.core.accounts.create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>]
    expect(params).toMatchObject({
      contact_email: 'owner@brightweave.test',
      display_name: 'Bright Weave',
      dashboard: 'full',
      configuration: { merchant: { capabilities: { card_payments: { requested: true } } } },
      defaults: { currency: 'usd', responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' } },
      metadata: { dial8_workspace_id: 'w1' },
    })
    expect(params).not.toHaveProperty('type')
    expect(options).toEqual({ idempotencyKey: 'dial8-connect-account-link-1' })
    expect(stripe.v2.core.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_new12345',
      use_case: {
        type: 'account_onboarding',
        account_onboarding: {
          configurations: ['merchant'],
          refresh_url: expect.stringMatching(/^https:\/\/nativeintelligence\.dev\/api\/payments\/setup\/refresh\?w=w1&s=\d+\.[\w-]+$/),
          return_url: expect.stringMatching(/^https:\/\/nativeintelligence\.dev\/payments\/setup\/done\?w=w1&s=\d+\.[\w-]+$/),
          collection_options: { fields: 'currently_due' },
        },
      },
    })
    // Both carry a signature for this workspace (the page and route are public).
    const onboarding = (stripe.v2.core.accountLinks.create.mock.calls[0] as unknown as [{ use_case: { account_onboarding: { refresh_url: string; return_url: string } } }])[0].use_case.account_onboarding
    for (const url of [onboarding.refresh_url, onboarding.return_url]) {
      const q = new URL(url).searchParams
      expect(verifySetupReturn('w1', q.get('s'))).toBe(true)
      expect(verifySetupReturn('w-other', q.get('s'))).toBe(false)
    }
    expect(db.tables.stripe_connect_account[0]).toMatchObject({ workspace_id: 'w1', stripe_account_id: 'acct_new12345', linked_via: 'created', status: 'onboarding', connected_by: 'u1' })
  })

  it('a second tap continues the unfinished account instead of making another', async () => {
    const db = memDb({ stripe_connect_account: [{ workspace_id: 'w1', stripe_account_id: 'acct_existing1', linked_via: 'created', status: 'onboarding' }] })
    const stripe = fakeStripe()
    await startNewAccount(db.client, stripe as never, { workspaceId: 'w1', userId: 'u1', origin: 'https://nativeintelligence.dev', linkId: 'link-2', livemode: false })
    expect(stripe.v2.core.accounts.create).not.toHaveBeenCalled()
    expect((stripe.v2.core.accountLinks.create.mock.calls[0] as unknown[])[0]).toMatchObject({ account: 'acct_existing1' })
  })

  it('keeps the workspace’s platform fee when it re-links', async () => {
    const db = memDb({ stripe_connect_account: [{ workspace_id: 'w1', stripe_account_id: 'acct_gone1234', linked_via: 'oauth', status: 'disconnected', application_fee_bps: 100, application_fee_cents: 0 }] })
    await startNewAccount(db.client, fakeStripe() as never, { workspaceId: 'w1', userId: 'u1', origin: 'o', linkId: 'link-3', livemode: false })
    expect(db.tables.stripe_connect_account[0]).toMatchObject({ stripe_account_id: 'acct_new12345', application_fee_bps: 100, status: 'onboarding' })
  })
})

describe('an existing Stripe account (OAuth)', () => {
  const stripe = {
    oauth: {
      authorizeUrl: vi.fn((params: Record<string, unknown>) => `https://connect.stripe.com/oauth/authorize?${new URLSearchParams(params as Record<string, string>)}`),
      token: vi.fn(async () => ({ stripe_user_id: 'acct_theirs123' })),
    },
  }

  it('asks for read_write with a signed state and sets the binding cookie', () => {
    const started = startExistingAccount(stripe as never, { workspaceId: 'w1', userId: 'u1', origin: 'https://nativeintelligence.dev', linkId: 'l' }, T0)
    expect(started.ok).toBe(true)
    if (!started.ok) return
    const params = stripe.oauth.authorizeUrl.mock.calls[0][0]
    expect(params).toMatchObject({ client_id: 'ca_testclient', response_type: 'code', scope: 'read_write', redirect_uri: 'https://nativeintelligence.dev/api/payments/setup/oauth/callback' })
    expect(started.cookie?.name).toBe('stripe_connect_nonce')
    expect(verifyStripeState(params.state, started.cookie!.value, T0 + 1000)).toMatchObject({ ok: true, state: { workspaceId: 'w1', userId: 'u1' } })
  })

  it('is off without a client id', () => {
    delete process.env.STRIPE_CONNECT_CLIENT_ID
    expect(startExistingAccount(stripe as never, { workspaceId: 'w1', userId: 'u1', origin: 'o', linkId: 'l' })).toEqual({ ok: false, reason: 'oauth_off' })
  })

  it('the state is refused without the cookie, with another cookie, tampered, or late', () => {
    const state = signStripeState({ workspaceId: 'w1', userId: 'u1', nonce: 'nonce-1', exp: T0 + 60_000 })
    expect(verifyStripeState(state, 'nonce-1', T0)).toMatchObject({ ok: true })
    expect(verifyStripeState(state, null, T0)).toEqual({ ok: false, error: 'not_bound' })
    expect(verifyStripeState(state, 'nonce-2', T0)).toEqual({ ok: false, error: 'not_bound' })
    expect(verifyStripeState(state, 'nonce-1', T0 + 60_001)).toEqual({ ok: false, error: 'state_expired' })
    const [body, sig] = state.split('.')
    const forged = Buffer.from(JSON.stringify({ w: 'w-victim', u: 'u1', n: 'nonce-1', e: T0 + 60_000 })).toString('base64url')
    expect(verifyStripeState(`${forged}.${sig}`, 'nonce-1', T0)).toEqual({ ok: false, error: 'invalid_state' })
    expect(verifyStripeState(`${body}.x${sig.slice(1)}`, 'nonce-1', T0)).toEqual({ ok: false, error: 'invalid_state' })
  })

  it('completes: stores the linked account for the state’s workspace', async () => {
    const db = memDb()
    const state = signStripeState({ workspaceId: 'w1', userId: 'u1', nonce: 'n1', exp: Date.now() + 60_000 })
    const done = await completeOAuth(db.client, stripe as never, { code: 'ac_123', state, error: null, cookieNonce: 'n1', livemode: false })
    expect(done).toEqual({ ok: true, workspaceId: 'w1', stripeAccountId: 'acct_theirs123' })
    expect(db.tables.stripe_connect_account[0]).toMatchObject({ workspace_id: 'w1', stripe_account_id: 'acct_theirs123', linked_via: 'oauth', connected_by: 'u1' })
  })

  it('an account another workspace already uses is refused', async () => {
    const db = memDb(
      { stripe_connect_account: [{ workspace_id: 'w-other', stripe_account_id: 'acct_theirs123', status: 'ready' }] },
      { stripe_connect_account: [['stripe_account_id']] },
    )
    const state = signStripeState({ workspaceId: 'w1', userId: 'u1', nonce: 'n1', exp: Date.now() + 60_000 })
    expect(await completeOAuth(db.client, stripe as never, { code: 'ac_123', state, error: null, cookieNonce: 'n1', livemode: false })).toMatchObject({ ok: false, reason: 'already_linked' })
  })

  it('a cancelled consent or an unbound state stores nothing', async () => {
    const db = memDb()
    const state = signStripeState({ workspaceId: 'w1', userId: 'u1', nonce: 'n1', exp: Date.now() + 60_000 })
    expect(await completeOAuth(db.client, stripe as never, { code: null, state, error: 'access_denied', cookieNonce: 'n1', livemode: false })).toMatchObject({ ok: false, reason: 'denied' })
    expect(await completeOAuth(db.client, stripe as never, { code: 'ac', state, error: null, cookieNonce: null, livemode: false })).toMatchObject({ ok: false, reason: 'bad_state' })
    expect(db.tables.stripe_connect_account ?? []).toHaveLength(0)
  })
})

describe('the account’s status and the one confirmation text', () => {
  it('maps Stripe’s account to ours', () => {
    expect(stateOfStripeAccount({ charges_enabled: true, payouts_enabled: false, details_submitted: true, requirements: { currently_due: [] } as never }).status).toBe('ready')
    expect(stateOfStripeAccount({ charges_enabled: false, payouts_enabled: false, details_submitted: false, requirements: { currently_due: ['tos_acceptance.date'] } as never })).toMatchObject({ status: 'onboarding', needsDetails: true })
    expect(stateOfStripeAccount({ charges_enabled: false, payouts_enabled: false, details_submitted: true, requirements: { currently_due: [], disabled_reason: 'under_review' } as never }).status).toBe('restricted')
  })

  it('texts the owner once when payments turn on', async () => {
    const db = memDb({
      stripe_connect_account: [{ workspace_id: 'w1', stripe_account_id: 'acct_owner123', status: 'onboarding', connected_by: 'u1', ready_at: null, ready_notified_at: null, linked_via: 'created' }],
      workspace: [{ id: 'w1', name: 'Bright Weave' }],
    })
    const retrieve = async () => ({ charges_enabled: true, payouts_enabled: true, details_submitted: true, requirements: { currently_due: [] } as never })
    const first = await syncConnectedAccount(db.client, 'acct_owner123', { retrieve })
    expect(first?.becameReady).toBe(true)
    expect(await notifyIfReady(db.client, first!)).toBe(true)
    const second = await syncConnectedAccount(db.client, 'acct_owner123', { retrieve })
    expect(second?.becameReady).toBe(false)
    expect(await notifyIfReady(db.client, second!)).toBe(false)
    expect(hoisted.texts).toEqual([{ userId: 'u1', body: expect.stringMatching(/^Stripe is connected: customers can now pay Bright Weave by card/) }])
  })
})

describe('the signed return token (the public return page and refresh route)', () => {
  it('is bound to its workspace, expires, and refuses tampering', () => {
    const token = signSetupReturn('w1', T0)
    expect(verifySetupReturn('w1', token, T0 + 1000)).toBe(true)
    expect(verifySetupReturn('w2', token, T0 + 1000)).toBe(false)
    expect(verifySetupReturn('w1', token, T0 + SETUP_RETURN_TTL_MS + 1)).toBe(false)
    const [exp, mac] = token.split('.')
    expect(verifySetupReturn('w1', `${Number(exp) + 1}.${mac}`, T0)).toBe(false)
    expect(verifySetupReturn('w1', null, T0)).toBe(false)
    expect(verifySetupReturn('w1', 'nonsense', T0)).toBe(false)
  })
})
