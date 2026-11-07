/**
 * The agent's one money tool (roadmap C2, docs/plans/stripe-connect-payments.md):
 *
 *   send_payment_link   send a customer a payment link for a quote or job: a
 *                       Stripe Payment Link on the owner's own connected
 *                       account (src/lib/payments/payment-links.ts), texted
 *                       from the business's number and/or emailed from the
 *                       owner's mailbox, with a "Get paid" to-do the payment
 *                       closes.
 *
 * Nothing else. The agent never refunds, pays out, edits Stripe customers or
 * reads the owner's Stripe account: no other tool reaches Stripe
 * (src/lib/ai/__tests__/payments-tool.test.ts pins that), and Dial8 holds no
 * Stripe MCP connector for it (payment MCPs stay out on purpose:
 * src/lib/mcp-client/suggested.ts).
 *
 * Runs ONLY as an approved call: once Stripe is ready, the outward gate holds
 * every call as the owner's approval card (outward-gate.ts: in the app, or
 * "yes CODE" by text), saying the amount, what it's for and who gets it. Any
 * other unapproved call is refused here and nothing reaches the customer.
 * Before Stripe is ready the gate lets it through, and it reaches only the
 * owner: it texts them their Stripe setup link (src/lib/payments/setup.ts).
 *
 * Service-role client on the tool proxies: every read is fenced to the
 * session workspace here.
 */
import { tool } from 'ai'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import { SEND_PAYMENT_LINK, sendPaymentLinkInput } from '@/lib/payments/tool-input'

export interface PaymentToolContext {
  approvedCall?: ApprovedCall
}

const DESCRIPTION =
  "Send a customer a payment link for a quote or job: they pay by card on Stripe's page, straight into the owner's own Stripe account. " +
  'Texts it from the business number and/or emails it from the owner\'s mailbox (give to_phone and/or to_email), and closes a "Get paid" to-do when they pay. ' +
  "Never runs in the turn: it always becomes the owner's approval card saying the amount, what it's for and who gets it, and sends once when they accept. " +
  'If Stripe is not connected yet, it texts the owner a setup link instead. It cannot refund, pay out or change anything in Stripe.'

export function createPaymentTools(userId: string, supabase: SupabaseClient, workspaceId: string, ctx: PaymentToolContext = {}) {
  return {
    send_payment_link: tool({
      description: DESCRIPTION,
      inputSchema: sendPaymentLinkInput,
      execute: async (input) => {
        // Loaded on use: the Stripe SDK stays out of every tool set's imports.
        const { runSendPaymentLink } = await import('@/lib/payments/send-link')
        return runSendPaymentLink(supabase, { userId, workspaceId, approved: ctx.approvedCall?.tool === SEND_PAYMENT_LINK }, input)
      },
    }),
  }
}
