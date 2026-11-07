import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveHomeConversation } from '@/lib/onboarding/home-conversation-pointer'

export { resolveHomeConversation }

/**
 * Server-side writer for a member's durable "home conversation" (conversational
 * onboarding — "the dashboard is the reveal").
 *
 * The sibling of live-agent/conversation-writer.ts's appendAgentMessage, but
 * keyed on the HOME conversation instead of a capture. It exists so a server
 * process can drop an assistant bubble into the member's home thread,
 * delivered to the open panel via the same Realtime postgres_changes bridge
 * (useLiveConversation).
 *
 * WHERE THE HOME CONVERSATION LIVES: it is the member's home thread
 * (docs/plans/always-on-agent.md §2c, A3), the chat_conversations row with
 * `is_home = true` for that person in that workspace (migration 330). The
 * get-or-create is owned by home-conversation-pointer.ts (re-exported above),
 * over ensureHomeThread (src/lib/chat/home-thread.ts): race-safe on the unique
 * index.
 *
 * NOTE: the onboarding RESEARCHER's finish_research tool cannot import from
 * src/ (its eve compile bundles only agents/*), so it uses a deliberate mirror
 * of this contract at agents/onboarding-researcher/lib/home-brief-writer.ts —
 * exactly as research-progress.ts mirrors the app's merge discipline. Keep the
 * two get-or-create + upsert shapes in sync.
 *
 * SECURITY CONTRACT: the caller supplies the tenancy pair (userId, workspaceId)
 * it must already have derived from a verified principal — this writer never
 * reads tenancy from model/tool input. The get-or-create is pinned to that pair,
 * so a caller can only ever write into the ONE home conversation that pair owns.
 *
 * Every write is best-effort: the onboarding surface must never fail the run
 * that triggered it. Callers get a discriminated result, not a throw.
 */

/** Loose UIMessage part shape — the chat renders whatever parts it knows. */
export type HomeMessagePart = Record<string, unknown> & { type: string }

export interface HomeMessageResult {
  written: boolean
  conversationId?: string
  messageId?: string
  /** Whether this call created the home conversation row (vs. found it). */
  created?: boolean
  reason?: 'no_conversation' | 'error'
}

/**
 * Append (idempotently) one assistant message to the member's home
 * conversation, creating the conversation if it doesn't exist yet.
 *
 * The stable `messageId` + the (conversation_id, ui_message_id) unique index
 * (migration 173) collapse every retry / re-run / double-write onto ONE row —
 * the same "exactly once" contract as appendAgentMessage. `ignoreDuplicates`
 * means a second write with the same id is a no-op (the first bubble stands),
 * matching the brief-write-on-researcher-re-run case.
 */
export async function appendHomeMessage(
  supabase: SupabaseClient,
  opts: {
    userId: string
    workspaceId: string
    parts: HomeMessagePart[]
    /** Stable id → the DB unique index makes retries/races idempotent. */
    messageId: string
    /** Merged into ui_message.metadata alongside onboarding_home/kind. */
    metadata?: Record<string, unknown>
    /** Title for the home conversation on first create. */
    conversationTitle?: string
  },
): Promise<HomeMessageResult> {
  try {
    const resolved = await resolveHomeConversation(supabase, {
      userId: opts.userId,
      workspaceId: opts.workspaceId,
      title: opts.conversationTitle,
    })
    if (!resolved) return { written: false, reason: 'no_conversation' }
    const { conversationId, created } = resolved

    const uiMessage = {
      id: opts.messageId,
      role: 'assistant' as const,
      parts: opts.parts,
      metadata: {
        onboarding_home: true,
        ...(opts.metadata ?? {}),
      },
    }

    const { error } = await supabase.from('chat_messages').upsert(
      {
        conversation_id: conversationId,
        user_id: opts.userId,
        workspace_id: opts.workspaceId,
        role: 'assistant',
        ui_message: uiMessage,
      },
      // Stable ids make double-writes (researcher re-run, resync race) converge
      // on one row instead of duplicating bubbles.
      { onConflict: 'conversation_id,ui_message_id', ignoreDuplicates: true },
    )
    if (error) {
      console.warn('home-message-writer: append failed:', error.message)
      return { written: false, conversationId, created, reason: 'error' }
    }

    // Bump the conversation so it sorts to the top of the history list.
    void supabase
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .then(undefined, () => {})

    return { written: true, conversationId, messageId: opts.messageId, created }
  } catch (err) {
    console.warn('home-message-writer: append threw:', err)
    return { written: false, reason: 'error' }
  }
}
