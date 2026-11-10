import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { getStripe } from '@/lib/stripe'
import { connectAvailability, connectV2WebhookSecret } from '@/lib/payments/config'
import { ACCOUNT_THIN_EVENTS } from '@/lib/payments/webhook'
import { connectWebhookDeps } from '@/lib/payments/webhook-store'

/**
 * The Accounts v2 event destination (roadmap C1): thin events about the
 * accounts Native Intelligence made, signed with STRIPE_CONNECT_V2_WEBHOOK_SECRET. A thin
 * event carries no state, so each one just re-reads the account from Stripe
 * (the "payments are on" text goes out once, from whoever reads it ready
 * first). Accounts v2 sends these instead of v1 account.updated.
 *
 * Subscribe it to: v2.core.account.updated, v2.core.account[requirements].updated,
 * v2.core.account[configuration.merchant].updated,
 * v2.core.account[configuration.merchant].capability_status_updated.
 */
export async function POST(request: Request) {
  const secret = connectV2WebhookSecret()
  if (!secret) return NextResponse.json({ error: 'Connect v2 webhook not configured' }, { status: 503 })
  const signature = request.headers.get('stripe-signature')
  if (!signature) return NextResponse.json({ error: 'Missing signature' }, { status: 400 })
  const raw = await request.text()

  const stripe = getStripe()
  let notification: { id: string; type: string; livemode?: boolean; related_object?: { id?: string | null } | null }
  try {
    notification = stripe.parseEventNotification(raw, signature, secret) as unknown as typeof notification
  } catch {
    return NextResponse.json({ error: 'Bad signature' }, { status: 400 })
  }
  if (!ACCOUNT_THIN_EVENTS.has(notification.type)) return NextResponse.json({ received: true, outcome: 'ignored' })
  const availability = connectAvailability()
  if (!availability.ok || !!notification.livemode !== availability.livemode) return NextResponse.json({ received: true, outcome: 'mode_off' })
  const accountId = notification.related_object?.id ?? null
  if (!accountId) return NextResponse.json({ received: true, outcome: 'ignored' })

  const deps = connectWebhookDeps(getServiceClient(), stripe)
  try {
    const fresh = await deps.beginEvent({ id: notification.id, type: notification.type, account: accountId, livemode: !!notification.livemode })
    if (!fresh) return NextResponse.json({ received: true, outcome: 'duplicate' })
    const synced = await deps.syncAccount(accountId)
    const outcome = synced ? 'account_synced' : 'unknown_account'
    await deps.finishEvent(notification.id, { outcome, workspaceId: synced?.workspaceId ?? null })
    return NextResponse.json({ received: true, outcome })
  } catch (err) {
    console.error('[stripe-connect] v2 event failed:', notification.type, notification.id, err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 })
  }
}
