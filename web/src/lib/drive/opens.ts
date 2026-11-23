/**
 * When the person last opened a file in Drive (migration 709's
 * drive_file_open): what Drive's Recent tab lists and "sort by opened" reads.
 * An upload is `upload:<attachment id>`, a team chat file
 * `team_chat:<object path>`. A mail attachment is never recorded: that would
 * keep something of the mail (344), and the table refuses it.
 *
 * SESSION CLIENT ONLY: each person reads and writes their own rows; each file
 * comes back only through its own read rule (the uploads' fences, the chat
 * message's row security), so a file the person can no longer read drops out.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { listWorkspaceFiles } from '@/lib/attachments/workspace-files'
import type { WorkspaceFile } from '@/lib/attachments/workspace-files-model'
import type { DriveChatFile } from './chat-files'
import type { TeamChatAttachment } from '@/lib/team-chat/types'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A key the table takes, or null. */
export function openKeyOf(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  if (raw.startsWith('upload:')) return UUID.test(raw.slice(7)) ? raw : null
  if (raw.startsWith('team_chat:')) {
    const path = raw.slice(10)
    // <channel id>/<user id>/<name>, as the bucket keeps it (558).
    const [channel, user, name, ...rest] = path.split('/')
    return rest.length === 0 && UUID.test(channel ?? '') && UUID.test(user ?? '') && /^[A-Za-z0-9._-]{1,200}$/.test(name ?? '') && raw.length <= 400 ? raw : null
  }
  return null
}

/** Record that the person opened a file (their own row; the latest time wins). */
export async function recordOpen(supabase: SupabaseClient, scope: { workspaceId: string; userId: string }, key: string): Promise<void> {
  const { error } = await supabase
    .from('drive_file_open')
    .upsert({ user_id: scope.userId, workspace_id: scope.workspaceId, file_key: key, opened_at: new Date().toISOString() }, { onConflict: 'user_id,workspace_id,file_key' })
  // Before 709 there is nowhere to record it: nothing is kept.
  if (error && (error.code === '42P01' || error.code === 'PGRST205')) return
  if (error) throw new Error(`open: ${error.message}`)
}

export interface RecentFile {
  key: string
  openedAt: string
  upload?: WorkspaceFile
  chat?: DriveChatFile
}

/** The most opens read. */
export const RECENT_MAX = 60

/** The files the person opened last, newest first, each still one they may read. */
export async function recentFiles(supabase: SupabaseClient, scope: { workspaceId: string; userId: string }): Promise<RecentFile[]> {
  const { data, error } = await supabase
    .from('drive_file_open')
    .select('file_key, opened_at')
    .eq('user_id', scope.userId)
    .eq('workspace_id', scope.workspaceId)
    .order('opened_at', { ascending: false })
    .limit(RECENT_MAX)
  // Before 709 nothing has been recorded: no recent files.
  if (error && (error.code === '42P01' || error.code === 'PGRST205')) return []
  if (error) throw new Error(`recent: ${error.message}`)
  const opens = (data ?? []) as Array<{ file_key: string; opened_at: string }>
  const uploadIds = opens.filter((o) => o.file_key.startsWith('upload:')).map((o) => o.file_key.slice(7))
  const chatPaths = opens.filter((o) => o.file_key.startsWith('team_chat:')).map((o) => o.file_key.slice(10))

  const [uploads, chats] = await Promise.all([
    uploadIds.length ? listWorkspaceFiles(supabase, scope.workspaceId, { limit: uploadIds.length, offset: 0, ids: uploadIds }, scope.userId) : Promise.resolve({ files: [] as WorkspaceFile[] }),
    chatFilesByPath(supabase, scope.workspaceId, chatPaths),
  ])
  const byUpload = new Map(uploads.files.map((f) => [f.id, f]))
  const out: RecentFile[] = []
  for (const o of opens) {
    if (o.file_key.startsWith('upload:')) {
      const f = byUpload.get(o.file_key.slice(7))
      if (f) out.push({ key: o.file_key, openedAt: o.opened_at, upload: f })
    } else {
      const f = chats.get(o.file_key.slice(10))
      if (f) out.push({ key: o.file_key, openedAt: o.opened_at, chat: f })
    }
  }
  return out
}

/** Chat files by their object path, through each message's own row security. */
async function chatFilesByPath(supabase: SupabaseClient, workspaceId: string, paths: string[]): Promise<Map<string, DriveChatFile>> {
  const out = new Map<string, DriveChatFile>()
  await Promise.all(
    paths.map(async (path) => {
      const { data } = await supabase
        .from('team_chat_message')
        .select('id, created_at, author_member_id, attachments, team_chat_channel(id, kind, name)')
        .eq('workspace_id', workspaceId)
        .is('deleted_at', null)
        .contains('attachments', JSON.stringify([{ path }]))
        .limit(1)
        .maybeSingle()
      const row = data as {
        id: string
        created_at: string
        author_member_id: string | null
        attachments: TeamChatAttachment[]
        team_chat_channel: { id: string; kind: 'channel' | 'dm'; name: string | null } | Array<{ id: string; kind: 'channel' | 'dm'; name: string | null }> | null
      } | null
      const channel = row && (Array.isArray(row.team_chat_channel) ? row.team_chat_channel[0] : row.team_chat_channel)
      const file = row?.attachments.find((a) => a.path === path)
      if (row && channel && file) {
        out.set(path, { key: path, name: file.name, size: file.size, mimeType: file.type, createdAt: row.created_at, messageId: row.id, authorMemberId: row.author_member_id, channel })
      }
    }),
  )
  return out
}
