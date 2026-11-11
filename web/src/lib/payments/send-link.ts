/**
 * send_payment_link's run (src/lib/ai/tools/payments.ts holds the tool and
 * its contract; this is what it does), loaded only when the tool runs so the
 * Stripe SDK and the payments code stay out of every tool set's imports.
 *
 *   1. Card payments must be on (./config.ts), and the workspace's Stripe
 *      ready. Not ready: the OWNER is texted their setup link (./setup.ts),
 *      and nothing reaches the customer.
 *   2. Ready: only the owner's approved call runs (the outward gate made the
 *      card; `approved` is true only for executeStoredCall's replay).
 *   3. Everything the call names must be this workspace's (contact, to-do,
 *      quote, booking); one live link per quote or job (an open, still active
 *      one is resent; a paid one never; one Stripe switched off is replaced).
 *   4. The Stripe Payment Link on the owner's account, then the "Get paid"
 *      to-do it closes, the text (business number) and/or email (owner's
 *      mailbox), and a note on the contact's timeline.
 *
 * The setup link is never put in the result: it is a bearer link to the
 * owner's payments, and the result is model context.
 *
 * Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getStripe } from '@/lib/stripe'
import { connectAvailability, paymentsOrigin } from './config'
import { getConnectedAccount } from './accounts'
import { createPaymentLink, findOpenRequestFor, formatAmount, markSent, type PaymentRequest } from './payment-links'
import { textSetupLink } from './setup'
import { emailCustomer, paymentEmail, paymentText, textCustomer } from './deliver'
import { createPaymentTodo, findWorkspaceAction } from './todo'
import { parsePaymentLinkCall, type PaymentLinkCall } from './tool-input'

async function contactOf(supabase: SupabaseClient, workspaceId: string, contactId: string): Promise<{ id: string; fullName: string | null } | null> {
  const { data } = await supabase.from('contact').select('id, full_name').eq('id', contactId).eq('workspace_id', workspaceId).maybeSingle<{ id: string; full_name: string | null }>()
  return data ? { id: data.id, fullName: data.full_name } : null
}

/** Track B's table for a subject, when it has one (quote, booking: a meeting_booking since migration 581). */
const SUBJECT_TABLE: Partial<Record<PaymentLinkCall['subject'], string>> = { quote: 'customer_quote', booking: 'meeting_booking' }

/** Postgres' and PostgREST's "no such table": track B isn't merged here yet. */
function isMissingTable(error: { code?: string } | null): boolean {
  return !!error && (error.code === '42P01' || error.code === 'PGRST205')
}

/**
 * A track B quote or booking named by the call: found in this workspace (with
 * its contact), not found (refused: someone else's id), or unknowable (no such
 * table yet: allowed, the request records the id as the owner gave it).
 */
async function subjectOf(supabase: SupabaseClient, workspaceId: string, subject: PaymentLinkCall['subject'], id: string): Promise<{ found: true; contactId: string | null } | { found: false } | { found: 'unknown' }> {
  const table = SUBJECT_TABLE[subject]
  if (!table) return { found: 'unknown' }
  try {
    const { data, error } = await supabase.from(table).select('id, contact_id').eq('id', id).eq('workspace_id', workspaceId).maybeSingle<{ id: string; contact_id: string | null }>()
    if (isMissingTable(error)) return { found: 'unknown' }
    if (error) return { found: false }
    return data ? { found: true, contactId: data.contact_id } : { found: false }
  } catch {
    return { found: false }
  }
}

/** Whether Stripe still takes payments on a request's link. Unreadable: assumed active (it is only resent). */
async function linkStillActive(request: PaymentRequest): Promise<boolean> {
  if (!request.stripePaymentLinkId) return false
  try {
    const link = await getStripe().paymentLinks.retrieve(request.stripePaymentLinkId, {}, { stripeAccount: request.stripeAccountId })
    return link.active !== false
  } catch {
    return true
  }
}

async function workspaceName(supabase: SupabaseClient, workspaceId: string): Promise<string> {
  const { data } = await supabase.from('workspace').select('name').eq('id', workspaceId).maybeSingle<{ name: string | null }>()
  return data?.name?.trim().slice(0, 60) || 'Your business'
}

async function noteRequested(supabase: SupabaseClient, request: PaymentRequest): Promise<void> {
  if (!request.contactId) return
  const at = new Date().toISOString()
  const { error } = await supabase.from('contact_interaction').insert({
    workspace_id: request.workspaceId,
    contact_id: request.contactId,
    interaction_type: 'payment_requested',
    reference_type: 'payment_request',
    reference_id: request.id,
    title: `Payment link sent: ${formatAmount(request.amountCents, request.currency)}`,
    summary: request.description.slice(0, 200),
    occurred_at: at,
    metadata: { amount_cents: request.amountCents, currency: request.currency },
  })
  if (error) {
    console.warn('[payments] requested note skipped:', error.message)
    return
  }
  await supabase.rpc('update_contact_interaction_stats', { p_contact_id: request.contactId, p_occurred_at: at })
}

async function deliver(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; call: PaymentLinkCall; request: PaymentRequest; customerName: string | null },
) {
  const business = await workspaceName(supabase, args.workspaceId)
  const url = args.request.url as string
  const via: Array<'text' | 'email'> = []
  const problems: string[] = []
  if (args.call.toPhone) {
    const texted = await textCustomer(supabase, { workspaceId: args.workspaceId, phone: args.call.toPhone, body: paymentText({ businessName: business, ...linkFacts(args.request, url) }) })
    if (texted.sent) via.push('text')
    else problems.push(texted.reason === 'no_business_number' ? 'not texted: the business has no texting number yet' : texted.reason === 'opted_out' ? 'not texted: that number said STOP' : `not texted (${texted.reason})`)
  }
  if (args.call.toEmail) {
    const email = paymentEmail({ businessName: business, customerName: args.customerName, ...linkFacts(args.request, url) })
    const emailed = await emailCustomer({ userId: args.userId, workspaceId: args.workspaceId, to: args.call.toEmail, subject: email.subject, html: email.html, text: email.text })
    if (emailed.sent) via.push('email')
    else problems.push(emailed.reason === 'no_mailbox' ? 'not emailed: no mailbox is connected' : `not emailed (${emailed.reason})`)
  }
  await markSent(supabase, args.request.id, { phone: via.includes('text') ? args.call.toPhone : null, email: via.includes('email') ? args.call.toEmail : null, via })
  return { via, problems }
}

function linkFacts(request: PaymentRequest, url: string) {
  return { description: request.description, amountCents: request.amountCents, currency: request.currency, url }
}

/** Run one send_payment_link call (see the header). Never throws past a Stripe or store failure it reports. */
export async function runSendPaymentLink(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; approved: boolean },
  input: unknown,
) {
  const { userId, workspaceId } = args
  const availability = connectAvailability()
  if (!availability.ok) {
    return { success: false as const, code: 'PAYMENTS_OFF', error: 'Card payments are not switched on for Native Intelligence yet. Nothing was sent; tell the person.' }
  }
  const found = await getConnectedAccount(supabase, workspaceId)
  // An account made in the other mode (a key switched since) can't take these payments.
  const account = found && found.livemode === availability.livemode ? found : null
  if (!account || account.status !== 'ready') {
    // Reaches only the owner: their setup link.
    const setup = await textSetupLink(supabase, { workspaceId, userId })
    const state = account?.status === 'restricted' ? 'Stripe has paused card payments on their account' : account ? 'Stripe setup is not finished' : 'Stripe is not connected yet'
    if (setup.sent) {
      return { success: false as const, code: 'STRIPE_NOT_READY', error: `Nothing was sent to the customer: ${state}. The owner was just texted a link to finish it (it works once, for 15 minutes). Tell them, and send the payment link once they say it's done.` }
    }
    const why =
      setup.reason === 'not_admin' ? 'only a workspace owner or admin can connect it; ask them'
        : setup.reason === 'too_soon' ? 'a setup link was texted to the owner a moment ago; ask them to tap it'
          : setup.reason === 'no_phone' ? 'the owner has no verified phone to text the setup link to; they can connect Stripe from Settings in the app'
            : 'the setup link could not be sent; they can connect Stripe in Settings'
    return { success: false as const, code: 'STRIPE_NOT_READY', error: `Nothing was sent to the customer: ${state}, and ${why}.` }
  }
  const parsed = parsePaymentLinkCall(input)
  if (!parsed.ok) return { success: false as const, error: `${parsed.error} Nothing was sent.` }
  const call = parsed.call
  if (!args.approved) {
    return { success: false as const, code: 'APPROVAL_REQUIRED', error: "Nothing was sent. send_payment_link only runs from the owner's own approval card." }
  }

  // Everything it names must be this workspace's.
  let contactId = call.contactId
  let customerName: string | null = null
  if (call.subjectId && SUBJECT_TABLE[call.subject]) {
    const subject = await subjectOf(supabase, workspaceId, call.subject, call.subjectId)
    if (subject.found === false) return { success: false as const, error: `No ${call.subject} with that id in this workspace. Nothing was sent.` }
    if (subject.found === true && !contactId) contactId = subject.contactId
  }
  if (contactId) {
    const contact = await contactOf(supabase, workspaceId, contactId)
    if (!contact) return { success: false as const, error: 'No contact with that id in this workspace. Nothing was sent.' }
    customerName = contact.fullName
  }
  let actionId = call.actionId
  if (!actionId && call.subject === 'action' && call.subjectId) actionId = call.subjectId
  if (actionId && !(await findWorkspaceAction(supabase, workspaceId, actionId))) {
    return { success: false as const, error: 'No to-do with that id in this workspace. Nothing was sent.' }
  }

  // One live link per quote or job: an open one is resent (same amount), a paid one is never resent.
  if (call.subjectId) {
    const existing = await findOpenRequestFor(supabase, workspaceId, call.subject, call.subjectId)
    if (existing?.status === 'paid') {
      return { success: false as const, code: 'ALREADY_PAID', error: `That ${call.subject} is already paid (${formatAmount(existing.amountCents, existing.currency)}). Nothing was sent.` }
    }
    // A link Stripe switched off (its one checkout was used: a bank debit that then failed, say) is never resent.
    if (existing && !(await linkStillActive(existing))) {
      await supabase.from('payment_request').update({ status: 'cancelled', updated_at: new Date().toISOString() }).eq('id', existing.id).eq('status', 'open')
    } else if (existing && existing.url && existing.amountCents === call.amountCents) {
      const sent = await deliver(supabase, { userId, workspaceId, call, request: existing, customerName })
      return { success: true as const, resent: true, payment_request_id: existing.id, url: existing.url, amount: formatAmount(existing.amountCents, existing.currency), sent_via: sent.via, problems: sent.problems }
    } else if (existing) {
      return { success: false as const, code: 'OPEN_LINK', error: `A ${formatAmount(existing.amountCents, existing.currency)} link for this ${call.subject} is already out (${existing.url ?? 'no url'}). Nothing new was sent; the owner can switch that one off in their Stripe Dashboard first.` }
    }
  }

  const created = await createPaymentLink(supabase, getStripe(), {
    workspaceId,
    createdBy: userId,
    contactId,
    subjectType: call.subject,
    subjectId: call.subjectId,
    actionId,
    description: call.description,
    amountCents: call.amountCents,
    stripeAccountId: account.stripeAccountId,
    livemode: availability.livemode,
    fee: account.fee,
    origin: paymentsOrigin(),
  })
  if (!created.ok) return { success: false as const, error: `Stripe could not make the link: ${created.error}. Nothing was sent.` }

  // The "Get paid" to-do, once there is a link for it to wait on (a refused link leaves none behind).
  if (!actionId) {
    const who = customerName?.trim() || (call.toEmail ?? 'the customer')
    actionId = await createPaymentTodo(supabase, {
      workspaceId,
      userId,
      title: `Get paid: ${formatAmount(call.amountCents)} from ${who.slice(0, 60)} (${call.description.slice(0, 60)})`,
      description: 'A payment link went out. This closes when they pay.',
      contactId,
    })
    if (actionId) {
      await supabase.from('payment_request').update({ action_id: actionId, updated_at: new Date().toISOString() }).eq('id', created.request.id)
      created.request.actionId = actionId
    }
  }

  const sent = await deliver(supabase, { userId, workspaceId, call, request: created.request, customerName })
  await noteRequested(supabase, created.request)
  return {
    success: true as const,
    payment_request_id: created.request.id,
    url: created.request.url,
    amount: formatAmount(created.request.amountCents, created.request.currency),
    sent_via: sent.via,
    problems: sent.problems,
    ...(actionId ? { todo_id: actionId } : {}),
    note: sent.via.length
      ? 'Sent. You will hear when they pay; the to-do closes itself.'
      : 'The link exists but reached nobody: give the owner the url to forward, and say why.',
  }
}
