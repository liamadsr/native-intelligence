/**
 * The Connect webhook (roadmap C2): Stripe's events about payments on the
 * owners' connected accounts, already signature-checked by the route
 * (src/app/api/webhooks/stripe-connect/route.ts), handled here once each.
 *
 *   checkout.session.completed (paid), checkout.session.async_payment_succeeded
 *       → the payment request is paid: claimed once (open → paid), then the
 *         follow-ups are queued (./paid.ts: close its to-do, note it on the
 *         CRM contact, text the owner, the `job.paid` agent event and track
 *         D's `job/completed`).
 *   charge.refunded, charge.dispute.created / .updated / .closed
 *       → LOGGED (the event row, and the refund or dispute fields on the
 *         request). Nothing acts on them: no text, no turn, no Stripe call.
 *         The owner runs refunds and disputes from their own Stripe Dashboard.
 *   account.updated → the account is re-read from Stripe (./accounts.ts).
 *   account.application.deauthorized → the account is marked disconnected.
 *
 * Trust: a payment is tied back ONLY by the payment link id Dial8 stored when
 * it made the link, and only when the event comes from the account that link
 * was made on. Metadata is never trusted alone: an owner can put any metadata
 * on a link in their own Dashboard, so a forged `dial8_payment_request_id` on
 * someone else's account must not mark another workspace's job paid.
 *
 * Idempotency: the event id is the stripe_connect_event row's key. A replay
 * of a processed event does nothing; a retry of one that failed midway
 * re-runs it, and every step is safe to re-run (the paid claim is
 * conditional; the follow-ups queue dedupes on the request).
 *
 * Pure over {@link ConnectWebhookDeps}.
 */
import type Stripe from 'stripe'

export type WebhookOutcome =
  | 'duplicate'
  | 'paid'
  | 'already_paid'
  | 'awaiting_async_payment'
  | 'async_payment_failed'
  | 'refund_logged'
  | 'dispute_logged'
  | 'account_synced'
  | 'account_disconnected'
  | 'unknown_payment'
  | 'unknown_account'
  | 'ignored'

export interface PaidRequest {
  id: string
  workspaceId: string
  stripeAccountId: string
  amountCents: number
  status: string
  paidFollowupsQueuedAt: string | null
}

export interface ConnectWebhookDeps {
  /** Insert the event row; false when it already exists AND was processed (a replay). */
  beginEvent(event: { id: string; type: string; account: string | null; livemode: boolean }): Promise<boolean>
  finishEvent(eventId: string, result: { outcome: WebhookOutcome; workspaceId?: string | null; paymentRequestId?: string | null; summary?: Record<string, unknown> }): Promise<void>
  /** The request Dial8 made this payment link for, on this account. */
  findRequestByPaymentLink(stripeAccountId: string, paymentLinkId: string): Promise<PaidRequest | null>
  /** The request a payment intent paid, on this account. */
  findRequestByPaymentIntent(stripeAccountId: string, paymentIntentId: string): Promise<PaidRequest | null>
  /** open → paid, once. Returns the request when THIS call claimed it. */
  claimPaid(requestId: string, paid: { checkoutSessionId: string; paymentIntentId: string | null; amountPaidCents: number | null; paidAt: string }): Promise<PaidRequest | null>
  /** Queue the paid follow-ups (deduped on the request) and stamp paid_followups_queued_at. */
  queuePaidFollowups(request: PaidRequest): Promise<void>
  recordRefund(requestId: string, refund: { amountRefundedCents: number; fully: boolean; at: string }): Promise<void>
  recordDispute(requestId: string, dispute: { status: string; at: string; opened: boolean; closedWon: boolean }): Promise<void>
  syncAccount(stripeAccountId: string): Promise<{ workspaceId: string } | null>
  disconnectAccount(stripeAccountId: string): Promise<string | null>
  now?: () => number
}

function idOf(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null
  return typeof value === 'string' ? value : value.id ?? null
}

async function onCheckoutPaid(event: Stripe.Event, session: Stripe.Checkout.Session, deps: ConnectWebhookDeps) {
  const account = event.account ?? null
  const linkId = idOf(session.payment_link)
  if (!account || !linkId) return { outcome: 'ignored' as const }
  const request = await deps.findRequestByPaymentLink(account, linkId)
  if (!request) return { outcome: 'unknown_payment' as const, summary: { paymentLink: linkId } }

  if (session.payment_status !== 'paid') {
    // A delayed method (a bank debit): paid only on async_payment_succeeded.
    return { outcome: 'awaiting_async_payment' as const, workspaceId: request.workspaceId, paymentRequestId: request.id }
  }

  const paidAt = new Date((event.created ?? Math.floor((deps.now ?? Date.now)() / 1000)) * 1000).toISOString()
  const claimed = await deps.claimPaid(request.id, {
    checkoutSessionId: session.id,
    paymentIntentId: idOf(session.payment_intent),
    amountPaidCents: typeof session.amount_total === 'number' ? session.amount_total : null,
    paidAt,
  })
  const summary = { amountTotal: session.amount_total ?? null, currency: session.currency ?? null, expected: request.amountCents }
  if (claimed) {
    await deps.queuePaidFollowups(claimed)
    return { outcome: 'paid' as const, workspaceId: request.workspaceId, paymentRequestId: request.id, summary }
  }
  // Already paid: a retry whose follow-ups never got queued queues them now.
  if (request.status === 'paid' && !request.paidFollowupsQueuedAt) await deps.queuePaidFollowups(request)
  return { outcome: 'already_paid' as const, workspaceId: request.workspaceId, paymentRequestId: request.id, summary }
}

async function onRefund(event: Stripe.Event, charge: Stripe.Charge, deps: ConnectWebhookDeps) {
  const account = event.account ?? null
  const intent = idOf(charge.payment_intent)
  if (!account || !intent) return { outcome: 'ignored' as const }
  const request = await deps.findRequestByPaymentIntent(account, intent)
  if (!request) return { outcome: 'unknown_payment' as const, summary: { paymentIntent: intent } }
  const at = new Date((deps.now ?? Date.now)()).toISOString()
  const refunded = charge.amount_refunded ?? 0
  await deps.recordRefund(request.id, { amountRefundedCents: refunded, fully: !!charge.refunded, at })
  return { outcome: 'refund_logged' as const, workspaceId: request.workspaceId, paymentRequestId: request.id, summary: { amountRefunded: refunded, fully: !!charge.refunded } }
}

async function onDispute(event: Stripe.Event, dispute: Stripe.Dispute, deps: ConnectWebhookDeps) {
  const account = event.account ?? null
  const intent = idOf(dispute.payment_intent)
  if (!account || !intent) return { outcome: 'ignored' as const }
  const request = await deps.findRequestByPaymentIntent(account, intent)
  if (!request) return { outcome: 'unknown_payment' as const, summary: { paymentIntent: intent } }
  const at = new Date((deps.now ?? Date.now)()).toISOString()
  await deps.recordDispute(request.id, {
    status: String(dispute.status ?? 'unknown').slice(0, 40),
    at,
    opened: event.type === 'charge.dispute.created',
    closedWon: event.type === 'charge.dispute.closed' && dispute.status === 'won',
  })
  return {
    outcome: 'dispute_logged' as const,
    workspaceId: request.workspaceId,
    paymentRequestId: request.id,
    summary: { disputeStatus: dispute.status ?? null, reason: dispute.reason ?? null, amount: dispute.amount ?? null },
  }
}

/** Handle one verified snapshot event from a connected account. Throws on a store failure (the route answers 500 so Stripe retries). */
export async function handleConnectEvent(event: Stripe.Event, deps: ConnectWebhookDeps): Promise<WebhookOutcome> {
  const fresh = await deps.beginEvent({ id: event.id, type: event.type, account: event.account ?? null, livemode: !!event.livemode })
  if (!fresh) return 'duplicate'

  let result: { outcome: WebhookOutcome; workspaceId?: string | null; paymentRequestId?: string | null; summary?: Record<string, unknown> }
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      result = await onCheckoutPaid(event, event.data.object as Stripe.Checkout.Session, deps)
      break
    case 'checkout.session.async_payment_failed': {
      // Logged with its request. Nothing changes: a resend checks the link is still live (send-link.ts).
      const session = event.data.object as Stripe.Checkout.Session
      const linkId = idOf(session.payment_link)
      const request = event.account && linkId ? await deps.findRequestByPaymentLink(event.account, linkId) : null
      result = request ? { outcome: 'async_payment_failed', workspaceId: request.workspaceId, paymentRequestId: request.id } : { outcome: 'async_payment_failed' }
      break
    }
    case 'charge.refunded':
      result = await onRefund(event, event.data.object as Stripe.Charge, deps)
      break
    case 'charge.dispute.created':
    case 'charge.dispute.updated':
    case 'charge.dispute.closed':
      result = await onDispute(event, event.data.object as Stripe.Dispute, deps)
      break
    case 'account.updated': {
      const synced = event.account ? await deps.syncAccount(event.account) : null
      result = synced ? { outcome: 'account_synced', workspaceId: synced.workspaceId } : { outcome: 'unknown_account' }
      break
    }
    case 'account.application.deauthorized': {
      const workspaceId = event.account ? await deps.disconnectAccount(event.account) : null
      result = workspaceId ? { outcome: 'account_disconnected', workspaceId } : { outcome: 'unknown_account' }
      break
    }
    default:
      result = { outcome: 'ignored' }
  }
  await deps.finishEvent(event.id, result)
  return result.outcome
}

/** The v2 thin events that mean "re-read this account". */
export const ACCOUNT_THIN_EVENTS: ReadonlySet<string> = new Set([
  'v2.core.account.updated',
  'v2.core.account[requirements].updated',
  'v2.core.account[configuration.merchant].updated',
  'v2.core.account[configuration.merchant].capability_status_updated',
])
