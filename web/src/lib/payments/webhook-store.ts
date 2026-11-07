/**
 * The Connect webhook's reads and writes (./webhook.ts ConnectWebhookDeps),
 * over the service client and the platform's Stripe client.
 *
 * Server only.
 */
import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { markDisconnected, syncConnectedAccount } from './accounts'
import { notifyIfReady } from './setup'
import { queuePaidFollowups } from './paid'
import type { ConnectWebhookDeps, PaidRequest } from './webhook'

interface RequestRow {
  id: string
  workspace_id: string
  stripe_account_id: string
  amount_cents: number
  amount_refunded_cents?: number
  status: string
  paid_followups_queued_at: string | null
}

const COLUMNS = 'id, workspace_id, stripe_account_id, amount_cents, status, paid_followups_queued_at'

function toPaid(row: RequestRow): PaidRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    stripeAccountId: row.stripe_account_id,
    amountCents: row.amount_cents,
    status: row.status,
    paidFollowupsQueuedAt: row.paid_followups_queued_at,
  }
}

function clip(value: string | null, max: number): string | null {
  return value ? value.slice(0, max) : null
}

export function connectWebhookDeps(supabase: SupabaseClient, stripe: Stripe): ConnectWebhookDeps {
  return {
    async beginEvent(event) {
      const { error } = await supabase.from('stripe_connect_event').insert({
        event_id: event.id,
        type: event.type.slice(0, 120),
        stripe_account_id: clip(event.account, 255),
        livemode: event.livemode,
      })
      if (!error) return true
      if (error.code !== '23505') throw new Error(`stripe_connect_event insert failed: ${error.message}`)
      // Seen before: a replay of a processed event does nothing; one that failed midway runs again.
      const { data } = await supabase.from('stripe_connect_event').select('processed_at').eq('event_id', event.id).maybeSingle<{ processed_at: string | null }>()
      return !data?.processed_at
    },

    async finishEvent(eventId, result) {
      const { error } = await supabase
        .from('stripe_connect_event')
        .update({
          outcome: result.outcome,
          workspace_id: result.workspaceId ?? null,
          payment_request_id: result.paymentRequestId ?? null,
          summary: result.summary ?? {},
          processed_at: new Date().toISOString(),
        })
        .eq('event_id', eventId)
      if (error) throw new Error(`stripe_connect_event update failed: ${error.message}`)
    },

    async findRequestByPaymentLink(stripeAccountId, paymentLinkId) {
      const { data, error } = await supabase
        .from('payment_request')
        .select(COLUMNS)
        .eq('stripe_payment_link_id', paymentLinkId)
        .eq('stripe_account_id', stripeAccountId)
        .maybeSingle<RequestRow>()
      if (error) throw new Error(`payment_request read failed: ${error.message}`)
      return data ? toPaid(data) : null
    },

    async findRequestByPaymentIntent(stripeAccountId, paymentIntentId) {
      const { data, error } = await supabase
        .from('payment_request')
        .select(COLUMNS)
        .eq('stripe_payment_intent_id', paymentIntentId)
        .eq('stripe_account_id', stripeAccountId)
        .maybeSingle<RequestRow>()
      if (error) throw new Error(`payment_request read failed: ${error.message}`)
      return data ? toPaid(data) : null
    },

    async claimPaid(requestId, paid) {
      const { data, error } = await supabase
        .from('payment_request')
        .update({
          status: 'paid',
          paid_at: paid.paidAt,
          stripe_checkout_session_id: paid.checkoutSessionId,
          stripe_payment_intent_id: paid.paymentIntentId,
          amount_paid_cents: paid.amountPaidCents,
          updated_at: new Date().toISOString(),
        })
        .eq('id', requestId)
        .eq('status', 'open')
        .select(COLUMNS)
      if (error) throw new Error(`payment_request paid failed: ${error.message}`)
      const row = (data as RequestRow[] | null)?.[0]
      return row ? toPaid(row) : null
    },

    async queuePaidFollowups(request) {
      await queuePaidFollowups(supabase, request)
    },

    async recordRefund(requestId, refund) {
      const { error } = await supabase
        .from('payment_request')
        .update({
          amount_refunded_cents: refund.amountRefundedCents,
          refunded_at: refund.at,
          ...(refund.fully ? { status: 'refunded' } : {}),
          updated_at: refund.at,
        })
        .eq('id', requestId)
      if (error) throw new Error(`payment_request refund log failed: ${error.message}`)
    },

    async recordDispute(requestId, dispute) {
      const { error } = await supabase
        .from('payment_request')
        .update({
          dispute_status: dispute.status,
          ...(dispute.opened ? { disputed_at: dispute.at, status: 'disputed' } : {}),
          // A dispute the owner won leaves the payment theirs again.
          ...(dispute.closedWon ? { status: 'paid' } : {}),
          updated_at: dispute.at,
        })
        .eq('id', requestId)
      if (error) throw new Error(`payment_request dispute log failed: ${error.message}`)
    },

    async syncAccount(stripeAccountId) {
      const synced = await syncConnectedAccount(supabase, stripeAccountId, { retrieve: (id) => stripe.accounts.retrieve(id) })
      if (!synced) return null
      await notifyIfReady(supabase, synced)
      return { workspaceId: synced.account.workspaceId }
    },

    async disconnectAccount(stripeAccountId) {
      return markDisconnected(supabase, stripeAccountId)
    },
  }
}
