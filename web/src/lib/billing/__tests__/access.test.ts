import { describe, it, expect, vi } from 'vitest'
import { classifyBillingAccess, daysUntil, isDial8Staff } from '../access'
import { ADMIN_EMAILS } from '@/lib/admin-emails'

// lib/admin's server imports, unused by isAuthorizedAdmin.
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/headers', () => ({ cookies: vi.fn() }))
const { isAuthorizedAdmin } = await import('@/lib/admin')
import type { SubscriptionRow } from '@/app/api/billing/status/pick-subscription'

const now = new Date('2026-09-02T12:00:00Z')
const future = '2026-09-09T12:00:00Z'
const past = '2026-08-01T12:00:00Z'

function row(over: Partial<SubscriptionRow>): SubscriptionRow {
  return {
    status: 'active',
    stripe_subscription_id: 'sub_123',
    stripe_customer_id: 'cus_1',
    current_period_start: past,
    current_period_end: future,
    cancel_at_period_end: false,
    created_at: past,
    ...over,
  }
}

describe('classifyBillingAccess', () => {
  it('blocks a user with no subscription rows', () => {
    const a = classifyBillingAccess([], { invitedByAdmin: false }, now)
    expect(a.state).toBe('none')
    expect(a.allowed).toBe(false)
    expect(a.hasUsedTrial).toBe(false)
    expect(a.canSkipPayment).toBe(false)
  })

  it('lets an admin-invited user skip the card', () => {
    const a = classifyBillingAccess(null, { invitedByAdmin: true }, now)
    expect(a.allowed).toBe(false)
    expect(a.canSkipPayment).toBe(true)
  })

  it('allows a trialing subscription and exposes the conversion date', () => {
    const a = classifyBillingAccess([row({ status: 'trialing' })], { invitedByAdmin: false }, now)
    expect(a.state).toBe('trialing')
    expect(a.allowed).toBe(true)
    expect(a.periodEnd).toBe(future)
    expect(a.hasStripe).toBe(true)
    expect(a.hasUsedTrial).toBe(true)
  })

  it('allows an active subscription', () => {
    expect(classifyBillingAccess([row({})], { invitedByAdmin: false }, now).state).toBe('active')
  })

  it('treats complimentary granted rows as active without Stripe', () => {
    const a = classifyBillingAccess(
      [row({ stripe_subscription_id: 'granted_invite_1', current_period_end: null, stripe_customer_id: null })],
      { invitedByAdmin: true },
      now,
    )
    expect(a.state).toBe('active')
    expect(a.allowed).toBe(true)
    expect(a.hasStripe).toBe(false)
    // A comp row is not a Stripe trial: a later real trial is still allowed.
    expect(a.hasUsedTrial).toBe(false)
  })

  it('blocks past_due and remembers the trial was used', () => {
    const a = classifyBillingAccess([row({ status: 'past_due' })], { invitedByAdmin: false }, now)
    expect(a.state).toBe('past_due')
    expect(a.allowed).toBe(false)
    expect(a.hasUsedTrial).toBe(true)
  })

  it('blocks a canceled-only user and denies a second trial', () => {
    const a = classifyBillingAccess([row({ status: 'canceled', current_period_end: past })], { invitedByAdmin: false }, now)
    expect(a.state).toBe('none')
    expect(a.allowed).toBe(false)
    expect(a.hasUsedTrial).toBe(true)
  })

  it('prefers the live row when canceled rows coexist', () => {
    const a = classifyBillingAccess(
      [row({ status: 'canceled', current_period_end: past, stripe_subscription_id: 'sub_old' }), row({ status: 'trialing' })],
      { invitedByAdmin: false },
      now,
    )
    expect(a.state).toBe('trialing')
  })
})

describe('classifyBillingAccess — Dial8 staff', () => {
  it('exempts the named admins (ADMIN_EMAILS) regardless of subscription rows', () => {
    const a = classifyBillingAccess(null, { invitedByAdmin: false, email: 'Liam@Dial8.ai' }, now)
    expect(a.staff).toBe(true)
    expect(a.state).toBe('active')
    expect(a.allowed).toBe(true)
    expect(a.hasStripe).toBe(false)
  })

  it('exempts exactly the people isAuthorizedAdmin lets in', () => {
    for (const email of [...ADMIN_EMAILS, 'toby@dial8.ai', 'new-hire@dial8.ai', 'x@gmail.com']) {
      expect(isDial8Staff(email)).toBe(isAuthorizedAdmin(email))
    }
  })

  it('no longer exempts any other @dial8.ai address (security review 2026-10-31)', () => {
    for (const email of ['toby@dial8.ai', 'new-hire@dial8.ai', 'liam+x@dial8.ai']) {
      expect(classifyBillingAccess(null, { invitedByAdmin: false, email }, now).staff).toBe(false)
    }
  })

  it('does not exempt look-alike domains', () => {
    for (const email of ['a@dial8.ai.evil.com', 'a@notdial8.ai', 'dial8.ai@gmail.com', 'liam@dial8.ai.evil.com']) {
      expect(classifyBillingAccess(null, { invitedByAdmin: false, email }, now).staff).toBe(false)
    }
  })
})

describe('daysUntil', () => {
  it('rounds up and floors at zero', () => {
    expect(daysUntil('2026-09-09T12:00:00Z', now)).toBe(7)
    expect(daysUntil('2026-09-02T18:00:00Z', now)).toBe(1)
    expect(daysUntil(past, now)).toBe(0)
    expect(daysUntil(null, now)).toBe(0)
  })
})

describe('classifyBillingAccess — the ChatGPT free tier', () => {
  it('lets a person in on an active ChatGPT plan, without a subscription', () => {
    const a = classifyBillingAccess([], { invitedByAdmin: false, chatgptPlan: 'active' }, now)
    expect(a.state).toBe('chatgpt')
    expect(a.allowed).toBe(true)
    expect(a.hasStripe).toBe(false)
  })

  it('still lets them in when the plan is out of credits (AI stops, the app does not)', () => {
    const a = classifyBillingAccess(null, { invitedByAdmin: false, chatgptPlan: 'exhausted' }, now)
    expect(a.state).toBe('chatgpt')
    expect(a.allowed).toBe(true)
  })

  it('shows the wall for a revoked connection or none', () => {
    expect(classifyBillingAccess([], { invitedByAdmin: false, chatgptPlan: 'revoked' }, now).allowed).toBe(false)
    expect(classifyBillingAccess([], { invitedByAdmin: false, chatgptPlan: null }, now).allowed).toBe(false)
  })

  it('a live subscription wins over the ChatGPT plan', () => {
    const a = classifyBillingAccess([row({ status: 'active' })], { invitedByAdmin: false, chatgptPlan: 'active' }, now)
    expect(a.state).toBe('active')
    expect(a.hasStripe).toBe(true)
  })

  it('falls back to the ChatGPT plan when the subscription lapsed', () => {
    const a = classifyBillingAccess([row({ status: 'past_due' })], { invitedByAdmin: false, chatgptPlan: 'active' }, now)
    expect(a.state).toBe('chatgpt')
    expect(a.allowed).toBe(true)
  })

  it('leaves staff as they are', () => {
    const a = classifyBillingAccess(null, { invitedByAdmin: false, email: 'liam@dial8.ai', chatgptPlan: 'exhausted' }, now)
    expect(a.state).toBe('active')
    expect(a.staff).toBe(true)
  })
})
