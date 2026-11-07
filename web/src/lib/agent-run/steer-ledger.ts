/**
 * Steering a live helper (always-on-agent §4 "Steering helpers and delegates
 * while they work", A4 slice 4): the record of a steer, and how the work-run
 * watcher knows each one reached the helper.
 *
 * A steer is a message sent into a RUNNING work run's eve session with
 * `turnPolicy: 'steer'` (bot-relay.ts steerLiveRun). eve folds it into the
 * running turn at the next safe point, keeping the turn id. Its text is the
 * history: "You → …" when the person typed it (the Agents widget, the action
 * panel, later), "Your agent, for you → …" when the main agent relayed it from
 * the main chat. It lands in the run's session as a user message, so the run's
 * chat shows it like any message, and the work-agent's instructions say what
 * the two prefixes mean.
 *
 * Each steer has a bot_relay row (mode 'steer', migration 332). The watcher
 * marks it applied (applied_at) when the turn it drains shows the steer's
 * `message.received`. One it never saw is the orphan race: a steer that
 * reached eve just after the turn settled starts the NEXT turn, which nobody
 * would read (unbilled, and the classifier would settle the run failed). So
 * at each boundary the watcher looks for unapplied steers and, finding one,
 * drains the next turn as a continuation (run-work-eve.ts
 * watchWorkEveSession), claiming the steer first so a turn that never comes
 * cannot loop.
 *
 * Every read and write is fenced on the run and its workspace. Never throws:
 * a failed read reads as "no steers" (the turn classifies as before A4).
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Who a steer is from, as its history line says. */
export type SteerFrom = 'person' | 'agent'

export const STEER_PREFIX: Readonly<Record<SteerFrom, string>> = {
  person: 'You →',
  agent: 'Your agent, for you →',
}

/** The steer as it lands in the run's session (and so in its chat's history). */
export function renderSteerMessage(message: string, from: SteerFrom): string {
  return `${STEER_PREFIX[from]} ${message.trim()}`
}

/** Whether a received message carries this steer's words (eve may fold several steers into one input). */
export function steerSeenIn(received: string, message: string): boolean {
  const words = message.trim()
  if (!words) return false
  return (Object.keys(STEER_PREFIX) as SteerFrom[]).some((from) => received.includes(renderSteerMessage(words, from)))
}

export interface PendingSteer {
  id: string
  message: string
}

/**
 * The run's steers not yet applied: claimed or delivered (a failed one never
 * reached eve). Oldest first. [] on a failed read.
 */
export async function listUnappliedSteers(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string },
): Promise<PendingSteer[]> {
  try {
    const { data, error } = await supabase
      .from('bot_relay')
      .select('id, message')
      .eq('agent_run_id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .eq('mode', 'steer')
      .is('applied_at', null)
      .in('status', ['running', 'done'])
      .order('created_at', { ascending: true })
      .limit(20)
    if (error) {
      console.warn('[steer] unapplied steers unread:', error.message)
      return []
    }
    return ((data ?? []) as Array<{ id: unknown; message: unknown }>)
      .filter((r): r is PendingSteer => typeof r.id === 'string' && typeof r.message === 'string')
  } catch (err) {
    console.warn('[steer] unapplied steers unread:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * Stamp steers applied, only ones still unapplied (a compare-and-set on
 * applied_at), and answer the ids THIS call stamped. The stamp is the claim
 * on draining a steer's turn: the watcher's boundary check and the relay's
 * after-settle drain (bot-relay.ts) both claim before they read, so exactly
 * one of them drains it. Never throws ([] on a failed write).
 */
export async function markSteersApplied(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string; ids: readonly string[] },
): Promise<string[]> {
  if (args.ids.length === 0) return []
  try {
    const { data, error } = await supabase
      .from('bot_relay')
      .update({ applied_at: new Date().toISOString() })
      .in('id', [...args.ids])
      .eq('agent_run_id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .eq('mode', 'steer')
      .is('applied_at', null)
      .select('id')
    if (error) {
      console.warn('[steer] could not mark steers applied:', error.message)
      return []
    }
    return ((data ?? []) as Array<{ id: unknown }>).map((r) => r.id).filter((id): id is string => typeof id === 'string')
  } catch (err) {
    console.warn('[steer] could not mark steers applied:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/**
 * At a turn boundary: mark applied every unapplied steer the drained turn
 * received, and answer the ones it didn't (the orphans the watcher drains as
 * a continuation). Never throws.
 */
export async function settleSteersAtBoundary(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string; receivedMessages: readonly string[] },
): Promise<PendingSteer[]> {
  const pending = await listUnappliedSteers(supabase, args)
  if (pending.length === 0) return []
  const seen = pending.filter((s) => args.receivedMessages.some((m) => steerSeenIn(m, s.message)))
  await markSteersApplied(supabase, { agentRunId: args.agentRunId, workspaceId: args.workspaceId, ids: seen.map((s) => s.id) })
  return pending.filter((s) => !seen.includes(s))
}
