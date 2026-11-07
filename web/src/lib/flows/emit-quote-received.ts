import { inngest } from '@/lib/inngest/client'

/**
 * Emit `flow/quote.received` for a customer's new quote (roadmap B1), once
 * per quote: the event id is keyed on it, so a re-posted form fires its
 * loops once. flowDispatchOnQuoteReceived (src/lib/inngest/flow-functions.ts)
 * fires the workspace's enabled quote_received loops.
 *
 * Awaited by the intake (a form post can wait), but it never throws: a failed
 * send is logged and the quote stays stored.
 */
export async function emitQuoteReceived(
  args: { workspaceId: string; quoteId: string; firedAt?: string },
  deps: { send?: (event: { name: string; id: string; data: Record<string, unknown> }) => Promise<unknown> } = {},
): Promise<boolean> {
  try {
    await (deps.send ?? ((e) => inngest.send(e as never)))({
      name: 'flow/quote.received',
      id: `quote-received:${args.quoteId}`,
      data: { workspace_id: args.workspaceId, quote_id: args.quoteId, fired_at: args.firedAt ?? new Date().toISOString() },
    })
    return true
  } catch (err) {
    console.error('[flows] quote received inngest.send failed', err)
    return false
  }
}
