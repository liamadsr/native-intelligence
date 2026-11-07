import type { SupabaseClient } from '@supabase/supabase-js'
import { HomeThreadUnavailableError, ensureHomeThread } from '@/lib/chat/home-thread'

/**
 * A member's "home conversation" for conversational onboarding ("the dashboard
 * is the reveal") IS their home thread (docs/plans/always-on-agent.md §2c, A3):
 * the `chat_conversations` row with `is_home = true` for that person in that
 * workspace (migration 330), got or created by ensureHomeThread.
 *
 * It used to be a pointer in `member.onboarding_progress.conversation
 * .homeConversationId`, written with a CAS around the shallow-merge clobber
 * trap. Migration 330 backfilled the column from that pointer, and nothing
 * reads or writes the pointer any more: the unique index does the race-safety
 * the CAS did.
 *
 * Titled "Home" when created here (HOME_THREAD_TITLE): it is the person's
 * conversation for good, not an onboarding one.
 *
 * The member row is still checked first, as the pointer read did: a caller
 * who is not a member of the workspace gets null, never a row.
 *
 * SECURITY: tenancy (userId, workspaceId) is always caller-supplied from a
 * verified principal, never model/tool/request input. The row is that pair's
 * alone.
 */

/**
 * Get-or-create the member's home thread. Returns its id and whether this call
 * created the row, or null when there is no member row or a read/write failed.
 * Throws HomeThreadUnavailableError on a database without migration 330.
 */
export async function resolveHomeConversation(
  supabase: SupabaseClient,
  opts: { userId: string; workspaceId: string; title?: string },
): Promise<{ conversationId: string; created: boolean } | null> {
  const { userId, workspaceId } = opts
  try {
    const { data: member, error } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .maybeSingle<{ id: string }>()
    if (error) {
      console.warn('home-conversation: member read failed:', error.message)
      return null
    }
    if (!member) return null
    const thread = await ensureHomeThread(supabase, { userId, workspaceId, ...(opts.title ? { title: opts.title } : {}) })
    return { conversationId: thread.id, created: thread.created }
  } catch (err) {
    // No home thread column yet (migration 330): the caller says so.
    if (err instanceof HomeThreadUnavailableError) throw err
    console.warn('home-conversation: home thread failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}
