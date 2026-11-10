/**
 * The platform fee (default zero, optional per workspace) and the payment
 * link Native Intelligence makes on the owner's connected account (a direct charge, one
 * completed checkout).
 */
import { describe, expect, it, vi } from 'vitest'
import { applicationFeeCents, NO_PLATFORM_FEE, platformFeeOf } from '../fees'
import { createPaymentLink, paymentLinkParams } from '../payment-links'
import { memDb } from './mem-db'

const base = {
  requestId: 'req-1',
  workspaceId: 'ws-1',
  subjectType: 'quote' as const,
  subjectId: 'quote-1',
  description: 'Rug wash, 8x10 wool',
  amountCents: 60_000,
  currency: 'usd',
  origin: 'https://nativeintelligence.dev',
}

describe('the platform fee', () => {
  it('defaults to zero: no fee on any amount', () => {
    expect(NO_PLATFORM_FEE).toEqual({ bps: 0, cents: 0 })
    expect(applicationFeeCents(60_000)).toBe(0)
    expect(applicationFeeCents(60_000, platformFeeOf(null))).toBe(0)
    expect(applicationFeeCents(60_000, platformFeeOf({ application_fee_bps: 0, application_fee_cents: 0 }))).toBe(0)
  })

  it('takes an optional per-workspace fee: basis points plus fixed cents, rounded down', () => {
    expect(applicationFeeCents(60_000, { bps: 100, cents: 0 })).toBe(600) // 1% of $600
    expect(applicationFeeCents(60_000, { bps: 0, cents: 30 })).toBe(30)
    expect(applicationFeeCents(1_999, { bps: 250, cents: 0 })).toBe(49) // 49.975 → 49
    expect(applicationFeeCents(60_000, { bps: 290, cents: 30 })).toBe(1_770)
  })

  it('never takes the whole payment, and ignores junk', () => {
    expect(applicationFeeCents(50, { bps: 2000, cents: 10_000 })).toBe(49)
    expect(platformFeeOf({ application_fee_bps: -5, application_fee_cents: 1.5 })).toEqual({ bps: 0, cents: 0 })
    expect(platformFeeOf({ application_fee_bps: 99_999, application_fee_cents: 99_999 })).toEqual({ bps: 2000, cents: 10_000 })
    expect(applicationFeeCents(0, { bps: 100, cents: 30 })).toBe(0)
  })
})

describe('the payment link params', () => {
  it('sends NO application_fee_amount at the zero default', () => {
    const { params, applicationFeeCents: fee } = paymentLinkParams({ ...base, fee: NO_PLATFORM_FEE })
    expect(fee).toBe(0)
    expect(params).not.toHaveProperty('application_fee_amount')
  })

  it('sends the fee when the workspace has one', () => {
    const { params, applicationFeeCents: fee } = paymentLinkParams({ ...base, fee: { bps: 100, cents: 0 } })
    expect(fee).toBe(600)
    expect(params.application_fee_amount).toBe(600)
  })

  it('is one amount, one completed checkout, tied back by metadata on the link and its payment intent', () => {
    const { params } = paymentLinkParams({ ...base, fee: NO_PLATFORM_FEE })
    expect(params.line_items).toEqual([{ price_data: { currency: 'usd', unit_amount: 60_000, product_data: { name: 'Rug wash, 8x10 wool' } }, quantity: 1 }])
    expect(params.restrictions).toEqual({ completed_sessions: { limit: 1 } })
    const meta = { dial8_payment_request_id: 'req-1', dial8_workspace_id: 'ws-1', dial8_subject_type: 'quote', dial8_subject_id: 'quote-1' }
    expect(params.metadata).toEqual(meta)
    expect(params.payment_intent_data?.metadata).toEqual(meta)
    expect(params.after_completion).toEqual({ type: 'redirect', redirect: { url: 'https://nativeintelligence.dev/payments/paid' } })
  })
})

describe('createPaymentLink', () => {
  function fakeStripe(over: { create?: () => Promise<unknown> } = {}) {
    return {
      paymentLinks: {
        create: vi.fn(over.create ?? (async () => ({ id: 'plink_123', url: 'https://buy.stripe.com/test_123' }))),
        update: vi.fn(async () => ({})),
      },
    }
  }
  const args = {
    workspaceId: 'ws-1',
    createdBy: 'user-1',
    contactId: 'contact-1',
    subjectType: 'quote' as const,
    subjectId: 'quote-1',
    actionId: 'action-1',
    description: 'Rug wash',
    amountCents: 60_000,
    stripeAccountId: 'acct_owner123',
    livemode: false,
    fee: NO_PLATFORM_FEE,
    origin: 'https://nativeintelligence.dev',
  }

  it('makes the link ON the connected account (a direct charge) and stores it', async () => {
    const db = memDb()
    const stripe = fakeStripe()
    const result = await createPaymentLink(db.client, stripe as never, args)
    expect(result.ok).toBe(true)
    const [params, options] = stripe.paymentLinks.create.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>]
    expect(options).toMatchObject({ stripeAccount: 'acct_owner123' })
    expect(String(options.idempotencyKey)).toMatch(/^dial8-payment-link-/)
    expect(params).not.toHaveProperty('application_fee_amount')
    expect(db.tables.payment_request[0]).toMatchObject({ status: 'open', stripe_payment_link_id: 'plink_123', url: 'https://buy.stripe.com/test_123', application_fee_cents: 0, action_id: 'action-1' })
  })

  it('stores the fee it charged when the workspace has one', async () => {
    const db = memDb()
    const result = await createPaymentLink(db.client, fakeStripe() as never, { ...args, fee: { bps: 250, cents: 30 } })
    expect(result.ok).toBe(true)
    expect(db.tables.payment_request[0].application_fee_cents).toBe(1_530)
  })

  it('a link Stripe refused leaves the request cancelled, never open', async () => {
    const db = memDb()
    const result = await createPaymentLink(db.client, fakeStripe({ create: async () => { throw new Error('no card_payments') } }) as never, args)
    expect(result.ok).toBe(false)
    expect(db.tables.payment_request[0].status).toBe('cancelled')
  })
})
