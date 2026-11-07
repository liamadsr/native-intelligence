import type { SupabaseClient } from '@supabase/supabase-js'
import { scrubMailPart } from './mail-tool-scrub'

/**
 * Server-side writer for eve-routed main-chat turns (Phase 4, Stage 3 —
 * persistence projection).
 *
 * eve is the durable SYSTEM OF RECORD for main-chat history; `chat_messages`
 * becomes a PROJECTION kept for search / RLS / Realtime. When an eve turn
 * completes, its finalized assistant message is written here so the projection
 * stays complete (and so the knowledge extraction hook can fire — see
 * conversationActivityFired). This mirrors the live-agent conversation-writer's
 * server-write pattern (src/lib/live-agent/conversation-writer.ts): a message
 * the SERVER persists, marked so the client autosave (use-chat-auto-save.ts)
 * SKIPS it instead of double-writing.
 *
 * SECURITY CONTRACT (mirrors conversation-writer's plan-D4 rule): the caller is
 * the trusted internal eve runtime authenticated by the internal secret + a
 * verified chat-run token; tenancy (userId/workspaceId) rides in the token and
 * is passed in explicitly, never taken from the model. This writer additionally
 * re-derives the OWNER from the conversation row and asserts the token's
 * (userId, workspaceId) matches it — so a token scoped to conversation A can
 * only write into conversation A's own thread, never another user's.
 *
 * Every write is best-effort by design: a failed projection must never fail the
 * live turn (the user already saw the streamed reply). Callers get a
 * discriminated result, not a throw.
 */

/** The discriminant stamped on every eve-written message's metadata. The client
 *  autosave keys off it (mirroring metadata.live_capture===true) to SKIP these
 *  born-saved rows. Kept as a named export so the hook + tests share the constant. */
export const EVE_WRITTEN_METADATA_KEY = 'eve_written' as const

/**
 * Marks a reply the SERVER wrote from its own copy of the turn (the reply
 * backup, ./reply-backup.ts) before the browser's persist arrived, or in its
 * place when the page died. A provisional row is the one row a later write of
 * the same message replaces (see persistEveMessage); the browser's write
 * clears the mark, so its copy is final.
 */
export const EVE_PROVISIONAL_METADATA_KEY = 'eve_provisional' as const

/** Loose UIMessage part shape — the chat renders whatever parts it knows. */
export type EveMessagePart = Record<string, unknown> & { type: string }

export interface EveMessageResult {
  written: boolean
  /**
   * The message already had a PROVISIONAL row (the reply backup's) and this
   * write replaced it. Not a new row: the knowledge hook already fired for it.
   */
  replaced?: boolean
  conversationId?: string
  messageId?: string
  /** Whether a conversation/activity event should be emitted for this write. True
   *  only when a NEW message row was actually inserted (not a dedup no-op / error),
   *  so the knowledge hook fires once per persisted turn, never on a retry. */
  conversationActivityFired: boolean
  reason?: 'no_conversation' | 'owner_mismatch' | 'error'
}

interface ConversationOwner {
  ownerUserId: string
  workspaceId: string
}

async function loadConversationOwner(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<ConversationOwner | null> {
  const { data } = await supabase
    .from('chat_conversations')
    .select('user_id, workspace_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (!data?.user_id || !data?.workspace_id) return null
  return { ownerUserId: data.user_id as string, workspaceId: data.workspace_id as string }
}

/**
 * Overwrite a stored message with `uiMessage`, but only while the stored row
 * is still provisional (the reply backup's copy). True when a row was
 * replaced. Best-effort: a failure leaves the stored row as it was.
 */
async function replaceProvisional(
  supabase: SupabaseClient,
  conversationId: string,
  messageId: string,
  uiMessage: Record<string, unknown>,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('chat_messages')
    .update({ ui_message: uiMessage })
    .eq('conversation_id', conversationId)
    .eq('ui_message_id', messageId)
    .eq(`ui_message->metadata->>${EVE_PROVISIONAL_METADATA_KEY}`, 'true')
    .select('id')
  if (error) {
    console.warn(`eve-message-writer: provisional replace failed (conversation ${conversationId}):`, error.message)
    return false
  }
  return Array.isArray(data) && data.length > 0
}

/**
 * Persist ONE finalized eve assistant message into the conversation's
 * `chat_messages` projection.
 *
 * `opts.messageId` becomes the message's top-level `id`, which the STORED
 * generated column `ui_message_id` (migration 173) mirrors — so the
 * onConflict(conversation_id, ui_message_id) upsert dedups a re-sent/replayed
 * write onto the existing row (ignoreDuplicates) rather than duplicating the
 * bubble. The transport MUST pass the SAME id it rendered client-side so the
 * projection and the client's in-memory message converge on one identity.
 *
 * No-ops (written:false) when the conversation is missing, or when the token's
 * (userId, workspaceId) does not own the conversation.
 *
 * ── Provisional rows (the reply backup) ─────────────────────────────────────
 * The server writes its own copy of each reply at the turn's end
 * (./reply-backup.ts, `provisional: true`), so a reply survives a page that
 * died mid-turn. When the page is alive, both copies race. An assistant write
 * that finds its message already stored replaces the row only while it is
 * still provisional: the browser's write (never provisional) replaces the
 * server's and makes it final; a later server write (a parked reply's answer)
 * replaces its own earlier one; and once the browser wrote, nothing replaces
 * its copy. Postgres re-checks the mark under the row lock, so two racing
 * replaces can't undo the browser's.
 */
export async function persistEveMessage(
  supabase: SupabaseClient,
  opts: {
    conversationId: string
    /** Tenancy from the verified chat-run token — asserted against the owner row. */
    userId: string
    workspaceId: string
    role?: 'assistant' | 'user'
    /** The finalized UIMessage parts (already in the client's rendered shape). */
    parts: EveMessagePart[]
    /** Stable message id → drives ui_message_id dedup. Same id the client rendered. */
    messageId: string
    /** Merged into ui_message.metadata alongside the eve_written discriminant. */
    metadata?: Record<string, unknown>
    /** The reply backup's copy: stamped EVE_PROVISIONAL_METADATA_KEY, so a later write of the message replaces it. */
    provisional?: boolean
  },
): Promise<EveMessageResult> {
  try {
    const owner = await loadConversationOwner(supabase, opts.conversationId)
    if (!owner) {
      return { written: false, reason: 'no_conversation', conversationActivityFired: false }
    }

    // The token scopes the caller to ONE conversation; assert its tenancy is the
    // conversation's actual owner. A mismatch means a token minted for a
    // different (user, workspace) — never write into someone else's thread.
    if (owner.ownerUserId !== opts.userId || owner.workspaceId !== opts.workspaceId) {
      return {
        written: false,
        conversationId: opts.conversationId,
        reason: 'owner_mismatch',
        conversationActivityFired: false,
      }
    }

    const role = opts.role ?? 'assistant'
    const uiMessage = {
      id: opts.messageId,
      role,
      // No stored mail: a mail tool's output is kept as a pointer (./mail-tool-scrub.ts).
      parts: opts.parts.map(scrubMailPart),
      metadata: {
        [EVE_WRITTEN_METADATA_KEY]: true,
        ...(opts.metadata ?? {}),
        ...(opts.provisional ? { [EVE_PROVISIONAL_METADATA_KEY]: true } : {}),
      },
    }

    const { data: inserted, error } = await supabase
      .from('chat_messages')
      .upsert(
        {
          conversation_id: opts.conversationId,
          user_id: owner.ownerUserId,
          workspace_id: owner.workspaceId,
          role,
          ui_message: uiMessage,
        },
        // Stable id + ignoreDuplicates: a replay/retry of the same message id
        // converges on the existing row instead of duplicating the bubble.
        { onConflict: 'conversation_id,ui_message_id', ignoreDuplicates: true },
      )
      // `select` after an ignoreDuplicates upsert returns the row ONLY when a new
      // row was inserted (a dedup no-op returns none) — that's exactly the
      // once-per-turn signal we want for the knowledge hook.
      .select('id')

    if (error) {
      console.warn(
        `eve-message-writer: persist failed (conversation ${opts.conversationId}):`,
        error.message,
      )
      return {
        written: false,
        conversationId: opts.conversationId,
        reason: 'error',
        conversationActivityFired: false,
      }
    }

    const didInsert = Array.isArray(inserted) && inserted.length > 0
    // Already stored: replace it if it is the reply backup's provisional copy.
    // Only replies are ever provisional, so a user message skips the query.
    const replaced = !didInsert && role === 'assistant' && (await replaceProvisional(supabase, opts.conversationId, opts.messageId, uiMessage))

    // Bump the conversation so it sorts to the top of the history list.
    void supabase
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', opts.conversationId)
      .then(undefined, () => {})

    return {
      written: didInsert,
      ...(replaced ? { replaced: true } : {}),
      conversationId: opts.conversationId,
      messageId: opts.messageId,
      // Fire the knowledge hook only when a NEW row landed — never on a dedup
      // no-op, so a replayed turn doesn't re-trigger extraction (the debounce
      // would absorb it anyway, but this keeps the contract explicit + testable).
      conversationActivityFired: didInsert,
    }
  } catch (err) {
    console.warn(
      `eve-message-writer: persist threw (conversation ${opts.conversationId}):`,
      err,
    )
    return { written: false, reason: 'error', conversationActivityFired: false }
  }
}
