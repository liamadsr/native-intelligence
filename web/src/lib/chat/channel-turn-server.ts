/**
 * A channel turn's server half that every outside channel shares
 * (docs/plans/slack-connect.md decision 14; docs/plans/text-and-calling.md):
 * keeping the person's words out of Inngest step outputs. A step output is
 * stored by Inngest, so the plan step hands on the messages' ids only
 * ({@link redactChannelPlan}), and the send step reads the words back, with a
 * fresh session's primer rendered again ({@link hydrateChannelPlan}). Each
 * channel's consumer (src/lib/inngest/slack-turn.ts,
 * src/lib/inngest/text-turn.ts) calls these.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PlannedChannelMessage } from './channel-turn'
import type { HomeTurnRequestedData } from './home-turn'
import { renderFreshSessionPrimer, textOfParts, type HomeTurnPlanResult } from './home-turn-server'

/**
 * The plan without the person's words (ids only): what the plan step returns.
 * A fresh session's primer goes too (it holds the thread's history, their
 * messages included); the send step renders it again (hydrateChannelPlan).
 */
export function redactChannelPlan(plan: HomeTurnPlanResult): HomeTurnPlanResult {
  const ids = (messages: PlannedChannelMessage[] | undefined) => messages?.map((m) => ({ messageId: m.messageId, text: '' }))
  if (plan.ok) {
    const { primer, ...rest } = plan
    return {
      ...rest,
      ...(plan.channelMessages ? { channelMessages: ids(plan.channelMessages) } : {}),
      ...(primer ? { primerPending: true } : {}),
    }
  }
  return plan.record?.channelMessages ? { ...plan, record: { ...plan.record, channelMessages: ids(plan.record.channelMessages) } } : plan
}

/** The ids a plan (or a skip) carries. */
export function plannedMessageIds(plan: HomeTurnPlanResult): string[] {
  const messages = plan.ok ? plan.channelMessages : plan.record?.channelMessages
  return (messages ?? []).map((m) => m.messageId)
}

/**
 * The plan with its messages' words read back from the home thread (inside the
 * send step), in the plan's order, and a fresh session's primer rendered
 * again when the plan step took it out. A message gone since is dropped.
 * Throws on a failed read (the step retries).
 */
export async function hydrateChannelPlan<P extends { channelMessages?: PlannedChannelMessage[]; primer?: string; primerPending?: boolean }>(
  supabase: SupabaseClient,
  data: HomeTurnRequestedData,
  plan: P,
  deps: { renderPrimer?: typeof renderFreshSessionPrimer } = {},
): Promise<P> {
  const ids = (plan.channelMessages ?? []).map((m) => m.messageId)
  if (plan.primerPending) {
    const primer = await (deps.renderPrimer ?? renderFreshSessionPrimer)(supabase, data, new Set(ids)).catch(() => null)
    plan = { ...plan, primerPending: undefined, ...(primer ? { primer } : {}) }
  }
  if (ids.length === 0) return plan
  const { data: rows, error } = await supabase
    .from('chat_messages')
    .select('ui_message')
    .eq('conversation_id', data.conversationId)
    .eq('user_id', data.userId)
    .in('ui_message->>id', ids)
  if (error) throw new Error(`channel turn: messages read failed: ${error.message}`)
  const byId = new Map<string, string>()
  for (const row of (rows ?? []) as Array<{ ui_message: { id?: unknown; parts?: unknown } | null }>) {
    const id = row.ui_message?.id
    if (typeof id === 'string') byId.set(id, textOfParts(row.ui_message?.parts))
  }
  return { ...plan, channelMessages: ids.flatMap((id) => (byId.get(id) ? [{ messageId: id, text: byId.get(id)! }] : [])) }
}
