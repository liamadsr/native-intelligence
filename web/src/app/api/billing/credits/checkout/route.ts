import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { getStripe, safeCheckoutOrigin } from '@/lib/stripe'

const ALLOWED_AMOUNTS = [5, 10, 25, 50] as const
type AllowedAmount = (typeof ALLOWED_AMOUNTS)[number]

function isAllowedAmount(n: number): n is AllowedAmount {
  return (ALLOWED_AMOUNTS as readonly number[]).includes(n)
}

/**
 * Create a Stripe Checkout session for buying AI credits.
 *
 * Body: { amount_usd: 5 | 10 | 25 | 50 }
 *
 * On payment success, the stripe webhook (`checkout.session.completed` with
 * mode='payment' and metadata.purpose='ai_credits_topup') creates a credit
 * grant in Stripe. The `billing.credit_grant.created` webhook then mirrors
 * the new balance into ai_user_credits.
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

  let body: { amount_usd?: unknown }
  try {
    body = (await request.json()) as { amount_usd?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const amountUsd = Number(body.amount_usd)
  if (!isAllowedAmount(amountUsd)) {
    return NextResponse.json(
      { error: `amount_usd must be one of ${ALLOWED_AMOUNTS.join(', ')}` },
      { status: 400 },
    )
  }

  try {
    const stripe = getStripe()

    // Reuse existing Stripe customer if we have one (from prior subscription
    // or earlier credit purchase). Otherwise create a new one and remember it.
    let stripeCustomerId: string | undefined

    const service = getServiceClient()
    const { data: existingCredits } = await service
      .from('ai_user_credits')
      .select('stripe_customer_id')
      .eq('user_id', user.id)
      .maybeSingle()

    if (existingCredits?.stripe_customer_id) {
      stripeCustomerId = existingCredits.stripe_customer_id
    } else {
      const { data: prevSub } = await supabase
        .from('subscriptions')
        .select('stripe_customer_id')
        .eq('user_id', user.id)
        .not('stripe_customer_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (prevSub?.stripe_customer_id) {
        stripeCustomerId = prevSub.stripe_customer_id
      } else {
        const customer = await stripe.customers.create({
          email: user.email,
          metadata: { supabase_user_id: user.id },
        })
        stripeCustomerId = customer.id
      }
    }

    const origin = safeCheckoutOrigin(request.headers.get('origin'))

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer: stripeCustomerId,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: amountUsd * 100,
            product_data: {
              name: `Dial8 AI credits — $${amountUsd}`,
              description: `$${amountUsd} of AI usage credits`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${origin}/account/settings/billing?credits_added=1`,
      cancel_url: `${origin}/account/settings/billing`,
      metadata: {
        purpose: 'ai_credits_topup',
        user_id: user.id,
        credit_amount_usd: String(amountUsd),
      },
    })

    return NextResponse.json({ url: session.url })
  } catch (err) {
    console.error('Credits checkout session creation failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create checkout session' },
      { status: 500 },
    )
  }
}
