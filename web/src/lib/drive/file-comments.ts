/**
 * Comments on a file, pinned to a place on a page (migration 711;
 * docs/plans/drive-files.md, phase 4). The file is an uploaded one (its
 * attachment id) or one sent in team chat (the message that carries it and
 * its object path); never a mail attachment.
 *
 * Reads and writes go through the CALLER's client (the agent's tool passes
 * the service client and checks the person first), so 711's rules decide:
 * whoever can read the file reads its comments, starts and answers a thread,
 * and resolves one; only its author changes or deletes a comment.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export type FileTarget = { kind: 'attachment'; id: string } | { kind: 'chat'; messageId: string; path: string }

export interface FileComment {
  id: string
  parent_id: string | null
  /** 1-based page; null: the whole file. */
  page: number | null
  /** Fractions of the page's width and height, 0 to 1. */
  x: number | null
  y: number | null
  body: string
  mentions: string[]
  author_id: string | null
  author_name: string | null
  via_agent: boolean
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
}

export interface FileThread {
  root: FileComment
  replies: FileComment[]
}

export const FILE_COMMENT_LIMITS = { body: 10_000, page: 100_000, perFile: 2000 } as const

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SELECT = 'id, parent_id, page, x, y, body, mentions, author_id, via_agent, resolved_at, resolved_by, created_at, updated_at'

/** A target from a query string or a body: `attachment=<id>`, or `message=<id>&path=<object path>`. */
export function parseFileTarget(raw: { attachment?: unknown; message?: unknown; path?: unknown }): FileTarget | null {
  if (typeof raw.attachment === 'string' && UUID.test(raw.attachment)) return { kind: 'attachment', id: raw.attachment }
  if (typeof raw.message === 'string' && UUID.test(raw.message) && typeof raw.path === 'string') {
    const path = raw.path
    if (path.length <= 400 && /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[A-Za-z0-9._-]{1,200}$/i.test(path)) {
      return { kind: 'chat', messageId: raw.message, path }
    }
  }
  return null
}

/** The columns that name the file. */
export function targetColumns(t: FileTarget): { attachment_id: string | null; chat_message_id: string | null; chat_file_path: string | null } {
  return t.kind === 'attachment'
    ? { attachment_id: t.id, chat_message_id: null, chat_file_path: null }
    : { attachment_id: null, chat_message_id: t.messageId, chat_file_path: t.path }
}

/** Threads, oldest first; replies under their thread, oldest first. A reply whose thread is gone is dropped. */
export function threadsOfFile(comments: readonly FileComment[]): FileThread[] {
  const roots = comments.filter((c) => !c.parent_id).sort((a, b) => a.created_at.localeCompare(b.created_at))
  return roots.map((root) => ({ root, replies: comments.filter((c) => c.parent_id === root.id).sort((a, b) => a.created_at.localeCompare(b.created_at)) }))
}

export type FileCommentResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string; code?: string }

type DbError = { code?: string; message: string }

/** The table is not there: 711 has not been applied to this database yet. */
export const commentsMissing = (e: DbError | null | undefined) =>
  !!e && (e.code === '42P01' || e.code === 'PGRST205' || (/file_comment/.test(e.message) && /does not exist|schema cache/.test(e.message)))

function refusal(e: DbError): FileCommentResult<never> {
  if (commentsMissing(e)) return { ok: false, status: 503, error: 'Comments on files are not set up on this server yet.', code: 'COMMENTS_UNAVAILABLE' }
  if (e.code === '42501') return { ok: false, status: 403, error: 'You can’t do that on this file.' }
  if (e.code === '23514') return { ok: false, status: 400, error: 'That comment can’t be saved: check its words and its place.' }
  return { ok: false, status: 500, error: e.message || 'Something went wrong.' }
}

const tidy = (r: Record<string, unknown>, names: Map<string, string>): FileComment => ({
  id: String(r.id),
  parent_id: (r.parent_id as string | null) ?? null,
  page: typeof r.page === 'number' ? r.page : null,
  x: typeof r.x === 'number' ? r.x : null,
  y: typeof r.y === 'number' ? r.y : null,
  body: String(r.body ?? ''),
  mentions: Array.isArray(r.mentions) ? (r.mentions as unknown[]).filter((m): m is string => typeof m === 'string') : [],
  author_id: (r.author_id as string | null) ?? null,
  author_name: r.author_id ? (names.get(String(r.author_id)) ?? null) : null,
  via_agent: r.via_agent === true,
  resolved_at: (r.resolved_at as string | null) ?? null,
  resolved_by: (r.resolved_by as string | null) ?? null,
  created_at: String(r.created_at),
  updated_at: String(r.updated_at),
})

async function namesOf(supabase: SupabaseClient, workspaceId: string, ids: string[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids)]
  if (!wanted.length) return new Map()
  const { data } = await supabase.from('member').select('id, display_name').eq('workspace_id', workspaceId).in('id', wanted)
  return new Map(((data ?? []) as Array<{ id: string; display_name: string | null }>).map((m) => [m.id, m.display_name?.trim() || 'A teammate']))
}

/** The read of a file's comments, narrowed to the file. */
function commentsOf(supabase: SupabaseClient, workspaceId: string, t: FileTarget) {
  const q = supabase.from('file_comment').select(SELECT).eq('workspace_id', workspaceId)
  return t.kind === 'attachment' ? q.eq('attachment_id', t.id) : q.eq('chat_message_id', t.messageId).eq('chat_file_path', t.path)
}

/** The file's comments the caller may read, oldest first. */
export async function listFileComments(supabase: SupabaseClient, workspaceId: string, target: FileTarget): Promise<FileCommentResult<FileComment[]>> {
  const { data, error } = await commentsOf(supabase, workspaceId, target)
    .order('created_at', { ascending: true })
    .limit(FILE_COMMENT_LIMITS.perFile)
  if (error) return refusal(error)
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  const names = await namesOf(supabase, workspaceId, rows.map((r) => r.author_id).filter((id): id is string => typeof id === 'string'))
  return { ok: true, value: rows.map((r) => tidy(r, names)) }
}

export interface NewFileComment {
  body?: unknown
  parent_id?: unknown
  page?: unknown
  x?: unknown
  y?: unknown
}

/** Its words and place, as stored, or why not. */
export function readNewComment(input: NewFileComment): { ok: true; body: string; parent_id: string | null; page: number | null; x: number | null; y: number | null } | { ok: false; error: string } {
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (!body) return { ok: false, error: 'A comment needs some words.' }
  if (body.length > FILE_COMMENT_LIMITS.body) return { ok: false, error: 'That comment is too long.' }
  const parent_id = typeof input.parent_id === 'string' && UUID.test(input.parent_id) ? input.parent_id : null
  if (input.parent_id != null && !parent_id) return { ok: false, error: 'That reply names no thread.' }
  const hasPlace = input.page != null || input.x != null || input.y != null
  if (!hasPlace || parent_id) return { ok: true, body, parent_id, page: null, x: null, y: null }
  const page = Number(input.page)
  const x = Number(input.x)
  const y = Number(input.y)
  if (!Number.isInteger(page) || page < 1 || page > FILE_COMMENT_LIMITS.page) return { ok: false, error: 'That page is not in the file.' }
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return { ok: false, error: 'That place is off the page.' }
  return { ok: true, body, parent_id, page, x, y }
}

/** A new thread or a reply, as `memberId` (the caller's own member; the database holds it to that). */
export async function addFileComment(
  supabase: SupabaseClient,
  workspaceId: string,
  memberId: string,
  target: FileTarget,
  input: NewFileComment & { mentions?: readonly string[] },
  opts: { viaAgent?: boolean } = {},
): Promise<FileCommentResult<FileComment>> {
  const read = readNewComment(input)
  if (!read.ok) return { ok: false, status: 400, error: read.error }
  const { data, error } = await supabase
    .from('file_comment')
    .insert({
      workspace_id: workspaceId,
      ...targetColumns(target),
      parent_id: read.parent_id,
      page: read.page,
      x: read.x,
      y: read.y,
      body: read.body,
      mentions: [...new Set(input.mentions ?? [])],
      author_id: memberId,
      ...(opts.viaAgent ? { via_agent: true } : {}),
    })
    .select(SELECT)
    .single()
  if (error) return refusal(error)
  const names = await namesOf(supabase, workspaceId, [memberId])
  return { ok: true, value: tidy(data as Record<string, unknown>, names) }
}

/** New words (its author only), or resolve / reopen a thread (anyone who reads the file, as themself). */
export async function updateFileComment(
  supabase: SupabaseClient,
  workspaceId: string,
  memberId: string,
  id: string,
  patch: { body?: unknown; mentions?: readonly string[]; resolved?: unknown },
): Promise<FileCommentResult<FileComment>> {
  if (!UUID.test(id)) return { ok: false, status: 404, error: 'No such comment.' }
  const change: Record<string, unknown> = {}
  if (patch.body !== undefined) {
    const body = typeof patch.body === 'string' ? patch.body.trim() : ''
    if (!body || body.length > FILE_COMMENT_LIMITS.body) return { ok: false, status: 400, error: 'A comment needs some words.' }
    change.body = body
    if (patch.mentions) change.mentions = [...new Set(patch.mentions)]
  }
  if (typeof patch.resolved === 'boolean') {
    change.resolved_at = patch.resolved ? new Date().toISOString() : null
    change.resolved_by = patch.resolved ? memberId : null
  }
  if (!Object.keys(change).length) return { ok: false, status: 400, error: 'Nothing to change.' }
  const { data, error } = await supabase.from('file_comment').update(change).eq('id', id).eq('workspace_id', workspaceId).select(SELECT).maybeSingle()
  if (error) return refusal(error)
  if (!data) return { ok: false, status: 404, error: 'No such comment.' }
  const row = data as Record<string, unknown>
  const names = await namesOf(supabase, workspaceId, typeof row.author_id === 'string' ? [row.author_id] : [])
  return { ok: true, value: tidy(row, names) }
}

/** Delete one's own comment (a thread's first takes its replies with it). */
export async function deleteFileComment(supabase: SupabaseClient, workspaceId: string, id: string): Promise<FileCommentResult<null>> {
  if (!UUID.test(id)) return { ok: false, status: 404, error: 'No such comment.' }
  const { data, error } = await supabase.from('file_comment').delete().eq('id', id).eq('workspace_id', workspaceId).select('id')
  if (error) return refusal(error)
  if (!data?.length) return { ok: false, status: 404, error: 'No such comment, or not yours to delete.' }
  return { ok: true, value: null }
}

/** The comment's file, for the notice: which kind, its record, and a chat file's name. */
export async function fileOfComment(supabase: SupabaseClient, workspaceId: string, id: string): Promise<{ target: FileTarget; mentions: string[]; parentId: string | null } | null> {
  const { data } = await supabase.from('file_comment').select('attachment_id, chat_message_id, chat_file_path, mentions, parent_id').eq('id', id).eq('workspace_id', workspaceId).maybeSingle()
  const r = data as { attachment_id: string | null; chat_message_id: string | null; chat_file_path: string | null; mentions: unknown; parent_id: string | null } | null
  if (!r) return null
  const target: FileTarget | null = r.attachment_id ? { kind: 'attachment', id: r.attachment_id } : r.chat_message_id && r.chat_file_path ? { kind: 'chat', messageId: r.chat_message_id, path: r.chat_file_path } : null
  if (!target) return null
  return { target, mentions: Array.isArray(r.mentions) ? (r.mentions as unknown[]).filter((m): m is string => typeof m === 'string') : [], parentId: r.parent_id }
}

/** The record a notice is about, by the notifier's kinds (record-comments/notify.ts). */
export function noticeRecord(target: FileTarget): { kind: 'attachment' | 'team_chat_file'; recordId: string } {
  return target.kind === 'attachment' ? { kind: 'attachment', recordId: target.id } : { kind: 'team_chat_file', recordId: target.messageId }
}
