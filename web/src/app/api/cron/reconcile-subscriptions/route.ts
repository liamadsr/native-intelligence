import { NextResponse, type NextRequest } from 'next/server'
import { createStatelessClient } from '@/lib/supabase/stateless'
import * as Sentry from '@sentry/nextjs'
import { getStripe } from '@/lib/stripe'
import { requireCronSecret } from '@/lib/api-auth'
import { fetchAllRows } from '@/lib/supabase/paging'

/**
 * GET /api/cron/reconcile-subscriptions
 *
 * Self-heals subscription state (P1-5). Webhooks can be missed (delivery
 * failure, deploy gap), which previously left a canceled subscriber with an
 * $8/mo allowance forever, and left `current_period_end` stale (the renewal
 * webhook wrote the just-ended period). This job re-reads every real Stripe
 * subscription daily and syncs status + current period; it downgrades users
 * whose subscription Stripe reports as canceled/unpaid, and alerts on any drift
 * (drift means a webhook was missed).
 *
 * Admin-granted subscriptions (stripe_subscription_id LIKE 'granted_%') are
 * skipped — they have no Stripe object.
 *
 * Schedule: daily from the server's cron.
 */
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const supabase = createStatelessClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )
  const stripe = getStripe()

  // Paged by id: one response stops at 1000 rows, and the unordered tail past
  // it was never checked against Stripe.
  const { data: subs, error } = await fetchAllRows(() =>
    supabase
      .from('subscriptions')
      .select('id, stripe_subscription_id, user_id, status, current_period_end')
      .not('stripe_subscription_id', 'like', 'granted_%'),
  )

  if (error) {
    console.error('[reconcile-subscriptions] load failed:', error)
    return NextResponse.json({ error: 'Load failed', detail: error.message }, { status: 500 })
  }

  const [{ data: subPlan }, { data: defaultPlan }] = await Promise.all([
    supabase.from('ai_plan_definitions').select('id').eq('purchase_action', 'subscription').limit(1).maybeSingle(),
    supabase.from('ai_plan_definitions').select('id').eq('is_default', true).limit(1).maybeSingle(),
  ])

  let checked = 0
  let drifted = 0
  let downgraded = 0

  // A user can hold several subscription rows (cancel + resubscribe). Decide
  // their plan once from ALL rows (any live row wins), not per row in scan
  // order, where a stale canceled row could downgrade a paying user.
  const userActive = new Map<string, boolean>()
  const userUnknown = new Set<string>()
  const markUser = (userId: string, active: boolean) =>
    userActive.set(userId, (userActive.get(userId) ?? false) || active)

  for (const sub of subs) {
    checked += 1
    try {
      const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id)
      const status = stripeSub.status
      const item = stripeSub.items?.data?.[0] as { current_period_start?: number; current_period_end?: number } | undefined
      const periodEnd = (stripeSub as unknown as { current_period_end?: number }).current_period_end
        ?? item?.current_period_end
      const periodStart = (stripeSub as unknown as { current_period_start?: number }).current_period_start
        ?? item?.current_period_start

      const newEnd = periodEnd ? new Date(periodEnd * 1000).toISOString() : null
      const statusChanged = status !== sub.status
      // Compare as epoch millis: Postgres returns '+00:00'-style timestamps
      // while toISOString() produces '.000Z', so string equality would flag
      // every subscription as drifted on every run.
      const storedEndMs = sub.current_period_end ? new Date(sub.current_period_end).getTime() : null
      const endChanged = (periodEnd ? periodEnd * 1000 : null) !== storedEndMs
      if (statusChanged || endChanged) drifted += 1

      await supabase
        .from('subscriptions')
        .update({
          status,
          current_period_start: periodStart ? new Date(periodStart * 1000).toISOString() : undefined,
          current_period_end: newEnd ?? undefined,
          cancel_at_period_end: stripeSub.cancel_at_period_end,
        })
        .eq('stripe_subscription_id', sub.stripe_subscription_id)

      markUser(sub.user_id, status === 'active' || status === 'trialing')
    } catch (err) {
      // A missing subscription (404) means Stripe forgot it — treat as canceled.
      const code = (err as { code?: string })?.code
      if (code === 'resource_missing' && defaultPlan?.id) {
        await supabase.from('subscriptions').update({ status: 'canceled' }).eq('stripe_subscription_id', sub.stripe_subscription_id)
        markUser(sub.user_id, false)
        drifted += 1
      } else {
        // Unknown state for this row: leave the user's plan alone this run.
        userUnknown.add(sub.user_id)
        console.error('[reconcile-subscriptions] retrieve failed:', sub.stripe_subscription_id, err)
      }
    }
  }

  // Never touch a plan an admin pinned (admin_override takes priority over
  // subscription status) or one backed by a live granted (comp) subscription.
  const userIds = [...userActive.keys()].filter((id) => !userUnknown.has(id))
  const skipPlan = new Set<string>()
  for (let i = 0; i < userIds.length; i += 200) {
    const chunk = userIds.slice(i, i + 200)
    const [{ data: overrides }, { data: granted }] = await Promise.all([
      supabase.from('ai_user_plans').select('user_id').in('user_id', chunk).eq('admin_override', true),
      supabase
        .from('subscriptions')
        .select('user_id')
        .in('user_id', chunk)
        .like('stripe_subscription_id', 'granted_%')
        .in('status', ['active', 'trialing']),
    ])
    for (const row of [...(overrides ?? []), ...(granted ?? [])]) skipPlan.add(row.user_id as string)
  }

  // Re-assign plan to match Stripe's truth, once per user.
  for (const userId of userIds) {
    if (skipPlan.has(userId)) continue
    const active = userActive.get(userId) === true
    if (active && subPlan?.id) {
      await supabase
        .from('ai_user_plans')
        .upsert({ user_id: userId, plan_id: subPlan.id, is_active: true, admin_override: false }, { onConflict: 'user_id' })
    } else if (!active && defaultPlan?.id) {
      await supabase
        .from('ai_user_plans')
        .upsert({ user_id: userId, plan_id: defaultPlan.id, is_active: true, admin_override: false }, { onConflict: 'user_id' })
      downgraded += 1
    }
  }

  if (drifted > 0) {
    // Drift means webhooks were missed — worth knowing about.
    Sentry.captureMessage(`[reconcile-subscriptions] drift detected: ${drifted} of ${checked} subscriptions`, 'warning')
  }

  return NextResponse.json({ success: true, checked, drifted, downgraded })
}
