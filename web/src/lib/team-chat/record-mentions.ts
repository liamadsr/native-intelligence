/**
 * The records a team-chat message @-mentions (migration 480): what the client
 * sent, tidied and fenced for the author before it is stored on the message,
 * and the message's `mentions` edges kept in step with it on post, edit and
 * delete (the shared helper, src/lib/entity-links/mentions.ts). Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { syncMentions, visibleMentionTargets } from '@/lib/entity-links/mentions'
import { mentionKey, tidyLabeledMentionRefs } from '@/lib/entity-links/mentionable'
import { hasMention } from './compose'
import type { TeamChatRecordMention } from './types'

/**
 * The client's `records`, kept only while its `@label` is still in the words
 * and the author may read the record in this workspace (fenced: a foreign or
 * private id is dropped, never an error).
 */
export async function fenceRecordMentions(
  supabase: SupabaseClient,
  scope: { workspaceId: string; userId: string },
  raw: unknown,
  body: string,
): Promise<TeamChatRecordMention[]> {
  const asked = tidyLabeledMentionRefs(raw).filter((r) => hasMention(body, r.label))
  if (asked.length === 0) return []
  const visible = new Set((await visibleMentionTargets(supabase, scope, asked)).map(mentionKey))
  return asked.filter((r) => visible.has(mentionKey(r)))
}

/**
 * The message's `mentions` edges, matched to `records` (none, for a deleted
 * message). `records` came through fenceRecordMentions. A failure is logged,
 * never thrown: the message itself is already saved.
 */
export async function syncMessageMentions(
  supabase: SupabaseClient,
  input: { workspaceId: string; messageId: string; userId: string; memberId: string | null; records: readonly TeamChatRecordMention[] },
): Promise<void> {
  const result = await syncMentions(supabase, {
    workspaceId: input.workspaceId,
    source: { type: 'team_chat_message', id: input.messageId },
    targets: input.records.map(({ type, id }) => ({ type, id })),
    userId: input.userId,
    memberId: input.memberId,
    fenced: true,
  })
  if (result.error) console.warn(`[team-chat] mention edges for message=${input.messageId} failed:`, result.error)
}

/**
 * The records a message mentions now (its `record_mentions`), read through the
 * caller's RLS: what an edit from a client that sends no `records` (one from
 * before 480) keeps. None when it can't be read.
 */
export async function storedRecordMentions(supabase: SupabaseClient, messageId: string): Promise<unknown> {
  const { data, error } = await supabase.from('team_chat_message').select('record_mentions').eq('id', messageId).maybeSingle()
  if (error || !data) return []
  return (data as { record_mentions?: unknown }).record_mentions ?? []
}
