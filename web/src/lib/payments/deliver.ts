/**
 * Who hears what about payments, and how.
 *
 *   The owner, by text (their verified number, textPerson: kind 'notice'):
 *     the setup link, "payments are on", "<customer> paid $600".
 *   The customer, the payment link:
 *     by text, from the BUSINESS's own number (track B's
 *       business_phone_number), never the Dial8 one: a customer replying to
 *       the Dial8 number would land in sign-up, and the business's number is
 *       the one whose 10DLC campaign covers its customers. No business number
 *       (track B not set up yet): no text, and the agent says so;
 *     by email, from the owner's own connected mailbox (sendEmail, which also
 *       logs it on the contact). Never from a Dial8 address.
 *   A number that said STOP is never texted.
 *
 * Server only. Never throws: every result is a value.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { textPerson } from '@/lib/chat/text-turn-server'
import { sendSms } from '@/lib/twilio/client'
import { twilioConfig } from '@/lib/twilio/config'
import { normalizeE164 } from '@/lib/twilio/phone'
import { recordOutbound, unlinkedNumberOptedOut } from '@/lib/sms/store'
import { sendEmail } from '@/lib/crm/email-client'
import { formatAmount } from './payment-links'

export type DeliveryResult = { sent: true } | { sent: false; reason: string }

/** Text the owner (their verified number), from the workspace's own number when it has one. */
export async function textOwner(supabase: SupabaseClient, userId: string, body: string, workspaceId: string): Promise<DeliveryResult> {
  const result = await textPerson(supabase, { userId, workspaceId, body, kind: 'notice' })
  return result.sent ? { sent: true } : { sent: false, reason: result.reason }
}

/** The workspace's live business number (track B), or null: none, or the table isn't there yet. */
export async function businessNumberFor(supabase: SupabaseClient, workspaceId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from('business_phone_number')
      .select('phone_e164')
      .eq('workspace_id', workspaceId)
      .eq('state', 'active')
      .maybeSingle<{ phone_e164: string }>()
    if (error || !data) return null
    return normalizeE164(data.phone_e164)
  } catch {
    return null
  }
}

export interface CustomerTextDeps {
  businessNumber?: (workspaceId: string) => Promise<string | null>
  optedOut?: (phone: string) => Promise<boolean>
  send?: (to: string, body: string, from: string) => Promise<{ ok: true; sid: string } | { ok: false; reason: string }>
}

async function sendFrom(to: string, body: string, from: string) {
  const config = twilioConfig()
  if (!config) return { ok: false as const, reason: 'not_configured' }
  // From the business's number itself (not the Dial8 messaging service's pool).
  return sendSms(to, body, { config: { ...config, fromNumber: from, messagingServiceSid: null } })
}

/** Text a customer, from the business's number. */
export async function textCustomer(
  supabase: SupabaseClient,
  args: { workspaceId: string; phone: string; body: string },
  deps: CustomerTextDeps = {},
): Promise<DeliveryResult> {
  const to = normalizeE164(args.phone)
  if (!to) return { sent: false, reason: 'bad_phone' }
  const from = await (deps.businessNumber ?? ((w) => businessNumberFor(supabase, w)))(args.workspaceId)
  if (!from) return { sent: false, reason: 'no_business_number' }
  try {
    if (await (deps.optedOut ?? ((p) => unlinkedNumberOptedOut(supabase, p)))(to)) return { sent: false, reason: 'opted_out' }
  } catch {
    return { sent: false, reason: 'lookup_failed' }
  }
  const result = await (deps.send ?? sendFrom)(to, args.body, from)
  if (!result.ok) return { sent: false, reason: result.reason }
  await recordOutbound(supabase, { phone: to, kind: 'notice', sid: result.sid })
  return { sent: true }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** The customer's email, built from Dial8's template (only the description and names are the owner's words). Pure. */
export function paymentEmail(args: { businessName: string; description: string; amountCents: number; currency: string; url: string; customerName?: string | null }) {
  const amount = formatAmount(args.amountCents, args.currency)
  const greeting = args.customerName ? `Hi ${args.customerName.split(/\s+/)[0]},` : 'Hi,'
  const subject = `${args.businessName}: payment for ${args.description}`.slice(0, 150)
  const text = `${greeting}\n\nHere is your payment link for ${args.description} (${amount}):\n${args.url}\n\nThank you,\n${args.businessName}`
  const html =
    `<p>${escapeHtml(greeting)}</p>` +
    `<p>Here is your payment link for ${escapeHtml(args.description)} (${escapeHtml(amount)}):</p>` +
    `<p><a href="${escapeHtml(args.url)}">Pay ${escapeHtml(amount)}</a></p>` +
    `<p>Thank you,<br>${escapeHtml(args.businessName)}</p>`
  return { subject, text, html }
}

/** The customer's text. Pure. */
export function paymentText(args: { businessName: string; description: string; amountCents: number; currency: string; url: string }): string {
  return `${args.businessName}: here is your payment link for ${args.description} (${formatAmount(args.amountCents, args.currency)}): ${args.url}`
}

export interface CustomerEmailDeps {
  send?: typeof sendEmail
}

/** Email a customer from the owner's own mailbox. */
export async function emailCustomer(
  args: { userId: string; workspaceId: string; to: string; subject: string; html: string; text: string },
  deps: CustomerEmailDeps = {},
): Promise<DeliveryResult> {
  try {
    await (deps.send ?? sendEmail)(args.userId, args.workspaceId, { to: [args.to], subject: args.subject, body_html: args.html, body_text: args.text })
    return { sent: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { sent: false, reason: /no .*(account|mailbox)|not connected|token/i.test(message) ? 'no_mailbox' : 'send_failed' }
  }
}
