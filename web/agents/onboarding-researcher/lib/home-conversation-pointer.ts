/**
 * Agent-tree MIRROR of src/lib/onboarding/home-conversation-pointer.ts and
 * src/lib/chat/home-thread.ts (ensureHomeThread).
 *
 * WHY A MIRROR (not an import of src/): the eve compile bundles ONLY this
 * agent's tree (agents/onboarding-researcher/*), so a tool cannot import from
 * src/. The member's home conversation IS their home thread
 * (docs/plans/always-on-agent.md §2c, A3): the `chat_conversations` row with
 * `is_home = true` for that person in that workspace (migration 330). Same
 * get-or-create as the app's: read, an ignore-duplicates upsert on
 * (user_id, workspace_id, is_home), a re-read for the loser of a race. Keep
 * the two in sync. The old `member.onboarding_progress.conversation
 * .homeConversationId` pointer is never written; with no home row yet, the
 * conversation it names is adopted once (the app's adoptLegacyHome), when it
 * is the person's own plain row here.
 *
 * SECURITY: tenancy (userId, workspaceId) comes from the verified principal via
 * requireOwner(ctx), never from model input, before this is called. The member
 * row is checked first, so a non-member gets null, never a row.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** The home thread's title when created here (src/lib/chat/home-thread.ts HOME_THREAD_TITLE). */
const HOME_THREAD_TITLE = 'Home'

interface HomeRow {
  id: string
}

async function readHome(service: SupabaseClient, userId: string, workspaceId: string): Promise<HomeRow | null> {
  const { data, error } = await service
    .from('chat_conversations')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .eq('is_home', true)
    .maybeSingle<HomeRow>()
  if (error) throw new Error(`home thread lookup failed: ${error.message}`)
  return data ?? null
}

/**
 * Get-or-create the member's home thread. Idempotent and race-safe (the unique
 * index). Returns the conversation id and whether this call created the row,
 * or null on no member row or a failed read/write.
 */
export async function resolveHomeConversation(
  service: SupabaseClient,
  userId: string,
  workspaceId: string,
): Promise<{ conversationId: string; created: boolean } | null> {
  try {
    const { data: member, error: memberErr } = await service
      .from('member')
      .select('id, onboarding_progress')
      .eq('user_id', userId)
      .eq('workspace_id', workspaceId)
      .maybeSingle<{ id: string; onboarding_progress?: Record<string, unknown> | null }>()
    if (memberErr) {
      console.warn('home-conversation: member read failed:', memberErr.message)
      return null
    }
    if (!member) return null

    const existing = await readHome(service, userId, workspaceId)
    if (existing) return { conversationId: existing.id, created: false }

    // The old onboarding pointer's conversation, adopted once (a read of the
    // pointer only), when it is the person's own plain row here.
    const pointer = (member.onboarding_progress?.conversation as { homeConversationId?: unknown } | undefined)?.homeConversationId
    if (typeof pointer === 'string' && pointer) {
      const { data: row, error: rowErr } = await service
        .from('chat_conversations')
        .select('id, ai_team_member_id, agent_teammate_id, capture_id, focus_area, is_home')
        .eq('id', pointer)
        .eq('user_id', userId)
        .eq('workspace_id', workspaceId)
        .maybeSingle<{ id: string; ai_team_member_id: string | null; agent_teammate_id: string | null; capture_id: string | null; focus_area: string | null; is_home: boolean | null }>()
      // A failed read makes nothing: an empty home thread would hide the
      // onboarding conversation for good, while the next call can retry.
      if (rowErr) {
        console.warn('home-conversation: onboarding conversation read failed:', rowErr.message)
        return null
      }
      if (row && !row.ai_team_member_id && !row.agent_teammate_id && !row.capture_id && !row.focus_area) {
        const { error: adoptErr } = await service
          .from('chat_conversations')
          .update({ is_home: true })
          .eq('id', row.id)
          .eq('user_id', userId)
          .eq('workspace_id', workspaceId)
          .is('is_home', null)
        if (!adoptErr || adoptErr.code === '23505') {
          const home = await readHome(service, userId, workspaceId)
          if (home) return { conversationId: home.id, created: false }
        }
      }
    }

    const { data: created, error } = await service
      .from('chat_conversations')
      .upsert(
        { user_id: userId, workspace_id: workspaceId, is_home: true, title: HOME_THREAD_TITLE },
        { onConflict: 'user_id,workspace_id,is_home', ignoreDuplicates: true },
      )
      .select('id')
      .maybeSingle<HomeRow>()
    if (error) throw new Error(`home thread create failed: ${error.message}`)
    if (created) return { conversationId: created.id, created: true }

    const raced = await readHome(service, userId, workspaceId)
    return raced ? { conversationId: raced.id, created: false } : null
  } catch (err) {
    console.warn('home-conversation:', err instanceof Error ? err.message : String(err))
    return null
  }
}
