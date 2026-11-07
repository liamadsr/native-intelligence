import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient, getAdminEnv } from '@/lib/admin'
import { getStripeForEnv } from '@/lib/stripe'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const body = await request.json()
  const { status, refunded_at } = body

  if (!status || typeof status !== 'string') {
    return NextResponse.json({ error: 'status is required' }, { status: 400 })
  }

  const supabase = await getAdminServiceClient()

  // If refunding, issue actual Stripe refund first
  if (status === 'refunded') {
    // Fetch the purchase to get the Stripe payment intent ID
    const { data: purchase, error: fetchError } = await supabase
      .from('purchases')
      .select('stripe_payment_intent_id, status')
      .eq('id', id)
      .single()

    if (fetchError || !purchase) {
      return NextResponse.json({ error: 'Purchase not found' }, { status: 404 })
    }

    if (purchase.status === 'refunded') {
      return NextResponse.json({ error: 'Purchase already refunded' }, { status: 400 })
    }

    if (purchase.stripe_payment_intent_id) {
      const env = await getAdminEnv()
      const stripe = getStripeForEnv(env)

      if (!stripe) {
        return NextResponse.json(
          { error: `Stripe secret key not configured for ${env} environment` },
          { status: 500 },
        )
      }

      try {
        await stripe.refunds.create({
          payment_intent: purchase.stripe_payment_intent_id,
        })
      } catch (stripeError: unknown) {
        const message = stripeError instanceof Error ? stripeError.message : 'Unknown Stripe error'
        return NextResponse.json(
          { error: `Stripe refund failed: ${message}` },
          { status: 500 },
        )
      }
    }
  }

  // Update the database record
  const updateData: Record<string, unknown> = { status }
  if (refunded_at) {
    updateData.refunded_at = refunded_at
  }

  const { data, error } = await supabase
    .from('purchases')
    .update(updateData)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ purchase: data })
}
