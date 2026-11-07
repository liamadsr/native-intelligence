import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Server-side writer for the live capture's chat conversation.
 *
 * The live-agent → chat merge (docs/live-agent-chat-merge/PLAN.md) makes the
 * main chat the authoritative surface for everything the meeting agent says:
 * the greeting, say_to_user heads-ups, proposal batches, and questions land as
 * assistant `chat_messages` rows in the capture's conversation, delivered to
 * the open panel via Realtime postgres_changes (migration 173).
 *
 * SECURITY CONTRACT (plan D4): callers on the desktop path authenticate with a
 * device token, which `authenticateUser` resolves to a SERVICE-ROLE client —
 * RLS is NOT a backstop here. So this writer derives `user_id` (the capture
 * OWNER) and `workspace_id` from the capture row itself and never accepts
 * either from the caller. A misbehaving caller can therefore only write into
 * the conversation the capture already owns, never into another user's thread.
 *
 * Every write is best-effort by design: the conversation surface must never
 * fail staging/extraction. Callers get a discriminated result, not a throw.
 */

/** Loose UIMessage part shape — the chat renders whatever parts it knows. */
export type AgentMessagePart = Record<string, unknown> & { type: string }

export interface AgentMessageResult {
  written: boolean
  conversationId?: string
  messageId?: string
  /** Why nothing was written (no conversation, or an error). */
  reason?: 'no_conversation' | 'error'
}

// No say_to_user throttle any more. It held one chat bubble per 20 s (plan D8,
// for the old chatty agent) while the HUD broadcast fired regardless, so a
// nudge inside the window reached the HUD with no row: missing from
// already-told (the sidekick could repeat it) and impossible to rate. Every
// delivered nudge now writes its row; the sidekick's own quiet rules keep it
// sparse. say_to_user was the only kind it ever covered.

interface CaptureOwner {
  ownerUserId: string
  workspaceId: string
}

async function loadCaptureOwner(
  supabase: SupabaseClient,
  captureId: string,
): Promise<CaptureOwner | null> {
  const { data } = await supabase
    .from('captures')
    .select('user_id, workspace_id')
    .eq('id', captureId)
    .maybeSingle()
  if (!data?.user_id || !data?.workspace_id) return null
  return { ownerUserId: data.user_id as string, workspaceId: data.workspace_id as string }
}

async function findConversation(
  supabase: SupabaseClient,
  captureId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from('chat_conversations')
    .select('id')
    .eq('capture_id', captureId)
    .maybeSingle()
  return (data?.id as string | undefined) ?? null
}

/**
 * Append one assistant message to the capture's conversation.
 *
 * No-ops (written:false) when the capture has no conversation — a live capture
 * recorded before the merged UI existed, or the create endpoint failed; the
 * agent's output still reaches proposals/summary/HUD through its normal paths.
 */
export async function appendAgentMessage(
  supabase: SupabaseClient,
  opts: {
    captureId: string
    parts: AgentMessagePart[]
    /** Merged into ui_message.metadata alongside live_capture/capture_id. */
    metadata?: Record<string, unknown>
    /** Stable id → the DB unique index makes retries/races idempotent. */
    messageId?: string
  },
): Promise<AgentMessageResult> {
  try {
    const owner = await loadCaptureOwner(supabase, opts.captureId)
    if (!owner) return { written: false, reason: 'no_conversation' }

    const conversationId = await findConversation(supabase, opts.captureId)
    if (!conversationId) return { written: false, reason: 'no_conversation' }

    const messageId = opts.messageId ?? crypto.randomUUID()
    const uiMessage = {
      id: messageId,
      role: 'assistant' as const,
      parts: opts.parts,
      metadata: {
        live_capture: true,
        capture_id: opts.captureId,
        ...(opts.metadata ?? {}),
      },
    }

    const { error } = await supabase.from('chat_messages').upsert(
      {
        conversation_id: conversationId,
        user_id: owner.ownerUserId,
        workspace_id: owner.workspaceId,
        role: 'assistant',
        ui_message: uiMessage,
      },
      // Stable message ids make double-writes (greeting race, staging retry)
      // converge on one row instead of duplicating bubbles.
      { onConflict: 'conversation_id,ui_message_id', ignoreDuplicates: true },
    )
    if (error) {
      console.warn(`conversation-writer: append failed (capture ${opts.captureId}):`, error.message)
      return { written: false, conversationId, reason: 'error' }
    }

    // Bump the conversation so it sorts to the top of the history list.
    void supabase
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .then(undefined, () => {})

    return { written: true, conversationId, messageId }
  } catch (err) {
    console.warn(`conversation-writer: append threw (capture ${opts.captureId}):`, err)
    return { written: false, reason: 'error' }
  }
}

/**
 * True if the capture's conversation already has an UNANSWERED ask_user tool
 * part (a message whose part is still input-available). Enforces "one pending
 * question at a time" (plan D8) so the agent can't stack pickers on the user.
 * Best-effort: any error resolves to false (better to allow one extra question
 * than to wedge the agent).
 */
export async function hasPendingLiveQuestion(
  supabase: SupabaseClient,
  captureId: string,
): Promise<boolean> {
  try {
    const conversationId = await findConversation(supabase, captureId)
    if (!conversationId) return false
    // Recent assistant messages tagged as ask_user; check whether any still has
    // an input-available tool part (unanswered). We only need the last few.
    const { data: rows } = await supabase
      .from('chat_messages')
      .select('ui_message')
      .eq('conversation_id', conversationId)
      .eq('role', 'assistant')
      .filter('ui_message->metadata->>kind', 'eq', 'ask_user')
      .order('created_at', { ascending: false })
      .limit(5)
    for (const row of rows ?? []) {
      const parts =
        ((row.ui_message as { parts?: Array<{ type?: string; state?: string }> })?.parts) ?? []
      const pending = parts.some(
        (p) => p.type === 'tool-ask_user' && p.state === 'input-available',
      )
      if (pending) return true
    }
    return false
  } catch {
    return false
  }
}

/**
 * The rolling "proposals from this meeting" card (plan D8): ONE message per
 * capture whose `data-proposals` part accumulates proposal ids, rather than a
 * fresh bubble every staging turn (which would flood a busy meeting's thread).
 * Idempotent: a stable per-capture message id + a re-read of the capture's
 * pending/applied proposals means each call just reflects the current set. The
 * chat card renders each id live off the proposed_change row feed, so the card
 * stays truthful as proposals get accepted/dismissed elsewhere.
 *
 * No-ops when the capture has no conversation, or has zero non-dismissed
 * proposals (nothing to show yet).
 */
export async function syncProposalsCard(
  supabase: SupabaseClient,
  captureId: string,
): Promise<AgentMessageResult> {
  try {
    const owner = await loadCaptureOwner(supabase, captureId)
    if (!owner) return { written: false, reason: 'no_conversation' }
    const conversationId = await findConversation(supabase, captureId)
    if (!conversationId) return { written: false, reason: 'no_conversation' }

    // Non-dismissed proposals for this capture — the card shows pending +
    // applied (each chip reflects its own row's live status).
    const { data: rows } = await supabase
      .from('proposed_change')
      .select('id')
      .eq('capture_id', captureId)
      .eq('workspace_id', owner.workspaceId)
      .in('status', ['pending', 'applied'])
      .order('sort_order')
    const proposalIds = (rows ?? []).map((r) => r.id as string)
    if (proposalIds.length === 0) return { written: false, reason: 'no_conversation' }

    const messageId = `proposals-${captureId}`
    const uiMessage = {
      id: messageId,
      role: 'assistant' as const,
      parts: [
        {
          type: 'text',
          text:
            proposalIds.length === 1
              ? "Here's what I've captured from this meeting so far:"
              : `Here's what I've captured from this meeting so far (${proposalIds.length} items):`,
        },
        { type: 'data-proposals', data: { capture_id: captureId, proposal_ids: proposalIds } },
      ],
      metadata: { live_capture: true, capture_id: captureId, kind: 'proposals' },
    }

    // Upsert (insert-or-replace) on the stable id so the card grows in place.
    const { error } = await supabase.from('chat_messages').upsert(
      {
        conversation_id: conversationId,
        user_id: owner.ownerUserId,
        workspace_id: owner.workspaceId,
        role: 'assistant',
        ui_message: uiMessage,
      },
      { onConflict: 'conversation_id,ui_message_id' },
    )
    if (error) {
      console.warn(`conversation-writer: proposals card failed (capture ${captureId}):`, error.message)
      return { written: false, conversationId, reason: 'error' }
    }
    void supabase
      .from('chat_conversations')
      .update({ updated_at: new Date().toISOString() })
      .eq('id', conversationId)
      .then(undefined, () => {})
    return { written: true, conversationId, messageId }
  } catch (err) {
    console.warn(`conversation-writer: proposals card threw (capture ${captureId}):`, err)
    return { written: false, reason: 'error' }
  }
}

/**
 * Replace an existing agent message's ui_message in place (same id) — the
 * rolling proposals card (plan D8) grows by UPDATE, not by new bubbles. The
 * client's Realtime subscription applies UPDATE events by message id.
 */
export async function updateAgentMessage(
  supabase: SupabaseClient,
  opts: {
    captureId: string
    messageId: string
    parts: AgentMessagePart[]
    metadata?: Record<string, unknown>
  },
): Promise<AgentMessageResult> {
  try {
    const conversationId = await findConversation(supabase, opts.captureId)
    if (!conversationId) return { written: false, reason: 'no_conversation' }

    const uiMessage = {
      id: opts.messageId,
      role: 'assistant' as const,
      parts: opts.parts,
      metadata: {
        live_capture: true,
        capture_id: opts.captureId,
        ...(opts.metadata ?? {}),
      },
    }
    const { error } = await supabase
      .from('chat_messages')
      .update({ ui_message: uiMessage })
      .eq('conversation_id', conversationId)
      .eq('ui_message_id', opts.messageId)
    if (error) {
      console.warn(`conversation-writer: update failed (capture ${opts.captureId}):`, error.message)
      return { written: false, conversationId, reason: 'error' }
    }
    return { written: true, conversationId, messageId: opts.messageId }
  } catch (err) {
    console.warn(`conversation-writer: update threw (capture ${opts.captureId}):`, err)
    return { written: false, reason: 'error' }
  }
}
