/**
 * Sharing an agent chat (docs/plans/mentions-everywhere.md, decision 1 and
 * JOB 2). A chat with the agent is its owner's alone (chat_conversations RLS),
 * but mentioning your own chat where teammates read it lets those readers open
 * it, read only. The share is a `conversation_share` row (migration 671): the
 * owner names a workspace member as grantee, and the SELECT policies 671 adds
 * to chat_conversations and chat_messages let that grantee READ the live rows.
 * Nothing of the chat is copied.
 *
 * SESSION CLIENT: the insert policy checks the caller owns the conversation
 * (chat_conversations.user_id = auth.uid()), so a share of a chat that is not
 * the caller's own, or a duplicate, is simply not written — never an error.
 * FAIL-SOFT: a share is never worth failing the comment that rode it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export interface ShareConversationResult {
  /** Members a share row was offered for (the insert policy still has the last word). */
  shared: number
  error?: string
}

export async function shareConversationWithMembers(
  supabase: SupabaseClient,
  input: { workspaceId: string; conversationId: string; userId: string; memberIds: readonly string[] },
): Promise<ShareConversationResult> {
  const grantees = [...new Set(input.memberIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (!grantees.length || !input.conversationId) return { shared: 0 }
  try {
    const { error } = await supabase.from('conversation_share').upsert(
      grantees.map((memberId) => ({
        workspace_id: input.workspaceId,
        conversation_id: input.conversationId,
        shared_by: input.userId,
        grantee_member_id: memberId,
        source: 'mention',
      })),
      { onConflict: 'conversation_id,grantee_member_id', ignoreDuplicates: true },
    )
    if (error) {
      console.warn('[conversation-share] share failed:', error.message)
      return { shared: 0, error: error.message }
    }
    return { shared: grantees.length }
  } catch (err) {
    console.warn('[conversation-share] threw:', err instanceof Error ? err.message : 'unknown')
    return { shared: 0, error: 'threw' }
  }
}
