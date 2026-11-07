import { NextResponse } from 'next/server'
import type Stripe from 'stripe'
import { getServiceClient } from '@/lib/admin'
import { getStripe } from '@/lib/stripe'
import { connectAvailability, connectWebhookSecret } from '@/lib/payments/config'
import { handleConnectEvent } from '@/lib/payments/webhook'
import { connectWebhookDeps } from '@/lib/payments/webhook-store'

/**
 * The Connect webhook (roadmap C2): snapshot events about the owners'
 * connected accounts ("Events on Connected accounts"), signed with
 * STRIPE_CONNECT_WEBHOOK_SECRET. Dial8's own billing has its own endpoint
 * (the stripe-webhook edge function); nothing here touches it.
 *
 * Subscribe it to: checkout.session.completed,
 * checkout.session.async_payment_succeeded, checkout.session.async_payment_failed,
 * charge.refunded, charge.dispute.created, charge.dispute.updated,
 * charge.dispute.closed, account.updated, account.application.deauthorized.
 *
 * 200 once handled (or ignored), 400 for a bad signature, 503 with no secret,
 * 500 on a store failure so Stripe retries (each event is handled once:
 * src/lib/payments/webhook.ts).
 */
export async function POST(request: Request) {
  const secret = connectWebhookSecret()
  if (!secret) return NextResponse.json({ error: 'Connect webhook not configured' }, { status: 503 })
  const signature = request.headers.get('stripe-signature')
  if (!signature) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  const raw = await request.text()

  const stripe = getStripe()
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(raw, signature, secret)
  } catch {
    return NextResponse.json({ error: 'Bad signature' }, { status: 400 })
  }

  // Only events from connected accounts belong here; a live event while live
  // Connect is off is never acted on (src/lib/payments/config.ts).
  if (!event.account) return NextResponse.json({ received: true, outcome: 'not_connect' })
  const availability = connectAvailability()
  if (!availability.ok || event.livemode !== availability.livemode) return NextResponse.json({ received: true, outcome: 'mode_off' })

  try {
    const outcome = await handleConnectEvent(event, connectWebhookDeps(getServiceClient(), stripe))
    return NextResponse.json({ received: true, outcome })
  } catch (err) {
    console.error('[stripe-connect] event failed:', event.type, event.id, err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 })
  }
}
