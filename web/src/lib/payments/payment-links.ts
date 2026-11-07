/**
 * A payment link for a quote or job (roadmap C2, migration 459,
 * payment_request): a Stripe Payment Link made ON the owner's connected
 * account (a direct charge: the owner is the merchant of record, the money
 * lands in their balance, Stripe takes its processing fee from them), for one
 * amount, that works for ONE completed checkout and then switches itself off.
 *
 * A Payment Link rather than a Checkout Session because a customer may pay
 * days later: a session expires within a day, a link doesn't.
 *
 * The platform fee is the workspace's (./fees.ts), default 0: at 0 no
 * application_fee_amount is sent at all.
 *
 * Every id that ties the payment back (the request, the workspace, the
 * subject) rides in the link's metadata and the payment intent's, so the
 * webhook finds the request from either event.
 *
 * Server only; service role.
 */
import type Stripe from 'stripe'
import type { SupabaseClient } from '@supabase/supabase-js'
import { applicationFeeCents, type PlatformFee } from './fees'
import { PAYMENTS_PATHS } from './config'

export const PAYMENT_SUBJECT_TYPES = ['quote', 'booking', 'action', 'job'] as const
export type PaymentSubjectType = (typeof PAYMENT_SUBJECT_TYPES)[number]

export const PAYMENT_REQUEST_STATUSES = ['open', 'paid', 'refunded', 'disputed', 'cancelled'] as const
export type PaymentRequestStatus = (typeof PAYMENT_REQUEST_STATUSES)[number]

/** The table's amount range (459): $0.50 (Stripe's US minimum) to $50,000. */
export const MIN_AMOUNT_CENTS = 50
export const MAX_AMOUNT_CENTS = 5_000_000

/** The metadata keys on the link and its payment intent. */
export const META = {
  request: 'dial8_payment_request_id',
  workspace: 'dial8_workspace_id',
  subjectType: 'dial8_subject_type',
  subjectId: 'dial8_subject_id',
} as const

export interface PaymentRequest {
  id: string
  workspaceId: string
  createdBy: string | null
  contactId: string | null
  subjectType: PaymentSubjectType
  subjectId: string | null
  actionId: string | null
  description: string
  amountCents: number
  currency: string
  applicationFeeCents: number
  stripeAccountId: string
  stripePaymentLinkId: string | null
  url: string | null
  status: PaymentRequestStatus
  paidAt: string | null
}

export interface PaymentRequestRow {
  id: string
  workspace_id: string
  created_by: string | null
  contact_id: string | null
  subject_type: string
  subject_id: string | null
  action_id: string | null
  description: string
  amount_cents: number
  currency: string
  application_fee_cents: number
  stripe_account_id: string
  stripe_payment_link_id: string | null
  url: string | null
  status: string
  paid_at: string | null
}

export const PAYMENT_REQUEST_COLUMNS =
  'id, workspace_id, created_by, contact_id, subject_type, subject_id, action_id, description, amount_cents, currency, application_fee_cents, stripe_account_id, stripe_payment_link_id, url, status, paid_at'

export function toPaymentRequest(row: PaymentRequestRow): PaymentRequest {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    createdBy: row.created_by,
    contactId: row.contact_id,
    subjectType: (PAYMENT_SUBJECT_TYPES as readonly string[]).includes(row.subject_type) ? (row.subject_type as PaymentSubjectType) : 'job',
    subjectId: row.subject_id,
    actionId: row.action_id,
    description: row.description,
    amountCents: row.amount_cents,
    currency: row.currency,
    applicationFeeCents: row.application_fee_cents,
    stripeAccountId: row.stripe_account_id,
    stripePaymentLinkId: row.stripe_payment_link_id,
    url: row.url,
    status: (PAYMENT_REQUEST_STATUSES as readonly string[]).includes(row.status) ? (row.status as PaymentRequestStatus) : 'open',
    paidAt: row.paid_at,
  }
}

/** "$600.00" (USD) or "600.00 EUR". Pure. */
export function formatAmount(cents: number, currency = 'usd'): string {
  const whole = (cents / 100).toFixed(2)
  return currency.toLowerCase() === 'usd' ? `$${whole}` : `${whole} ${currency.toUpperCase()}`
}

/**
 * What goes to Stripe for one link. Pure, so the tests can pin the fee rule:
 * no application_fee_amount at all when the fee is 0.
 */
export function paymentLinkParams(args: {
  requestId: string
  workspaceId: string
  subjectType: PaymentSubjectType
  subjectId: string | null
  description: string
  amountCents: number
  currency: string
  fee: PlatformFee
  origin: string
}): { params: Stripe.PaymentLinkCreateParams; applicationFeeCents: number } {
  const metadata: Record<string, string> = {
    [META.request]: args.requestId,
    [META.workspace]: args.workspaceId,
    [META.subjectType]: args.subjectType,
    ...(args.subjectId ? { [META.subjectId]: args.subjectId } : {}),
  }
  const fee = applicationFeeCents(args.amountCents, args.fee)
  const params: Stripe.PaymentLinkCreateParams = {
    line_items: [
      {
        price_data: {
          currency: args.currency,
          unit_amount: args.amountCents,
          product_data: { name: args.description.slice(0, 200) },
        },
        quantity: 1,
      },
    ],
    metadata,
    payment_intent_data: { metadata, description: args.description.slice(0, 200) },
    restrictions: { completed_sessions: { limit: 1 } },
    inactive_message: 'This payment link has already been paid.',
    after_completion: { type: 'redirect', redirect: { url: `${args.origin}${PAYMENTS_PATHS.paid}` } },
    ...(fee > 0 ? { application_fee_amount: fee } : {}),
  }
  return { params, applicationFeeCents: fee }
}

export type CreatePaymentLinkResult = { ok: true; request: PaymentRequest } | { ok: false; error: string }

/**
 * Store the request, then make its link on the connected account and store
 * the link. A link Stripe made but we failed to store is switched off again,
 * so no payable link exists that the webhook can't tie back.
 */
export async function createPaymentLink(
  supabase: SupabaseClient,
  stripe: Stripe,
  args: {
    workspaceId: string
    createdBy: string
    contactId: string | null
    subjectType: PaymentSubjectType
    subjectId: string | null
    actionId: string | null
    description: string
    amountCents: number
    currency?: string
    stripeAccountId: string
    livemode: boolean
    fee: PlatformFee
    origin: string
  },
): Promise<CreatePaymentLinkResult> {
  const currency = (args.currency ?? 'usd').toLowerCase()
  const { data: inserted, error: insertError } = await supabase
    .from('payment_request')
    .insert({
      workspace_id: args.workspaceId,
      created_by: args.createdBy,
      contact_id: args.contactId,
      subject_type: args.subjectType,
      subject_id: args.subjectId,
      action_id: args.actionId,
      description: args.description,
      amount_cents: args.amountCents,
      currency,
      application_fee_cents: applicationFeeCents(args.amountCents, args.fee),
      stripe_account_id: args.stripeAccountId,
      livemode: args.livemode,
      status: 'open',
    })
    .select(PAYMENT_REQUEST_COLUMNS)
    .single<PaymentRequestRow>()
  if (insertError || !inserted) return { ok: false, error: `payment_request insert failed: ${insertError?.message ?? 'no row'}` }

  const { params } = paymentLinkParams({
    requestId: inserted.id,
    workspaceId: args.workspaceId,
    subjectType: args.subjectType,
    subjectId: args.subjectId,
    description: args.description,
    amountCents: args.amountCents,
    currency,
    fee: args.fee,
    origin: args.origin,
  })

  let link: Stripe.PaymentLink
  try {
    link = await stripe.paymentLinks.create(params, { stripeAccount: args.stripeAccountId, idempotencyKey: `dial8-payment-link-${inserted.id}` })
  } catch (err) {
    await supabase.from('payment_request').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', inserted.id)
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }

  const { data: updated, error: updateError } = await supabase
    .from('payment_request')
    .update({ stripe_payment_link_id: link.id, url: link.url, updated_at: new Date().toISOString() })
    .eq('id', inserted.id)
    .select(PAYMENT_REQUEST_COLUMNS)
    .single<PaymentRequestRow>()
  if (updateError || !updated) {
    await stripe.paymentLinks.update(link.id, { active: false }, { stripeAccount: args.stripeAccountId }).catch(() => undefined)
    await supabase.from('payment_request').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', inserted.id)
    return { ok: false, error: `payment_request update failed: ${updateError?.message ?? 'no row'}` }
  }
  return { ok: true, request: toPaymentRequest(updated) }
}

/** Record who the link went to and how. */
export async function markSent(
  supabase: SupabaseClient,
  requestId: string,
  sent: { phone: string | null; email: string | null; via: Array<'text' | 'email'> },
): Promise<void> {
  await supabase
    .from('payment_request')
    .update({ sent_to_phone: sent.phone, sent_to_email: sent.email, sent_via: sent.via, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', requestId)
}

/** An open request for the same subject: one live link per quote or job. */
export async function findOpenRequestFor(
  supabase: SupabaseClient,
  workspaceId: string,
  subjectType: PaymentSubjectType,
  subjectId: string,
): Promise<PaymentRequest | null> {
  const { data } = await supabase
    .from('payment_request')
    .select(PAYMENT_REQUEST_COLUMNS)
    .eq('workspace_id', workspaceId)
    .eq('subject_type', subjectType)
    .eq('subject_id', subjectId)
    .in('status', ['open', 'paid'])
    .order('created_at', { ascending: false })
    .limit(1)
  const row = (data as PaymentRequestRow[] | null)?.[0]
  return row ? toPaymentRequest(row) : null
}
