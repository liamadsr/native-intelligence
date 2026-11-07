import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient, getAdminEnv } from '@/lib/admin'
import { getStripeForEnv } from '@/lib/stripe'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const supabase = await getAdminServiceClient()

  // Fetch the subscription record
  const { data: subscription, error: fetchError } = await supabase
    .from('subscriptions')
    .select('id, stripe_subscription_id, status')
    .eq('id', id)
    .single()

  if (fetchError || !subscription) {
    return NextResponse.json({ error: 'Subscription not found' }, { status: 404 })
  }

  if (subscription.status === 'canceled') {
    return NextResponse.json({ error: 'Subscription already canceled' }, { status: 400 })
  }

  const isGranted = !!subscription.stripe_subscription_id?.startsWith('granted_')

  // If it has a real Stripe subscription, cancel it there
  if (subscription.stripe_subscription_id && !isGranted) {
    const env = await getAdminEnv()
    const stripe = getStripeForEnv(env)

    if (!stripe) {
      return NextResponse.json(
        { error: `Stripe secret key not configured for ${env} environment` },
        { status: 500 },
      )
    }

    try {
      await stripe.subscriptions.update(subscription.stripe_subscription_id, {
        cancel_at_period_end: true,
      })
    } catch (stripeError: unknown) {
      const message = stripeError instanceof Error ? stripeError.message : 'Unknown Stripe error'
      return NextResponse.json(
        { error: `Stripe cancellation failed: ${message}` },
        { status: 500 },
      )
    }
  }

  // Update the database. A granted (complimentary) row has no Stripe sub and
  // no period end, so nothing would ever flip it to canceled: end it now.
  const { error: updateError } = await supabase
    .from('subscriptions')
    .update(
      isGranted
        ? { cancel_at_period_end: true, status: 'canceled', current_period_end: new Date().toISOString() }
        : { cancel_at_period_end: true },
    )
    .eq('id', id)

  if (updateError) {
    return NextResponse.json({ error: updateError.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
