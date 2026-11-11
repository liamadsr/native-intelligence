/**
 * Team chat's reads and writes (migration 474), always as the person: every
 * call takes THEIR Supabase client (the route's, under RLS), so a channel they
 * may not read is one these never see. Channels and DMs are created, and read
 * marks written, through 474's functions (team_chat_create_channel,
 * team_chat_open_dm, team_chat_mark_read); messages are plain inserts and
 * updates the policies hold to the author. Only the agent's reply and a
 * message's link preview are written with the service role (./agent-turn.ts,
 * ./link-preview.ts). Threads, reactions and files (migrations 555-558) are
 * read the same way; a reaction and a thread's read mark go through their
 * functions (team_chat_react, team_chat_mark_thread_read).
 *
 * Each function throws a {@link TeamChatError} on a failed call, with a code
 * the routes turn into a status.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  TEAM_CHAT_MESSAGE_COLUMNS,
  TEAM_CHAT_PAGE_SIZE,
  TEAM_CHAT_THREAD_MAX,
  dmOtherMember,
  type TeamChatAttachment,
  type TeamChatChannel,
  type TeamChatMessage,
  type TeamChatReaction,
  type TeamChatRecordMention,
  type TeamChatThreadSummary,
  type TeamChatThreadUnread,
} from './types'
import { TEAM_CHAT_FILE_MAX_BYTES, TEAM_CHAT_FILES_BUCKET, teamChatFileType } from './files'
import { notifyLevelOf, type TeamChatNotifyLevel } from './notify'

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
 * channels are left out. `threads` are the threads they are in with replies
 * they haven't read (migration 556); each channel's thread_unread is its
 * threads' summed. Each carries how loud it is for them (migration 560's
 * notify_level, else the kind's default); a muted one counts its mentions
 * only.
 */
export async function listChannels(
  supabase: SupabaseClient,
  scope: { workspaceId: string; memberId: string },
): Promise<{ channels: TeamChatChannel[]; threads: TeamChatThreadUnread[] }> {
  const [channels, unread, threadUnread, levels] = await Promise.all([
    supabase
      .from('team_chat_channel')
      .select('id, kind, name, topic, team_id, dm_key, last_message_at, archived_at, created_at')
      .eq('workspace_id', scope.workspaceId)
      .is('archived_at', null)
      .order('last_message_at', { ascending: false, nullsFirst: false })
      .limit(500),
    supabase.rpc('team_chat_unread', { ws: scope.workspaceId }),
    supabase.rpc('team_chat_thread_unread', { ws: scope.workspaceId }),
    // Their own rows only (474's policy): how loud each channel is for them.
    supabase.from('team_chat_member').select('channel_id, notify_level').eq('workspace_id', scope.workspaceId).eq('member_id', scope.memberId),
  ])
  if (channels.error) throw teamChatErrorOf(channels.error, 'channels read')
  if (unread.error) throw teamChatErrorOf(unread.error, 'unread read')
  if (threadUnread.error) throw teamChatErrorOf(threadUnread.error, 'thread unread read')
  if (levels.error) throw teamChatErrorOf(levels.error, 'levels read')
  const levelOf = new Map(((levels.data ?? []) as Array<{ channel_id: string; notify_level: string | null }>).map((r) => [r.channel_id, r.notify_level]))
  const counts = new Map<string, { unread: number; mentions: number }>()
  for (const row of (unread.data ?? []) as Array<{ channel_id: string; unread: number; mentions: number }>) {
    counts.set(row.channel_id, { unread: Number(row.unread) || 0, mentions: Number(row.mentions) || 0 })
  }
  const threads = ((threadUnread.data ?? []) as TeamChatThreadUnread[]).map((t) => ({
    root_id: t.root_id,
    channel_id: t.channel_id,
    unread: Number(t.unread) || 0,
    mentions: Number(t.mentions) || 0,
  }))
  const inThreads = new Map<string, { unread: number; mentions: number }>()
  for (const t of threads) {
    const sum = inThreads.get(t.channel_id) ?? { unread: 0, mentions: 0 }
    inThreads.set(t.channel_id, { unread: sum.unread + t.unread, mentions: sum.mentions + t.mentions })
  }
  const list = ((channels.data ?? []) as ChannelRow[]).map((row): TeamChatChannel => {
    const notify = notifyLevelOf(row.kind, levelOf.get(row.id))
    const muted = notify === 'muted'
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      topic: row.topic,
      team_id: row.team_id,
      dm_member_id: row.kind === 'dm' ? dmOtherMember(row.dm_key, scope.memberId) : null,
      last_message_at: row.last_message_at ?? row.created_at,
      archived_at: row.archived_at,
      // Muted: no unread count, only its mentions.
      unread: muted ? 0 : (counts.get(row.id)?.unread ?? 0),
      mentions: counts.get(row.id)?.mentions ?? 0,
      thread_unread: muted ? 0 : (inThreads.get(row.id)?.unread ?? 0),
      thread_mentions: inThreads.get(row.id)?.mentions ?? 0,
      notify,
    }
  })
  return { channels: list, threads }
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

/** Around a message: how many before it, and the most after it (more: the page shows alone, with a way to the newest). */
export const TEAM_CHAT_AROUND_BEFORE = 25
export const TEAM_CHAT_AROUND_AFTER = 200

/**
 * The page around one of the channel's own messages (the person may read
 * it: RLS): TEAM_CHAT_AROUND_BEFORE before it, then it and on to the newest
 * when that is at most TEAM_CHAT_AROUND_AFTER (`hasNewer` false: the page
 * runs on unbroken to now), else that many from it (`hasNewer` true).
 * `hasOlder`: there are messages before the page. Null when it is no message
 * of this channel's own (another channel's, a thread's reply, gone).
 */
export async function listMessagesAround(
  supabase: SupabaseClient,
  channelId: string,
  messageId: string,
): Promise<{ messages: TeamChatMessage[]; hasOlder: boolean; hasNewer: boolean } | null> {
  const target = await getMessage(supabase, messageId)
  if (!target || target.channel_id !== channelId || target.thread_root_id) return null
  const page = () => supabase.from('team_chat_message').select(TEAM_CHAT_MESSAGE_COLUMNS).eq('channel_id', channelId).is('thread_root_id', null)
  const [older, newer] = await Promise.all([
    page().lt('created_at', target.created_at).order('created_at', { ascending: false }).limit(TEAM_CHAT_AROUND_BEFORE + 1),
    page().gte('created_at', target.created_at).order('created_at', { ascending: true }).limit(TEAM_CHAT_AROUND_AFTER + 1),
  ])
  if (older.error) throw teamChatErrorOf(older.error, 'messages read')
  if (newer.error) throw teamChatErrorOf(newer.error, 'messages read')
  const before = (older.data ?? []) as TeamChatMessage[]
  const after = (newer.data ?? []) as TeamChatMessage[]
  return {
    messages: [...before.slice(0, TEAM_CHAT_AROUND_BEFORE).reverse(), ...after.slice(0, TEAM_CHAT_AROUND_AFTER)],
    hasOlder: before.length > TEAM_CHAT_AROUND_BEFORE,
    hasNewer: after.length > TEAM_CHAT_AROUND_AFTER,
  }
}

/**
 * A page of a channel's own messages (never a thread's replies), oldest
 * first: the newest page, or the one before `before` (a message's created_at).
 */
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
    .is('thread_root_id', null)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (opts.before) query = query.lt('created_at', opts.before)
  const { data, error } = await query
  if (error) throw teamChatErrorOf(error, 'messages read')
  return ((data ?? []) as TeamChatMessage[]).reverse()
}

/** One message the person may read, or null. */
export async function getMessage(supabase: SupabaseClient, messageId: string): Promise<TeamChatMessage | null> {
  const { data, error } = await supabase.from('team_chat_message').select(TEAM_CHAT_MESSAGE_COLUMNS).eq('id', messageId).maybeSingle<TeamChatMessage>()
  if (error) throw teamChatErrorOf(error, 'message read')
  return data ?? null
}

/** A thread's replies, oldest first (the newest TEAM_CHAT_THREAD_MAX). */
export async function listThread(supabase: SupabaseClient, rootId: string): Promise<TeamChatMessage[]> {
  const { data, error } = await supabase
    .from('team_chat_message')
    .select(TEAM_CHAT_MESSAGE_COLUMNS)
    .eq('thread_root_id', rootId)
    .order('created_at', { ascending: false })
    .limit(TEAM_CHAT_THREAD_MAX)
  if (error) throw teamChatErrorOf(error, 'thread read')
  return ((data ?? []) as TeamChatMessage[]).reverse()
}

/** The summaries of the threads among these roots (the ones with replies). */
export async function threadSummaries(supabase: SupabaseClient, rootIds: readonly string[]): Promise<TeamChatThreadSummary[]> {
  if (rootIds.length === 0) return []
  const { data, error } = await supabase
    .from('team_chat_thread')
    .select('root_id, channel_id, reply_count, last_reply_at, participant_ids')
    .in('root_id', [...rootIds])
  if (error) throw teamChatErrorOf(error, 'threads read')
  return (data ?? []) as TeamChatThreadSummary[]
}

/** The reactions on these messages (the ones on; never one taken back), oldest first. */
export async function messageReactions(supabase: SupabaseClient, messageIds: readonly string[]): Promise<TeamChatReaction[]> {
  if (messageIds.length === 0) return []
  const { data, error } = await supabase
    .from('team_chat_reaction')
    .select('message_id, member_id, emoji, active, created_at')
    .in('message_id', [...messageIds])
    .eq('active', true)
    .order('created_at', { ascending: true })
  if (error) throw teamChatErrorOf(error, 'reactions read')
  return ((data ?? []) as TeamChatReaction[]).map(({ message_id, member_id, emoji, active }) => ({ message_id, member_id, emoji, active }))
}

/** Turn the person's reaction on or off (557's team_chat_react). Returns the state now. */
export async function react(supabase: SupabaseClient, messageId: string, emoji: string, on: boolean): Promise<boolean> {
  const { data, error } = await supabase.rpc('team_chat_react', { msg: messageId, reaction: emoji, turn_on: on })
  if (error) throw teamChatErrorOf(error, 'react')
  return data === true
}

/** Mark a thread read up to now for the person (556's team_chat_mark_thread_read). */
export async function markThreadRead(supabase: SupabaseClient, rootId: string): Promise<void> {
  const { error } = await supabase.rpc('team_chat_mark_thread_read', { root: rootId })
  if (error) throw teamChatErrorOf(error, 'mark thread read')
}

/**
 * The attachments a client sent (already tidied: ./files.ts tidyAttachments),
 * checked against storage as the person: each must be an object there, its
 * size as storage measured it (never the client's word), within the cap, and
 * its type the one its extension is stored as. One that isn't there is
 * dropped.
 */
export async function attachmentsFromStorage(supabase: SupabaseClient, attachments: readonly TeamChatAttachment[]): Promise<TeamChatAttachment[]> {
  if (attachments.length === 0) return []
  const bucket = supabase.storage.from(TEAM_CHAT_FILES_BUCKET)
  const checked = await Promise.all(
    attachments.map(async (a): Promise<TeamChatAttachment | null> => {
      const folder = a.path.slice(0, a.path.lastIndexOf('/'))
      const objectName = a.path.slice(a.path.lastIndexOf('/') + 1)
      const { data, error } = await bucket.list(folder, { search: objectName, limit: 1 })
      const object = error ? null : data?.find((o) => o.name === objectName)
      if (!object) return null
      const size = Number((object.metadata as { size?: unknown } | null)?.size)
      const type = teamChatFileType(a.path)
      if (!type || !Number.isFinite(size) || size <= 0 || size > TEAM_CHAT_FILE_MAX_BYTES) return null
      return { ...a, size, type }
    }),
  )
  return checked.filter((a): a is TeamChatAttachment => a !== null)
}

/** Remove the person's own uploads (558's policy: only theirs). Never throws: the message is already gone. */
export async function removeFiles(supabase: SupabaseClient, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return
  try {
    const { error } = await supabase.storage.from(TEAM_CHAT_FILES_BUCKET).remove([...paths])
    if (error) console.warn('[team-chat] file remove failed:', error.message)
  } catch (err) {
    console.warn('[team-chat] file remove failed:', err instanceof Error ? err.message : 'unknown')
  }
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

/**
 * How loud a channel is for the person (560's team_chat_set_notify): every
 * message, mentions only, or muted; null puts the kind's default back.
 * Returns the level now in effect.
 */
export async function setNotifyLevel(supabase: SupabaseClient, channelId: string, level: TeamChatNotifyLevel | null): Promise<TeamChatNotifyLevel> {
  const { data, error } = await supabase.rpc('team_chat_set_notify', { ch: channelId, level })
  if (error) throw teamChatErrorOf(error, 'notify level')
  if (data !== 'all' && data !== 'mentions' && data !== 'muted') throw new TeamChatError('failed', 'notify level returned nothing')
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

/**
 * Post a message as the person (RLS holds it to their own member row, in a
 * channel they may post in; a thread reply, to a root of that channel). With
 * a `clientId`, a retried send is safe: the row the first try made (555's
 * unique index per author) comes back, `replayed`, never a second row.
 */
export async function postMessage(
  supabase: SupabaseClient,
  input: {
    workspaceId: string
    channelId: string
    memberId: string
    body: string
    mentions: string[]
    mentionsAgent: boolean
    /** The records it @-mentions, already fenced for the author (migration 480). */
    recordMentions?: TeamChatRecordMention[]
    /** The thread it replies in (any message of it: the database moves it onto the root). */
    threadRootId?: string | null
    /** Its files, checked against storage (attachmentsFromStorage). */
    attachments?: TeamChatAttachment[]
    /** The id the person's page minted for this send. */
    clientId?: string | null
  },
): Promise<{ message: TeamChatMessage; replayed: boolean }> {
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
      record_mentions: input.recordMentions ?? [],
      thread_root_id: input.threadRootId ?? null,
      attachments: input.attachments ?? [],
      client_id: input.clientId ?? null,
    })
    .select(TEAM_CHAT_MESSAGE_COLUMNS)
    .single<TeamChatMessage>()
  if (error?.code === '23505' && input.clientId) {
    // Sent before (a retry after an answer that never arrived): the row it made.
    const { data: sent, error: readError } = await supabase
      .from('team_chat_message')
      .select(TEAM_CHAT_MESSAGE_COLUMNS)
      .eq('author_member_id', input.memberId)
      .eq('client_id', input.clientId)
      .maybeSingle<TeamChatMessage>()
    if (readError) throw teamChatErrorOf(readError, 'message post')
    if (sent && sent.channel_id === input.channelId) return { message: sent, replayed: true }
    throw new TeamChatError('bad_request', 'message post: that send id was used for another message')
  }
  if (error) throw teamChatErrorOf(error, 'message post')
  return { message: data, replayed: false }
}

/** Edit the person's own message (the guard stamps edited_at). Null when it is not theirs, deleted or gone. */
export async function editMessage(
  supabase: SupabaseClient,
  messageId: string,
  input: { body: string; mentions: string[]; recordMentions?: TeamChatRecordMention[] },
): Promise<TeamChatMessage | null> {
  const { data, error } = await supabase
    .from('team_chat_message')
    .update({ body: input.body, mentions: input.mentions, record_mentions: input.recordMentions ?? [] })
    .eq('id', messageId)
    .select(TEAM_CHAT_MESSAGE_COLUMNS)
    .maybeSingle<TeamChatMessage>()
  if (error) throw teamChatErrorOf(error, 'message edit')
  return data ?? null
}

/**
 * Delete the person's own message (soft: the guard clears its words, files
 * and preview). The files it carried, so the caller can remove the person's
 * own uploads; null when it is not theirs, already deleted or gone.
 */
export async function deleteMessage(supabase: SupabaseClient, messageId: string, now: Date = new Date()): Promise<{ paths: string[] } | null> {
  const { data: before } = await supabase.from('team_chat_message').select('attachments').eq('id', messageId).maybeSingle<{ attachments: TeamChatAttachment[] | null }>()
  const { data, error } = await supabase
    .from('team_chat_message')
    .update({ deleted_at: now.toISOString() })
    .eq('id', messageId)
    .select('id')
  if (error) throw teamChatErrorOf(error, 'message delete')
  if (!Array.isArray(data) || data.length === 0) return null
  return { paths: (before?.attachments ?? []).map((a) => a.path).filter((p): p is string => typeof p === 'string') }
}
