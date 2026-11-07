import type { SupabaseClient } from '@supabase/supabase-js'
import type Stripe from 'stripe'

/**
 * Mirror of the Stripe webhook's subscription handling
 * (supabase/functions/stripe-webhook/index.ts), for the one moment the app
 * cannot wait on a webhook: the redirect back from Checkout. The user is
 * standing on /account/start-trial; if the trial row is not in `subscriptions`
 * yet they would be bounced straight back to the wall. So the confirm route
 * writes the same row the webhook will — the upsert is keyed on
 * stripe_subscription_id, so whichever lands second is a no-op.
 */

export function subscriptionPeriod(sub: Stripe.Subscription): { start: string | null; end: string | null } {
  const legacy = sub as unknown as { current_period_start?: number | null; current_period_end?: number | null }
  const item = sub.items?.data?.[0] as unknown as
    | { current_period_start?: number | null; current_period_end?: number | null }
    | undefined
  const start = legacy.current_period_start ?? item?.current_period_start ?? null
  const end = legacy.current_period_end ?? item?.current_period_end ?? null
  return {
    start: start ? new Date(start * 1000).toISOString() : null,
    end: end ? new Date(end * 1000).toISOString() : null,
  }
}

export async function upsertSubscriptionFromStripe(
  service: SupabaseClient,
  userId: string,
  sub: Stripe.Subscription,
): Promise<{ error: string | null }> {
  const period = subscriptionPeriod(sub)
  const { error } = await service.from('subscriptions').upsert(
    {
      user_id: userId,
      stripe_subscription_id: sub.id,
      stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id ?? null,
      status: sub.status,
      current_period_start: period.start,
      current_period_end: period.end,
      cancel_at_period_end: sub.cancel_at_period_end,
    },
    { onConflict: 'stripe_subscription_id' },
  )
  return { error: error?.message ?? null }
}

/** Put the user on the subscriber AI plan (what the webhook does on activation). */
export async function assignSubscriberPlan(service: SupabaseClient, userId: string): Promise<void> {
  const { data: plan } = await service
    .from('ai_plan_definitions')
    .select('id')
    .eq('purchase_action', 'subscription')
    .limit(1)
    .maybeSingle()
  if (!plan) return
  await service
    .from('ai_user_plans')
    .upsert({ user_id: userId, plan_id: plan.id, is_active: true, admin_override: false }, { onConflict: 'user_id' })
}
