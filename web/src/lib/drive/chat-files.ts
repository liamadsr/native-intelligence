/**
 * Team chat files in Drive (docs/plans/drive-files.md, phase 2): the files
 * on the messages of every channel and direct message the viewer can read,
 * newest first, a page at a time.
 *
 * SESSION CLIENT ONLY. The read goes through team_chat_message's own row
 * security (team_chat_message_select: team_chat_can_read, 474), so a file is
 * listed only to its channel's readers, exactly as its message is, and its
 * bytes open only through the bucket's own read policy (558, the same rule).
 * A deleted message's files are gone (555 clears them); a channel the
 * viewer left or never could read never shows.
 *
 * Keyset paging on (created_at, id), so a page never repeats or skips a
 * message when new ones arrive. Each message carries up to ten files, so a
 * page is a page of messages, expanded.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TeamChatAttachment } from '@/lib/team-chat/types'

export interface DriveChatFile {
  /** Its object path in team-chat-files: unique, and what the viewer signs. */
  key: string
  name: string
  size: number
  mimeType: string
  createdAt: string
  messageId: string
  /** Who sent it (a member), or null for an agent's message. */
  authorMemberId: string | null
  channel: { id: string; kind: 'channel' | 'dm'; name: string | null }
}

export interface ChatFilesPage {
  files: DriveChatFile[]
  /** Where the next page starts, or null at the end. */
  before: string | null
}

export interface ChatFilesQuery {
  limit: number
  /** A cursor from a previous page. */
  before?: string | null
  /** A part of the file's name (case-insensitive). */
  q?: string
  /** Only files this member sent (My files). */
  authorMemberId?: string
  /** Only files others sent (Shared with me). */
  notAuthorMemberId?: string
}

/** Messages read per page at most. */
export const CHAT_FILES_PAGE_MAX = 100

interface MessageRow {
  id: string
  channel_id: string
  author_member_id: string | null
  created_at: string
  attachments: TeamChatAttachment[] | null
  team_chat_channel: { id: string; kind: 'channel' | 'dm'; name: string | null } | Array<{ id: string; kind: 'channel' | 'dm'; name: string | null }> | null
}

/** A page cursor: the last message's time and id. */
export function encodeChatCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify([createdAt, id])).toString('base64url')
}

export function decodeChatCursor(raw: string | null | undefined): { createdAt: string; id: string } | null {
  if (!raw || raw.length > 200) return null
  try {
    const v = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    if (!Array.isArray(v) || v.length !== 2) return null
    const [createdAt, id] = v
    if (typeof createdAt !== 'string' || Number.isNaN(Date.parse(createdAt))) return null
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) return null
    return { createdAt, id }
  } catch {
    return null
  }
}

/** A page of the team chat files the viewer may read (see the header). Throws on a failed read. */
export async function listChatFiles(supabase: SupabaseClient, workspaceId: string, query: ChatFilesQuery): Promise<ChatFilesPage> {
  const limit = Math.min(Math.max(1, query.limit), CHAT_FILES_PAGE_MAX)
  let read = supabase
    .from('team_chat_message')
    .select('id, channel_id, author_member_id, created_at, attachments, team_chat_channel(id, kind, name)')
    .eq('workspace_id', workspaceId)
    .is('deleted_at', null)
    .neq('attachments', '[]')
  if (query.authorMemberId) read = read.eq('author_member_id', query.authorMemberId)
  if (query.notAuthorMemberId) read = read.or(`author_member_id.is.null,author_member_id.neq.${query.notAuthorMemberId}`)
  const cursor = decodeChatCursor(query.before)
  if (query.before && !cursor) return { files: [], before: null }
  if (cursor) read = read.or(`created_at.lt."${cursor.createdAt}",and(created_at.eq."${cursor.createdAt}",id.lt.${cursor.id})`)
  const { data, error } = await read.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(limit + 1)
  if (error) throw new Error(`chat files: ${error.message}`)
  const rows = (data ?? []) as MessageRow[]
  const page = rows.slice(0, limit)
  const needle = query.q?.trim().toLowerCase() ?? ''
  const files: DriveChatFile[] = []
  for (const row of page) {
    const channel = Array.isArray(row.team_chat_channel) ? row.team_chat_channel[0] : row.team_chat_channel
    // The channel comes through its own row security too: none, no file.
    if (!channel) continue
    for (const a of row.attachments ?? []) {
      if (!a?.path || !a.name) continue
      if (needle && !a.name.toLowerCase().includes(needle)) continue
      files.push({
        key: a.path,
        name: a.name,
        size: a.size,
        mimeType: a.type,
        createdAt: row.created_at,
        messageId: row.id,
        authorMemberId: row.author_member_id,
        channel: { id: channel.id, kind: channel.kind, name: channel.name },
      })
    }
  }
  const last = page[page.length - 1]
  return { files, before: rows.length > limit && last ? encodeChatCursor(last.created_at, last.id) : null }
}
