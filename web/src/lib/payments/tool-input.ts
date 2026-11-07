/**
 * send_payment_link's input (src/lib/ai/tools/payments.ts), shared with the
 * outward gate's card (src/lib/safety/outward-gate.ts) so the card shows
 * exactly what the approved call will do: the amount, what it's for, and who
 * it goes to. The recipients are IN the input (never looked up later), so the
 * approval's input hash pins them.
 *
 * Client-safe and pure.
 */
import { z } from 'zod'
import { normalizeE164 } from '@/lib/twilio/phone'
import { formatAmount, MAX_AMOUNT_CENTS, MIN_AMOUNT_CENTS, PAYMENT_SUBJECT_TYPES, type PaymentSubjectType } from './payment-links'

export const SEND_PAYMENT_LINK = 'send_payment_link' as const

export const sendPaymentLinkInput = z.object({
  subject: z
    .enum(PAYMENT_SUBJECT_TYPES)
    .describe('What it is for: quote (a customer quote), booking (a booked job slot), action (a to-do), or job (anything else; give no subject_id).'),
  subject_id: z.string().trim().min(1).max(64).optional().describe("The quote's, booking's or to-do's id. One open link per subject: asking again resends it."),
  amount: z.number().positive().describe('The amount in dollars, as quoted (600 or 600.50). At least $0.50.'),
  description: z.string().trim().min(1).max(120).describe('What the customer is paying for, as they will see it on the payment page: "Rug wash, 8x10 wool".'),
  contact_id: z.string().uuid().optional().describe("The customer's CRM contact, so the payment lands on their timeline."),
  to_phone: z.string().trim().max(32).optional().describe("The customer's mobile number to text the link to (from the quote or their contact)."),
  to_email: z.string().trim().max(254).optional().describe("The customer's email to send the link to, from the owner's own mailbox."),
  action_id: z.string().uuid().optional().describe('An existing to-do to close when they pay. Omit: a "Get paid" to-do is made and closed for you.'),
})

export type SendPaymentLinkInput = z.infer<typeof sendPaymentLinkInput>

export interface PaymentLinkCall {
  subject: PaymentSubjectType
  subjectId: string | null
  amountCents: number
  description: string
  contactId: string | null
  toPhone: string | null
  toEmail: string | null
  actionId: string | null
}

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/

/** Dollars to cents, refusing fractions of a cent. Pure. */
export function dollarsToCents(amount: number): number | null {
  if (!Number.isFinite(amount) || amount <= 0) return null
  const cents = Math.round(amount * 100)
  return Math.abs(cents - amount * 100) < 1e-6 ? cents : null
}

/** One line, no control characters, clipped. */
function oneLine(value: string, max: number): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

/** The call, checked. Pure. */
export function parsePaymentLinkCall(input: unknown): { ok: true; call: PaymentLinkCall } | { ok: false; error: string } {
  const parsed = sendPaymentLinkInput.safeParse(input)
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input.' }
  const v = parsed.data
  const amountCents = dollarsToCents(v.amount)
  if (amountCents === null) return { ok: false, error: 'The amount must be in dollars and cents (600 or 600.50).' }
  if (amountCents < MIN_AMOUNT_CENTS || amountCents > MAX_AMOUNT_CENTS) {
    return { ok: false, error: `The amount must be between ${formatAmount(MIN_AMOUNT_CENTS)} and ${formatAmount(MAX_AMOUNT_CENTS)}.` }
  }
  if (v.subject !== 'job' && !v.subject_id) return { ok: false, error: `Give the ${v.subject}'s id as subject_id (or use subject "job").` }
  const toPhone = v.to_phone ? normalizeE164(v.to_phone) : null
  if (v.to_phone && !toPhone) return { ok: false, error: 'to_phone is not a phone number (use +1 and the full number).' }
  const toEmail = v.to_email ? v.to_email.toLowerCase() : null
  if (toEmail && !EMAIL.test(toEmail)) return { ok: false, error: 'to_email is not an email address.' }
  if (!toPhone && !toEmail) return { ok: false, error: 'Give to_phone, to_email or both: who gets the link.' }
  const description = oneLine(v.description, 120)
  if (!description) return { ok: false, error: 'Say what the payment is for.' }
  return {
    ok: true,
    call: {
      subject: v.subject,
      subjectId: v.subject === 'job' ? null : (v.subject_id ?? null),
      amountCents,
      description,
      contactId: v.contact_id ?? null,
      toPhone,
      toEmail,
      actionId: v.action_id ?? null,
    },
  }
}

/** The approval card's words. Pure. */
export function paymentLinkCard(call: PaymentLinkCall): { title: string; why: string } {
  const amount = formatAmount(call.amountCents)
  // The full number: the owner checks it before saying yes.
  const ways = [call.toPhone ? `by text to ${call.toPhone}` : null, call.toEmail ? `by email to ${call.toEmail}` : null].filter(Boolean).join(' and ')
  return {
    title: `Send a ${amount} payment link?`,
    why:
      `For “${call.description}”, ${ways}. The customer pays on Stripe's page, straight into your Stripe account, once. ` +
      'Nothing reaches the customer without your yes. It runs once, with exactly these details, when you accept.',
  }
}
