import { pickSubscriptionRow, type SubscriptionRow } from '@/app/api/billing/status/pick-subscription'
import { isAdminEmail } from '@/lib/admin-emails'

/**
 * Who may use the app — the single answer behind the trial wall.
 *
 * Every account needs one of:
 *   • a Stripe subscription that is `trialing` (7-day card-backed trial) or
 *     `active` ($99/user/month), or
 *   • a complimentary `granted_%` subscription row — issued by an admin, or
 *     self-issued by a person who was invited from the admin console and chose
 *     "continue without adding a card" (see /api/billing/invite-access), or
 *   • the ChatGPT free tier: a "Continue with ChatGPT" connection with the
 *     plan grant (migrations 404/407, docs/plans/chatgpt-free-tier.md). Their
 *     AI runs on their own ChatGPT plan, so it costs Native Intelligence nothing. An
 *     `exhausted` plan still lets them in (AI just stops and says so); a
 *     subscription, when present, wins.
 *
 * `subscriptions` is per USER (auth.users.id); seats are per person, so a
 * teammate joining a paying workspace still needs their own trial.
 *
 * STAFF (the admins the ADMIN_EMAILS env var names, lib/admin-emails.ts, the
 * list isAuthorizedAdmin reads; never a whole domain: security review
 * 2026-10-31) are exempt: they never see the wall. Employees do not buy seats
 * in their own product. On the hosted service the SQL gate exempts the same
 * people by address (check_ai_usage_limit, migration 468;
 * src/lib/__tests__/admin-emails-sql.test.ts pins its list).
 *
 * The AI usage gate (check_ai_usage_limit, migration 243) enforces the same
 * rule for every API path — desktop, MCP, cron — with `subscription_required`.
 * This module is what the web app consults to decide whether to show the
 * dashboard or the start-trial page, and what that page should offer.
 *
 * CLIENT-SAFE: the trial page (a client component) imports the constants
 * and types from here, so nothing in this file may touch the server
 * Supabase client, Resend, or anything else Node-only. The loader that does
 * lives in ./access.server.ts.
 */

export const TRIAL_DAYS = 7
export const SEAT_PRICE_USD = 99

export type BillingState =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'none'
  /** The ChatGPT free tier: no subscription, AI on the person's own ChatGPT plan. */
  | 'chatgpt'

/** chatgpt_plan_status() for the signed-in person (migration 409). */
export type ChatGptPlanStatus = 'active' | 'exhausted' | 'revoked' | null

/** Billing-exempt staff: exactly the admins (ADMIN_EMAILS, a leaf, so this module stays client-safe). */
export function isNiStaff(email: string | null | undefined): boolean {
  return isAdminEmail(email)
}

export interface BillingAccess {
  state: BillingState
  /** True for trialing/active (including complimentary rows). */
  allowed: boolean
  /** ISO date the trial converts (trialing) or the period renews/cancels. */
  periodEnd: string | null
  cancelAtPeriodEnd: boolean
  /** False for complimentary `granted_%` rows — nothing to manage in Stripe. */
  hasStripe: boolean
  /** A real Stripe subscription (trial or paid) has existed before — no second free trial. */
  hasUsedTrial: boolean
  /** Signed up through an admin invite → may skip the card. */
  canSkipPayment: boolean
  /** Native Intelligence staff (ADMIN_EMAILS) — exempt from billing entirely. */
  staff: boolean
}

export function isGrantedSubscriptionId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith('granted_')
}

/** Pure classification — everything the page and the layout gate need. */
export function classifyBillingAccess(
  rows: SubscriptionRow[] | null | undefined,
  opts: { invitedByAdmin: boolean; email?: string | null; chatgptPlan?: ChatGptPlanStatus },
  now: Date = new Date(),
): BillingAccess {
  const access = classifySubscription(rows, opts, now)
  // A subscription that lets them in wins; otherwise the ChatGPT free tier
  // does (the same order as check_ai_usage_limit, migration 409).
  if (!access.allowed && (opts.chatgptPlan === 'active' || opts.chatgptPlan === 'exhausted')) {
    return { ...access, state: 'chatgpt', allowed: true }
  }
  return access
}

function classifySubscription(
  rows: SubscriptionRow[] | null | undefined,
  opts: { invitedByAdmin: boolean; email?: string | null },
  now: Date,
): BillingAccess {
  const hasUsedTrial = (rows ?? []).some((r) => !isGrantedSubscriptionId(r.stripe_subscription_id))
  const picked = pickSubscriptionRow(rows, now)
  const base = {
    hasUsedTrial,
    canSkipPayment: opts.invitedByAdmin,
    staff: isNiStaff(opts.email),
  }

  if (base.staff) {
    return { ...base, state: 'active', allowed: true, periodEnd: null, cancelAtPeriodEnd: false, hasStripe: false }
  }

  if (!picked) {
    return { ...base, state: 'none', allowed: false, periodEnd: null, cancelAtPeriodEnd: false, hasStripe: false }
  }

  const hasStripe = !isGrantedSubscriptionId(picked.stripe_subscription_id)
  const common = {
    ...base,
    periodEnd: picked.current_period_end,
    cancelAtPeriodEnd: !!picked.cancel_at_period_end,
    hasStripe,
  }

  if (picked.status === 'trialing') return { ...common, state: 'trialing', allowed: true }
  if (picked.status === 'active') return { ...common, state: 'active', allowed: true }
  if (picked.status === 'past_due' || picked.status === 'unpaid') {
    return { ...common, state: 'past_due', allowed: false }
  }
  return { ...common, state: 'none', allowed: false }
}

/** The day a trial started now would convert, formatted for copy ("September 9"). */
export function trialConversionDateLabel(now: Date = new Date()): string {
  return new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
  })
}

/** Days until `iso`, rounded up, never negative. */
export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number {
  if (!iso) return 0
  const ms = new Date(iso).getTime() - now.getTime()
  return ms > 0 ? Math.ceil(ms / (24 * 60 * 60 * 1000)) : 0
}
