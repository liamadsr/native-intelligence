/**
 * A customer's quote reaching the business (roadmap B1): the intake endpoint
 * (src/app/api/intake/quotes/[key]/route.ts) hands a parsed form here, and:
 *
 *   1. the CRM contact is found by email or number, or made (a lead,
 *      ./contacts.ts);
 *   2. the quote is stored, linked to it (once per form submission id);
 *   3. for a NEW quote only, the owner's inbox gets one `quote.received`
 *      event (the router makes it a turn in their home thread, and the reach
 *      router texts it when they are away), and the workspace's
 *      quote_received loops fire.
 *
 * The event's title is Dial8's own words and numbers (who by the number's last
 * four digits, how many items, their sizes, the price); everything the
 * customer typed the agent reads with get_quote, inside the untrusted fence.
 *
 * Server only; service role. Pure over {@link ReceiveQuoteDeps} for the tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordAgentEvents, type AgentEventInput } from '@/lib/agent-events/record'
import { agentEventKey } from '@/lib/agent-events/types'
import { emitQuoteReceived } from '@/lib/flows/emit-quote-received'
import { upsertCustomerContact, type CustomerContact, type CustomerContactInput } from './contacts'
import type { ParsedQuote } from './intake'
import { insertQuote, type InsertQuoteResult } from './store'
import { formatCents, type CustomerQuote, type QuoteSource } from './types'

export interface ReceiveQuoteDeps {
  upsertContact(args: { workspaceId: string; ownerUserId: string }, input: CustomerContactInput): Promise<CustomerContact | null>
  insertQuote(args: { workspaceId: string; source: QuoteSource; contactId: string | null }, quote: ParsedQuote): Promise<InsertQuoteResult>
  recordEvents(inputs: AgentEventInput[]): Promise<number>
  emitFlow(args: { workspaceId: string; quoteId: string }): Promise<boolean>
}

export type ReceiveQuoteResult =
  | { ok: true; quote: CustomerQuote; created: boolean; contactId: string | null }
  | { ok: false; error: string }

/**
 * The inbox event's title, in Dial8's own words and numbers only: "a quote
 * from a customer ending 0173: 2 items (8x10 ft, 5x7 ft), $600". Nothing the
 * customer typed (their name, a service, a size in words) rides it into the
 * owner's turn: the agent reads those with get_quote, fenced. Pure.
 */
export function quoteEventTitle(quote: Pick<CustomerQuote, 'customerPhone' | 'items' | 'totalCents' | 'currency'>): string {
  const who = quote.customerPhone ? `a customer ending ${quote.customerPhone.slice(-4)}` : 'a customer'
  const sizes = quote.items
    .filter((i) => typeof i.width === 'number' && typeof i.length === 'number')
    .map((i) => `${Math.round(i.width! * 100) / 100}x${Math.round(i.length! * 100) / 100}${i.unit && /^(ft|in|m|cm)$/.test(i.unit) ? ` ${i.unit}` : ''}`)
  const count = quote.items.reduce((n, i) => n + (typeof i.quantity === 'number' && i.quantity > 0 ? i.quantity : 1), 0)
  const what = count ? `${count} ${count === 1 ? 'item' : 'items'}${sizes.length ? ` (${sizes.slice(0, 3).join(', ')}${sizes.length > 3 ? ', …' : ''})` : ''}` : null
  const price = formatCents(quote.totalCents, quote.currency)
  const details = [what, price].filter(Boolean).join(', ')
  return details ? `a quote from ${who}: ${details}` : `a quote from ${who}`
}

/** Receive one quote (see the header). Never throws. */
export async function receiveQuote(
  args: { workspaceId: string; ownerUserId: string; source?: QuoteSource },
  parsed: ParsedQuote,
  deps: ReceiveQuoteDeps,
): Promise<ReceiveQuoteResult> {
  let contact: CustomerContact | null = null
  try {
    contact = await deps.upsertContact(
      { workspaceId: args.workspaceId, ownerUserId: args.ownerUserId },
      { name: parsed.customerName, email: parsed.customerEmail, phone: parsed.customerPhone, source: args.source === 'sms' ? 'sms' : 'web_form' },
    )
  } catch (err) {
    // The quote matters more than its link: stored without one, the owner still hears it.
    console.warn('[quote-intake] contact skipped:', err instanceof Error ? err.message : String(err))
  }
  const stored = await deps.insertQuote({ workspaceId: args.workspaceId, source: args.source ?? 'web_form', contactId: contact?.id ?? null }, parsed)
  if (!stored.ok) return { ok: false, error: stored.error }
  const { quote, created } = stored
  if (created) {
    await deps.recordEvents([
      {
        workspaceId: args.workspaceId,
        userId: args.ownerUserId,
        kind: 'quote.received',
        priority: 2,
        occursAt: quote.createdAt,
        refType: 'quote',
        refId: quote.id,
        facts: { title: quoteEventTitle(quote), ...(contact ? { contactId: contact.id } : {}) },
        dedupeKey: agentEventKey.quoteReceived(quote.id),
      },
    ])
    await deps.emitFlow({ workspaceId: args.workspaceId, quoteId: quote.id })
  }
  return { ok: true, quote, created, contactId: contact?.id ?? null }
}

/** The real store behind {@link receiveQuote}. */
export function supabaseReceiveQuoteDeps(supabase: SupabaseClient): ReceiveQuoteDeps {
  return {
    upsertContact: (args, input) => upsertCustomerContact(supabase, args, input),
    insertQuote: (args, quote) => insertQuote(supabase, args, quote),
    recordEvents: (inputs) => recordAgentEvents(inputs, supabase),
    emitFlow: (args) => emitQuoteReceived(args),
  }
}
