/**
 * Compaction on command (Liam, 10-22: the Context panel "with an option to
 * compact on command"): the side panel's Compact now and the composer's
 * `/compact`, through POST /api/account/chat/compact.
 *
 * The same request the idle timer makes (idle-compaction.ts
 * compactChatSession, mode 'manual'), asked by the person for their own
 * conversation:
 *   1. the conversation is theirs in this workspace, has an eve session, and
 *      is not a capture's (a meeting's own chat is never compacted);
 *   2. they are within their usage limits: a compaction is a billed model
 *      call (agents/chat-agent/hooks/usage-meter.ts, `compaction=manual`);
 *   3. compactChatSession: no turn running, a model call to compact, nothing
 *      compacted since it; then `compact()`, watched for its outcome for up to
 *      MANUAL_COMPACTION_WATCH_MS so the panel can say it's done.
 * The quiet time and the minimum size are not checked: the person asked.
 * A send while it runs waits behind it, as behind an idle compaction
 * (eve-chat-transport.ts's `compacting` health).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkUsageLimits } from '@/lib/ai/auth'
import {
  claimsFor,
  compactChatSession,
  IDLE_COMPACTION_FIRST_EVENT_MS,
  IDLE_COMPACTION_RECHECK_MS,
  IDLE_COMPACTION_TAIL_MAX_MS,
  type CompactIdleSessionDeps,
  type IdleCompactionOutcome,
} from '@/lib/chat/idle-compaction'

/**
 * How long the outcome is waited for: a big context's summary takes well
 * under a minute. Past it the compaction still finishes; the panel says it's
 * running ('requested').
 */
export const MANUAL_COMPACTION_WATCH_MS = 75_000

/** The route's whole budget: the tail read, the re-check and the watch, with room to answer. */
export const MANUAL_COMPACTION_MAX_DURATION_S = Math.ceil(
  (IDLE_COMPACTION_FIRST_EVENT_MS + IDLE_COMPACTION_TAIL_MAX_MS + IDLE_COMPACTION_RECHECK_MS + MANUAL_COMPACTION_WATCH_MS) / 1000 + 15,
)

export type ManualCompactionOutcome =
  | IdleCompactionOutcome
  /** The conversation is not the caller's in this workspace. */
  | 'not_found'

export interface ManualCompactionResult {
  outcome: ManualCompactionOutcome
  /** The last model call's input before the compaction, when read. */
  inputTokens?: number
}

/** Compact the caller's conversation now. Never throws: every failure is an outcome. */
export async function compactConversationNow(
  supabase: SupabaseClient,
  args: { conversationId: string; userId: string; workspaceId: string },
  deps: CompactIdleSessionDeps & { checkLimits?: (userId: string) => Promise<unknown> } = {},
): Promise<ManualCompactionResult> {
  try {
    const { data: conv, error } = await supabase
      .from('chat_conversations')
      .select('id, eve_session_id, capture_id, ai_team_member_id, focus_area, agent_guest_id')
      .eq('id', args.conversationId)
      .eq('user_id', args.userId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle<{
        id: string
        eve_session_id: string | null
        capture_id: string | null
        ai_team_member_id: string | null
        focus_area: string | null
        agent_guest_id?: string | null
      }>()
    if (error) return { outcome: 'lookup_failed' }
    if (!conv) return { outcome: 'not_found' }
    // A capture's chat, or a guest's thread (guest access: the owner's spec must never compact it), isn't compacted here.
    if (conv.capture_id || conv.agent_guest_id) return { outcome: 'capture_conversation' }
    if (!conv.eve_session_id) return { outcome: 'no_session' }

    try {
      await (deps.checkLimits ?? checkUsageLimits)(args.userId)
    } catch (err) {
      return { outcome: err instanceof Response && err.status === 429 ? 'usage_limited' : 'usage_check_failed' }
    }

    return await compactChatSession(
      { claims: claimsFor(args, conv), sessionId: conv.eve_session_id, mode: 'manual' },
      { ...deps, timing: { watchMs: MANUAL_COMPACTION_WATCH_MS, ...deps.timing } },
    )
  } catch {
    return { outcome: 'error' }
  }
}

/** The one log line per request. Counts and ids only. */
export function manualCompactionLogLine(args: { conversationId: string; inputTokens?: number; outcome: ManualCompactionOutcome }): string {
  return `[manual-compaction] conversation=${args.conversationId} input=${args.inputTokens ?? '-'} outcome=${args.outcome}`
}
