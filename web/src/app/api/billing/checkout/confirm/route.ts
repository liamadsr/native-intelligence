import { NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { getStripe } from '@/lib/stripe'
import { assignSubscriberPlan, upsertSubscriptionFromStripe } from '@/lib/billing/subscription-sync'

/**
 * Confirm a Checkout session the user just returned from and record its
 * subscription immediately (see lib/billing/subscription-sync for why this
 * does not wait for the webhook). Body: { session_id }.
 *
 * The session's `metadata.user_id` must match the caller — a session id is
 * not a secret, so this is what stops one user attaching another's trial.
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

  let sessionId: unknown
  try {
    sessionId = (await request.json())?.session_id
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 })
  }

  try {
    const stripe = getStripe()
    const session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['subscription'] })

    if (session.metadata?.user_id !== user.id) {
      return NextResponse.json({ error: 'Session does not belong to this user' }, { status: 403 })
    }
    if (session.mode !== 'subscription' || !session.subscription) {
      return NextResponse.json({ error: 'Not a subscription checkout' }, { status: 400 })
    }

    const sub =
      typeof session.subscription === 'string'
        ? await stripe.subscriptions.retrieve(session.subscription)
        : (session.subscription as Stripe.Subscription)

    const service = getServiceClient()
    const { error } = await upsertSubscriptionFromStripe(service, user.id, sub)
    if (error) {
      console.error('[checkout/confirm] upsert failed:', error)
      return NextResponse.json({ error: 'Failed to record subscription' }, { status: 500 })
    }
    if (sub.status === 'active' || sub.status === 'trialing') {
      await assignSubscriberPlan(service, user.id)
    }

    return NextResponse.json({ status: sub.status })
  } catch (err) {
    console.error('[checkout/confirm] failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to confirm checkout' },
      { status: 500 },
    )
  }
}
