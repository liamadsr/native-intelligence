/**
 * Managing a conversation (migration 714, docs/plans/team-chat-manage.md):
 * edit a channel's name and topic, rename a meeting chat, delete a channel or
 * a meeting chat completely. Each runs as the person (their Supabase client, the
 * route's), through 714's functions, which decide who may: a channel's or
 * meeting chat's creator (a meeting's host), or the workspace's owner or
 * admin, and only someone who may read it.
 *
 * The delete's files: storage objects can't be removed from SQL, so 714's
 * team_chat_delete_conversation returns the object names under the chat's
 * folder and this removes them with the service role once the delete has
 * committed. They are unreadable from that moment either way (both buckets'
 * read policy asks team_chat_can_read of the folder's channel, now gone); a
 * removal that fails is logged and leaves bytes no one can read.
 *
 * Each function throws a TeamChatError (./store.ts) on a failed call.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { TeamChatError, teamChatErrorOf } from './store'
import { TEAM_CHAT_TOPIC_MAX, tidyChannelName } from './types'

/** The buckets a conversation's files live in (558's, 566's). */
export const TEAM_CHAT_DELETE_BUCKETS = ['team-chat-files', 'team-call-recordings'] as const

export interface TeamChatChannelEdit {
  /** The new name (tidied by tidyChannelName); undefined keeps it. */
  name?: string
  /** The new topic; '' clears it; undefined keeps it. */
  topic?: string
}

export interface TeamChatEditedChannel {
  id: string
  kind: 'channel' | 'dm' | 'meeting'
  name: string | null
  topic: string | null
}

/** What deleting a channel or meeting chat takes (714's team_chat_delete_contents), for the confirmation. */
export interface ConversationContents {
  messages: number
  files: number
  polls: number
  calls: number
  /** People with a place in it (their read marks, levels, snoozes). */
  members: number
  /** Call notes that stay, each as its owner's own private capture. */
  notesKept: number
  /** A call is on now: the delete is refused until it ends. */
  liveCall: boolean
  /** A meeting chat whose link still works (it stops). Always false for a channel. */
  linkCurrent: boolean
  /** The meeting is a booking's (the booked guest's link stops too). */
  booked: boolean
}

/**
 * The body of a PATCH, checked: a name (1 to 80 characters once tidied) and a
 * topic (250 at most, '' clears it), at least one of them. A string error
 * says what is wrong, in words.
 */
export function parseChannelEdit(body: Record<string, unknown>): TeamChatChannelEdit | string {
  const edit: TeamChatChannelEdit = {}
  if (body.name !== undefined) {
    const name = tidyChannelName(body.name)
    if (!name) return 'Give it a name (up to 80 characters)'
    edit.name = name
  }
  if (body.topic !== undefined && body.topic !== null) {
    if (typeof body.topic !== 'string') return 'The topic must be words'
    const topic = body.topic.trim()
    if (topic.length > TEAM_CHAT_TOPIC_MAX) return `Keep the topic to ${TEAM_CHAT_TOPIC_MAX} characters`
    edit.topic = topic
  } else if (body.topic === null) {
    edit.topic = ''
  }
  if (edit.name === undefined && edit.topic === undefined) return 'Nothing to change'
  return edit
}

/** Edit a channel's name or topic, or rename a meeting chat (714's team_chat_update_channel). Returns the row as it now is. */
export async function updateChannel(supabase: SupabaseClient, channelId: string, edit: TeamChatChannelEdit): Promise<TeamChatEditedChannel> {
  const { data, error } = await supabase.rpc('team_chat_update_channel', {
    ch: channelId,
    new_name: edit.name ?? null,
    new_topic: edit.topic ?? null,
  })
  if (error) throw teamChatErrorOf(error, 'channel edit')
  const row = (Array.isArray(data) ? data[0] : data) as TeamChatEditedChannel | null | undefined
  if (!row?.id) throw new TeamChatError('failed', 'channel edit returned nothing')
  return { id: row.id, kind: row.kind, name: row.name ?? null, topic: row.topic ?? null }
}

/** What deleting this channel or meeting chat would take (714's team_chat_delete_contents). */
export async function deleteContents(supabase: SupabaseClient, channelId: string): Promise<ConversationContents> {
  const { data, error } = await supabase.rpc('team_chat_delete_contents', { ch: channelId })
  if (error) throw teamChatErrorOf(error, 'delete contents')
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined
  if (!row) throw new TeamChatError('failed', 'delete contents returned nothing')
  const n = (v: unknown) => Number(v) || 0
  return {
    messages: n(row.messages),
    files: n(row.files),
    polls: n(row.polls),
    calls: n(row.calls),
    members: n(row.members),
    notesKept: n(row.notes_kept),
    liveCall: row.live_call === true,
    linkCurrent: row.link_current === true,
    booked: row.booked === true,
  }
}

/**
 * Delete a channel or meeting chat completely (714's
 * team_chat_delete_conversation, as the person), then remove its files from
 * storage with the service role. Returns how many files were removed and how
 * many could not be.
 */
export async function deleteConversation(
  supabase: SupabaseClient,
  service: SupabaseClient,
  channelId: string,
): Promise<{ filesRemoved: number; filesLeft: number }> {
  const { data, error } = await supabase.rpc('team_chat_delete_conversation', { ch: channelId })
  if (error) throw teamChatErrorOf(error, 'conversation delete')
  const objects = ((data ?? []) as Array<{ bucket?: unknown; object_name?: unknown }>).filter(
    (o): o is { bucket: string; object_name: string } =>
      typeof o.bucket === 'string' && typeof o.object_name === 'string' && (TEAM_CHAT_DELETE_BUCKETS as readonly string[]).includes(o.bucket) && o.object_name.startsWith(`${channelId}/`),
  )
  return removeObjects(service, objects)
}

/** Remove these objects, bucket by bucket, 100 at a time. Never throws: the conversation is already gone. */
async function removeObjects(service: SupabaseClient, objects: ReadonlyArray<{ bucket: string; object_name: string }>): Promise<{ filesRemoved: number; filesLeft: number }> {
  let filesRemoved = 0
  let filesLeft = 0
  for (const bucket of TEAM_CHAT_DELETE_BUCKETS) {
    const names = objects.filter((o) => o.bucket === bucket).map((o) => o.object_name)
    for (let i = 0; i < names.length; i += 100) {
      const batch = names.slice(i, i + 100)
      try {
        const { error } = await service.storage.from(bucket).remove(batch)
        if (error) throw error
        filesRemoved += batch.length
      } catch (err) {
        filesLeft += batch.length
        console.warn(`[team-chat] deleted conversation's files not removed (${bucket}, ${batch.length}):`, err instanceof Error ? err.message : 'unknown')
      }
    }
  }
  return { filesRemoved, filesLeft }
}
