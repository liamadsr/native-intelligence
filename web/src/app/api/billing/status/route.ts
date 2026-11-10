import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { pickSubscriptionRow, type SubscriptionRow } from './pick-subscription'
import { isNiStaff } from '@/lib/billing/access'

export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  // Fetch subscription, plan, usage, and credit balance in parallel
  const [
    { data: subscriptionRows },
    { data: userPlan },
    { data: plans },
    { data: credits },
  ] = await Promise.all([
    // All rows, not newest-first limit 1: a canceled row can be newer than an
    // active one, and granted + real Stripe rows coexist. pickSubscriptionRow
    // applies the same preference order the SQL (mig 199) uses.
    supabase
      .from('subscriptions')
      .select('status, stripe_subscription_id, stripe_customer_id, current_period_start, current_period_end, cancel_at_period_end, created_at')
      .eq('user_id', user.id),
    supabase
      .from('ai_user_plans')
      .select('current_period_cost_usd, current_period_tokens, current_period_requests, usage_reset_date, ai_plan_definitions(name, display_name, monthly_cost_limit_usd, description, feature_highlights)')
      .eq('user_id', user.id)
      .maybeSingle(),
    supabase
      .from('ai_plan_definitions')
      .select('name, display_name, description, feature_highlights, price_display, price_subtext, monthly_cost_limit_usd, stripe_price_id, badge_text, sort_order')
      .eq('is_visible', true)
      .order('sort_order', { ascending: true }),
    supabase
      .from('ai_user_credits')
      .select('balance_usd, lifetime_granted_usd, lifetime_consumed_usd, last_synced_at')
      .eq('user_id', user.id)
      .maybeSingle(),
  ])

  // Determine effective plan
  const subscription = pickSubscriptionRow(
    subscriptionRows as SubscriptionRow[] | null,
  )
  const staff = isNiStaff(user.email)
  const subscriptionActive =
    !!subscription && ['active', 'trialing'].includes(subscription.status)
  // Staff are entitled without a subscription row (see lib/billing/access).
  const hasActiveSubscription = staff || subscriptionActive

  // Trial = a Stripe subscription in `trialing` (7-day card-backed trial,
  // migration 243). The old signup-date trial is gone: there is no free tier.
  const trialActive = !!subscription && subscription.status === 'trialing'
  const trialEnd = trialActive && subscription!.current_period_end
    ? new Date(subscription!.current_period_end)
    : null
  const trialDaysRemaining = trialEnd
    ? Math.max(0, Math.ceil((trialEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000)))
    : 0
  const planDef = (userPlan?.ai_plan_definitions as any) as Record<string, unknown> | null

  let effectivePlan: string
  let costLimit: number | null

  if (hasActiveSubscription) {
    effectivePlan = 'subscriber'
    // Use the actual subscriber plan limit from the DB, fall back to the stored plan limit
    costLimit = planDef?.monthly_cost_limit_usd as number | null ?? null
    if (costLimit == null) {
      // Look up the subscriber plan definition directly
      const { data: subscriberPlan } = await supabase
        .from('ai_plan_definitions')
        .select('monthly_cost_limit_usd')
        .eq('name', 'subscriber')
        .single()
      costLimit = subscriberPlan?.monthly_cost_limit_usd ?? null
    }
  } else if (planDef) {
    effectivePlan = planDef.name as string
    costLimit = planDef.monthly_cost_limit_usd as number | null
  } else {
    effectivePlan = 'free'
    // Look up the default free plan limit from the DB
    const { data: freePlan } = await supabase
      .from('ai_plan_definitions')
      .select('monthly_cost_limit_usd')
      .eq('is_default', true)
      .single()
    costLimit = freePlan?.monthly_cost_limit_usd ?? null
  }

  return NextResponse.json({
    plan: {
      name: effectivePlan,
      display_name: staff
        ? 'Staff'
        : hasActiveSubscription
          ? 'Pro'
          : (planDef?.display_name as string) ?? 'Free',
      cost_limit: costLimit,
    },
    subscription: subscriptionActive
      ? {
          status: subscription!.status,
          cancel_at_period_end: subscription!.cancel_at_period_end,
          current_period_end: subscription!.current_period_end,
          has_stripe: !String(subscription!.stripe_subscription_id).startsWith('granted_'),
        }
      : null,
    usage: {
      cost_used: Number(userPlan?.current_period_cost_usd ?? 0),
      cost_limit: costLimit,
      tokens: userPlan?.current_period_tokens ?? 0,
      requests: userPlan?.current_period_requests ?? 0,
      // When the AI allowance counter next resets. Post-mig-199 this aligns to
      // the Stripe billing period for paid plans (falls back to calendar month),
      // so the UI can promise a reset date the backend actually honors.
      resets_at: userPlan?.usage_reset_date
        ? new Date(userPlan.usage_reset_date as string).toISOString()
        : null,
    },
    trial: {
      active: trialActive,
      ends_at: trialEnd ? trialEnd.toISOString() : null,
      days_remaining: trialDaysRemaining,
    },
    credits: {
      balance_usd: Number(credits?.balance_usd ?? 0),
      lifetime_granted_usd: Number(credits?.lifetime_granted_usd ?? 0),
      lifetime_consumed_usd: Number(credits?.lifetime_consumed_usd ?? 0),
    },
    plans: plans ?? [],
  })
}
