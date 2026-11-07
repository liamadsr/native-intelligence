import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getStripe, safeCheckoutOrigin } from '@/lib/stripe'
import { classifyBillingAccess, TRIAL_DAYS } from '@/lib/billing/access'
import type { SubscriptionRow } from '@/app/api/billing/status/pick-subscription'

/**
 * Start a Stripe Checkout for the $99/user/month seat.
 *
 * FIRST subscription for this user → a 7-day free trial with the card
 * collected up front (`payment_method_collection: 'always'`), converting to
 * the paid price automatically. Stripe cancels the subscription instead of
 * charging if a payment method is somehow missing at trial end.
 *
 * Anyone who has held a real Stripe subscription before (a canceled trial, a
 * lapsed seat) gets no second trial: the Checkout charges immediately.
 *
 * Body (optional): { return: 'start-trial' | 'billing' } — where Stripe sends
 * the user back. The success URL carries the Checkout session id so the page
 * can confirm the subscription without waiting on the webhook.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return NextResponse.json({ error: 'Authentication required' }, { status: 401 })
  }

  let returnTo: 'start-trial' | 'billing' = 'billing'
  try {
    const body = await request.json()
    if (body?.return === 'start-trial') returnTo = 'start-trial'
  } catch {
    // No body is fine.
  }

  const { data: rows } = await supabase
    .from('subscriptions')
    .select('status, stripe_subscription_id, stripe_customer_id, current_period_start, current_period_end, cancel_at_period_end, created_at')
    .eq('user_id', user.id)
  const access = classifyBillingAccess(rows as SubscriptionRow[] | null, { invitedByAdmin: false, email: user.email })

  if (access.allowed) {
    return NextResponse.json({ error: 'You already have an active subscription' }, { status: 400 })
  }

  const { data: subscriberPlan } = await supabase
    .from('ai_plan_definitions')
    .select('stripe_price_id')
    .eq('name', 'subscriber')
    .single()

  if (!subscriberPlan?.stripe_price_id) {
    return NextResponse.json(
      { error: 'No Stripe price configured for the subscriber plan' },
      { status: 500 },
    )
  }

  try {
    const stripe = getStripe()

    let stripeCustomerId: string | undefined
    const prev = (rows ?? []).find((r) => r.stripe_customer_id)
    if (prev?.stripe_customer_id) {
      stripeCustomerId = prev.stripe_customer_id
    } else {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { supabase_user_id: user.id },
      })
      stripeCustomerId = customer.id
    }

    const origin = safeCheckoutOrigin(request.headers.get('origin'))
    const successUrl =
      returnTo === 'start-trial'
        ? `${origin}/account/start-trial?session_id={CHECKOUT_SESSION_ID}`
        : `${origin}/account/settings/billing?upgraded=1&session_id={CHECKOUT_SESSION_ID}`
    const cancelUrl =
      returnTo === 'start-trial' ? `${origin}/account/start-trial` : `${origin}/account/settings/billing`

    const withTrial = !access.hasUsedTrial

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: subscriberPlan.stripe_price_id, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      payment_method_collection: 'always',
      subscription_data: {
        metadata: { user_id: user.id },
        ...(withTrial
          ? {
              trial_period_days: TRIAL_DAYS,
              trial_settings: { end_behavior: { missing_payment_method: 'cancel' } },
            }
          : {}),
      },
      metadata: { user_id: user.id, trial: withTrial ? 'yes' : 'no' },
    })

    return NextResponse.json({ url: session.url, trial: withTrial })
  } catch (err) {
    console.error('Checkout session creation failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create checkout session' },
      { status: 500 },
    )
  }
}
