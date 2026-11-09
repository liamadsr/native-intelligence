/**
 * Team chat's reads and writes (migration 474), always as the person: every
 * call takes THEIR Supabase client (the route's, under RLS), so a channel they
 * may not read is one these never see. Channels and DMs are created, and read
 * marks written, through 474's functions (team_chat_create_channel,
 * team_chat_open_dm, team_chat_mark_read); messages are plain inserts and
 * updates the policies hold to the author. Only the agent's reply is written
 * with the service role (./agent-turn.ts).
 *
 * Each function throws a {@link TeamChatError} on a failed call, with a code
 * the routes turn into a status.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  TEAM_CHAT_MESSAGE_COLUMNS,
  TEAM_CHAT_PAGE_SIZE,
  dmOtherMember,
  type TeamChatChannel,
  type TeamChatMessage,
} from './types'

export type TeamChatErrorCode = 'not_found' | 'forbidden' | 'conflict' | 'bad_request' | 'failed'

export class TeamChatError extends Error {
  constructor(
    readonly code: TeamChatErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'TeamChatError'
  }
}

/** A Postgres error as a TeamChatError: 42501 forbidden, 23505 conflict, 22023/23514 bad request, else failed. */
export function teamChatErrorOf(error: { code?: string; message?: string } | null | undefined, what: string): TeamChatError {
  const code = error?.code
  if (code === '42501') return new TeamChatError('forbidden', `${what}: not allowed`)
  if (code === '23505') return new TeamChatError('conflict', `${what}: already exists`)
  if (code === '22023' || code === '23514' || code === '22P02') return new TeamChatError('bad_request', `${what}: invalid`)
  return new TeamChatError('failed', `${what} failed${error?.message ? `: ${error.message}` : ''}`)
}

interface ChannelRow {
  id: string
  kind: 'channel' | 'dm'
  name: string | null
  topic: string | null
  team_id: string | null
  dm_key: string | null
  last_message_at: string | null
  archived_at: string | null
  created_at: string
}

/**
 * The channels and DMs the person may read in this workspace, with their
 * unread counts: unread first, then the newest message first. Archived
 * channels are left out.
 */
export async function listChannels(supabase: SupabaseClient, scope: { workspaceId: string; memberId: string }): Promise<TeamChatChannel[]> {
  const [channels, unread] = await Promise.all([
    supabase
      .from('team_chat_channel')
      .select('id, kind, name, topic, team_id, dm_key, last_message_at, archived_at, created_at')
      .eq('workspace_id', scope.workspaceId)
      .is('archived_at', null)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(500),
    supabase.rpc('team_chat_unread', { ws: scope.workspaceId }),
  ])
  if (channels.error) throw teamChatErrorOf(channels.error, 'channels read')
  if (unread.error) throw teamChatErrorOf(unread.error, 'unread read')
  const counts = new Map<string, { unread: number; mentions: number }>()
  for (const row of (unread.data ?? []) as Array<{ channel_id: string; unread: number; mentions: number }>) {
    counts.set(row.channel_id, { unread: Number(row.unread) || 0, mentions: Number(row.mentions) || 0 })
  }
  return ((channels.data ?? []) as ChannelRow[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    name: row.name,
    topic: row.topic,
    team_id: row.team_id,
    dm_member_id: row.kind === 'dm' ? dmOtherMember(row.dm_key, scope.memberId) : null,
    last_message_at: row.last_message_at ?? row.created_at,
    archived_at: row.archived_at,
    unread: counts.get(row.id)?.unread ?? 0,
    mentions: counts.get(row.id)?.mentions ?? 0,
  }))
}

/** One channel the person may read, or null. */
export async function getChannel(supabase: SupabaseClient, channelId: string): Promise<(ChannelRow & { workspace_id: string }) | null> {
  const { data, error } = await supabase
    .from('team_chat_channel')
    .select('id, workspace_id, kind, name, topic, team_id, dm_key, last_message_at, archived_at, created_at')
    .eq('id', channelId)
    .maybeSingle<ChannelRow & { workspace_id: string }>()
  if (error) throw teamChatErrorOf(error, 'channel read')
  return data ?? null
}

/** A page of a channel's messages, oldest first: the newest page, or the one before `before` (a message's created_at). */
export async function listMessages(
  supabase: SupabaseClient,
  channelId: string,
  opts: { before?: string; limit?: number } = {},
): Promise<TeamChatMessage[]> {
  const limit = Math.min(Math.max(opts.limit ?? TEAM_CHAT_PAGE_SIZE, 1), 200)
  let query = supabase
    .from('team_chat_message')
    .select(TEAM_CHAT_MESSAGE_COLUMNS)
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (opts.before) query = query.lt('created_at', opts.before)
  const { data, error } = await query
  if (error) throw teamChatErrorOf(error, 'messages read')
  return ((data ?? []) as TeamChatMessage[]).reverse()
}

/** Create a channel as the person (474's team_chat_create_channel). Returns its id. */
export async function createChannel(
  supabase: SupabaseClient,
  input: { workspaceId: string; name: string; teamId?: string | null; topic?: string | null },
): Promise<string> {
  const { data, error } = await supabase.rpc('team_chat_create_channel', {
    ws: input.workspaceId,
    channel_name: input.name,
    channel_team: input.teamId ?? null,
    channel_topic: input.topic ?? null,
  })
  if (error) throw teamChatErrorOf(error, 'channel create')
  if (typeof data !== 'string') throw new TeamChatError('failed', 'channel create returned no id')
  return data
}

/** Open (or find) the DM between the person and another member (474's team_chat_open_dm). Returns its id. */
export async function openDm(supabase: SupabaseClient, input: { workspaceId: string; memberId: string }): Promise<string> {
  const { data, error } = await supabase.rpc('team_chat_open_dm', { ws: input.workspaceId, other_member: input.memberId })
  if (error) throw teamChatErrorOf(error, 'dm open')
  if (typeof data !== 'string') throw new TeamChatError('failed', 'dm open returned no id')
  return data
}

/** Mark a channel read up to now for the person. */
export async function markRead(supabase: SupabaseClient, channelId: string): Promise<void> {
  const { error } = await supabase.rpc('team_chat_mark_read', { ch: channelId })
  if (error) throw teamChatErrorOf(error, 'mark read')
}

/** The ids among `ids` that are members of the workspace (a mention of anyone else is dropped). */
export async function workspaceMemberIds(supabase: SupabaseClient, workspaceId: string, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).in('id', [...ids])
  if (error) throw teamChatErrorOf(error, 'members read')
  const found = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))
  return ids.filter((id) => found.has(id))
}

/** Post a message as the person (RLS holds it to their own member row, in a channel they may post in). */
export async function postMessage(
  supabase: SupabaseClient,
  input: { workspaceId: string; channelId: string; memberId: string; body: string; mentions: string[]; mentionsAgent: boolean },
): Promise<TeamChatMessage> {
  const { data, error } = await supabase
    .from('team_chat_message')
    .insert({
      channel_id: input.channelId,
      workspace_id: input.workspaceId,
      author_kind: 'member',
      author_member_id: input.memberId,
      body: input.body,
      mentions: input.mentions,
      mentions_agent: input.mentionsAgent,
    })
    .select(TEAM_CHAT_MESSAGE_COLUMNS)
    .single<TeamChatMessage>()
  if (error) throw teamChatErrorOf(error, 'message post')
  return data
}

/** Edit the person's own message (the guard stamps edited_at). Null when it is not theirs, deleted or gone. */
export async function editMessage(supabase: SupabaseClient, messageId: string, input: { body: string; mentions: string[] }): Promise<TeamChatMessage | null> {
  const { data, error } = await supabase
    .from('team_chat_message')
    .update({ body: input.body, mentions: input.mentions })
    .eq('id', messageId)
    .select(TEAM_CHAT_MESSAGE_COLUMNS)
    .maybeSingle<TeamChatMessage>()
  if (error) throw teamChatErrorOf(error, 'message edit')
  return data ?? null
}

/** Delete the person's own message (soft: the guard clears its words). False when it is not theirs, already deleted or gone. */
export async function deleteMessage(supabase: SupabaseClient, messageId: string, now: Date = new Date()): Promise<boolean> {
  const { data, error } = await supabase
    .from('team_chat_message')
    .update({ deleted_at: now.toISOString() })
    .eq('id', messageId)
    .select('id')
  if (error) throw teamChatErrorOf(error, 'message delete')
  return Array.isArray(data) && data.length > 0
}
