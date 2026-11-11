/**
 * A MAIN-CHAT TURN'S @-MENTIONS AS GRAPH EDGES: the person's conversation
 * mentions each record they named in their message (the chips the composer
 * attached: people, companies, captures, and MENTION_RECORD_KEYS' records), so
 * the record's "Referenced in" lists the chat.
 *
 * Private to the person: the source is their own conversation, and an edge
 * with a conversation end is readable only by whoever may read that
 * conversation (migration 500's edge rule, LINK_FENCED_KINDS), so no teammate
 * learns from it. Written through the shared helper (./mentions.ts), every
 * target fenced for the person; ADD-ONLY: each turn adds its mentions and none
 * is taken back (a sent message isn't edited).
 *
 * Ids are client-supplied (the turn's system context): tidied, capped and
 * fenced before anything is written. Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { MENTION_RECORD_KEYS, MENTION_RECORD_KINDS } from '@/lib/search/menu-search'
import { isMentionableType, tidyMentionRefs, type MentionRef } from './mentionable'
import { syncMentions } from './mentions'

/** The system-context keys of the chips that aren't records (people, companies, captures). */
const OTHER_KEYS = { attachedContactIds: 'contact', attachedCompanyIds: 'company', attachedNoteIds: 'capture' } as const

/** The records a turn's system context names, as mention refs (tidied: well-formed, distinct, capped). */
export function turnMentionRefs(systemContext: Record<string, unknown> | null | undefined): MentionRef[] {
  if (!systemContext) return []
  const raw: Array<{ type: string; id: unknown }> = []
  const add = (type: string, ids: unknown) => {
    if (!Array.isArray(ids) || !isMentionableType(type)) return
    for (const id of ids) raw.push({ type, id })
  }
  for (const [key, type] of Object.entries(OTHER_KEYS)) add(type, systemContext[key])
  for (const kind of MENTION_RECORD_KINDS) add(kind, systemContext[MENTION_RECORD_KEYS[kind].context])
  return tidyMentionRefs(raw)
}

/**
 * Add the turn's mentions to the conversation's edges. Only the person's own
 * conversation in this workspace is ever a source (read and checked first).
 */
export async function syncTurnMentions(
  supabase: SupabaseClient,
  input: { workspaceId: string; userId: string; conversationId: string; systemContext: Record<string, unknown> | null | undefined },
): Promise<void> {
  const targets = turnMentionRefs(input.systemContext)
  if (targets.length === 0) return
  try {
    const [{ data: conversation }, { data: member }] = await Promise.all([
      supabase
        .from('chat_conversations')
        .select('id')
        .eq('id', input.conversationId)
        .eq('workspace_id', input.workspaceId)
        .eq('user_id', input.userId)
        .maybeSingle(),
      supabase.from('member').select('id').eq('workspace_id', input.workspaceId).eq('user_id', input.userId).maybeSingle(),
    ])
    if (!conversation || !member) return
    const result = await syncMentions(supabase, {
      workspaceId: input.workspaceId,
      source: { type: 'conversation', id: input.conversationId },
      targets,
      userId: input.userId,
      memberId: (member as { id: string }).id,
      addOnly: true,
    })
    if (result.error) console.warn(`[turn-mentions] conversation=${input.conversationId} failed:`, result.error)
  } catch (err) {
    console.warn('[turn-mentions] threw:', err instanceof Error ? err.message : 'unknown')
  }
}
