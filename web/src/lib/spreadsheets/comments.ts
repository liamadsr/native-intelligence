/**
 * Comment threads on a spreadsheet's cells (table spreadsheet_comment,
 * migration 675). A thread's first comment carries the cell anchor (the
 * engine's stable sheet id and an A1 range); a reply names that first comment
 * as its parent. Every function takes the caller's own client, so the row
 * policies decide who reads and writes: whoever reads the spreadsheet reads
 * its comments, may resolve a thread or move its anchor, and edits or deletes
 * only their own comment (the database trigger spreadsheet_comment_guard holds
 * the line a policy cannot).
 *
 * Mentions. The app's comment-mention machinery (applyCommentMentions,
 * sendCommentNotifications) is written for the `comment` table's kinds
 * (CommentableType has no 'spreadsheet') and its sharing path grants per-person
 * access, which a spreadsheet does not have (decision 5). So a spreadsheet
 * comment's @-mentions are validated and stored on the row's `mentions` column
 * but DO NOT notify or share yet; see the plan.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseRange, rangeName } from './a1'
import type { StoreResult } from './store'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_BODY = 10_000
const MAX_MENTIONS = 50

export interface SpreadsheetCommentRow {
  id: string
  spreadsheet_id: string
  workspace_id: string
  parent_id: string | null
  sheet_id: number | null
  anchor: string | null
  body: string
  mentions: string[]
  author_id: string | null
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
}

export interface SpreadsheetComment extends SpreadsheetCommentRow {
  /** The author's display name, when the member can be read. */
  author_name: string | null
}

/** A thread: its first comment, then its replies oldest first, with a count. */
export interface CommentThread {
  id: string
  sheet_id: number | null
  anchor: string | null
  resolved_at: string | null
  resolved_by: string | null
  resolved_by_name: string | null
  root: SpreadsheetComment
  replies: SpreadsheetComment[]
  reply_count: number
}

const ROW = 'id, spreadsheet_id, workspace_id, parent_id, sheet_id, anchor, body, mentions, author_id, resolved_at, resolved_by, created_at, updated_at'

const refuse = (reason: 'invalid' | 'not_found' | 'conflict' | 'failed', message: string): StoreResult<never> =>
  ({ ok: false as const, reason, message })

/** The body, trimmed and length-checked, or null when it is not 1 to 10,000 characters. */
export function cleanBody(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const body = value.trim()
  if (!body || body.length > MAX_BODY) return null
  return body
}

/** An A1 range normalised (`a1` -> `A1`), or null when it is not one. */
export function cleanAnchor(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const range = parseRange(value)
  return range ? rangeName(range) : null
}

/** The mentioned member ids: unique UUIDs, capped. Anything else is dropped. */
export function cleanMentions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string' && UUID.test(item)) seen.add(item.toLowerCase())
    if (seen.size >= MAX_MENTIONS) break
  }
  return [...seen]
}

async function memberNames(supabase: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  const wanted = [...new Set(ids.filter(Boolean))]
  if (!wanted.length) return names
  const { data } = await supabase.from('member').select('id, display_name').in('id', wanted)
  for (const row of (data ?? []) as Array<{ id: string; display_name?: string | null }>) {
    const name = (row.display_name ?? '').trim()
    if (name) names.set(row.id, name)
  }
  return names
}

function withName(row: SpreadsheetCommentRow, names: Map<string, string>): SpreadsheetComment {
  return {
    ...row,
    mentions: Array.isArray(row.mentions) ? row.mentions : [],
    author_name: row.author_id ? (names.get(row.author_id) ?? null) : null,
  }
}

/**
 * Every thread of a spreadsheet: the first comment, its replies oldest first,
 * and whether it is resolved. Open threads come before resolved ones; within a
 * group, newest first. The caller's own client, so a spreadsheet they cannot
 * read gives nothing.
 */
export async function listThreads(supabase: SupabaseClient, spreadsheetId: string): Promise<CommentThread[]> {
  const { data, error } = await supabase
    .from('spreadsheet_comment')
    .select(ROW)
    .eq('spreadsheet_id', spreadsheetId)
    .order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  const rows = (data ?? []) as unknown as SpreadsheetCommentRow[]
  const names = await memberNames(
    supabase,
    rows.flatMap((r) => [r.author_id ?? '', r.resolved_by ?? '']),
  )
  const roots = rows.filter((r) => !r.parent_id)
  const repliesByParent = new Map<string, SpreadsheetCommentRow[]>()
  for (const r of rows) {
    if (!r.parent_id) continue
    const list = repliesByParent.get(r.parent_id) ?? []
    list.push(r)
    repliesByParent.set(r.parent_id, list)
  }
  const threads: CommentThread[] = roots.map((root) => {
    const replies = (repliesByParent.get(root.id) ?? []).map((r) => withName(r, names))
    return {
      id: root.id,
      sheet_id: root.sheet_id,
      anchor: root.anchor,
      resolved_at: root.resolved_at,
      resolved_by: root.resolved_by,
      resolved_by_name: root.resolved_by ? (names.get(root.resolved_by) ?? null) : null,
      root: withName(root, names),
      replies,
      reply_count: replies.length,
    }
  })
  // Open threads first; newest first within each group.
  return threads.sort((a, b) => {
    const ra = a.resolved_at ? 1 : 0
    const rb = b.resolved_at ? 1 : 0
    if (ra !== rb) return ra - rb
    return b.root.created_at.localeCompare(a.root.created_at)
  })
}

async function readOne(supabase: SupabaseClient, commentId: string): Promise<SpreadsheetCommentRow | null> {
  const { data, error } = await supabase.from('spreadsheet_comment').select(ROW).eq('id', commentId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as unknown as SpreadsheetCommentRow | null) ?? null
}

async function returnOne(supabase: SupabaseClient, row: SpreadsheetCommentRow): Promise<SpreadsheetComment> {
  const names = await memberNames(supabase, [row.author_id ?? '', row.resolved_by ?? ''])
  return withName(row, names)
}

export interface NewThreadInput {
  workspaceId: string
  spreadsheetId: string
  memberId: string
  sheetId: number
  anchor: unknown
  body: unknown
  mentions?: unknown
}

/** A thread's first comment, anchored to a cell range. */
export async function createThread(supabase: SupabaseClient, input: NewThreadInput): Promise<StoreResult<SpreadsheetComment>> {
  const body = cleanBody(input.body)
  if (!body) return refuse('invalid', 'A comment is 1 to 10,000 characters.')
  const anchor = cleanAnchor(input.anchor)
  if (!anchor) return refuse('invalid', 'A thread is anchored to a cell or range.')
  if (!Number.isInteger(input.sheetId)) return refuse('invalid', 'A thread names its sheet.')
  const { data, error } = await supabase
    .from('spreadsheet_comment')
    .insert({
      spreadsheet_id: input.spreadsheetId,
      workspace_id: input.workspaceId,
      parent_id: null,
      sheet_id: input.sheetId,
      anchor,
      body,
      mentions: cleanMentions(input.mentions),
      author_id: input.memberId,
    })
    .select(ROW)
    .single()
  if (error || !data) return refuse('failed', error?.message ?? 'Could not add the comment.')
  return { ok: true, value: await returnOne(supabase, data as unknown as SpreadsheetCommentRow) }
}

export interface NewReplyInput {
  workspaceId: string
  spreadsheetId: string
  memberId: string
  parentId: string
  body: unknown
  mentions?: unknown
}

/** A reply to a thread. Its parent must be that thread's first comment, on the same spreadsheet. */
export async function createReply(supabase: SupabaseClient, input: NewReplyInput): Promise<StoreResult<SpreadsheetComment>> {
  const body = cleanBody(input.body)
  if (!body) return refuse('invalid', 'A comment is 1 to 10,000 characters.')
  const parent = await readOne(supabase, input.parentId)
  if (!parent || parent.spreadsheet_id !== input.spreadsheetId) return refuse('not_found', 'That thread is gone.')
  if (parent.parent_id) return refuse('invalid', 'A reply names the thread, not another reply.')
  const { data, error } = await supabase
    .from('spreadsheet_comment')
    .insert({
      spreadsheet_id: input.spreadsheetId,
      workspace_id: input.workspaceId,
      parent_id: parent.id,
      sheet_id: null,
      anchor: null,
      body,
      mentions: cleanMentions(input.mentions),
      author_id: input.memberId,
    })
    .select(ROW)
    .single()
  if (error || !data) return refuse('failed', error?.message ?? 'Could not add the reply.')
  return { ok: true, value: await returnOne(supabase, data as unknown as SpreadsheetCommentRow) }
}

/** Edit one's own comment's words (and the members it mentions). */
export async function editComment(
  supabase: SupabaseClient,
  input: { spreadsheetId: string; commentId: string; body: unknown; mentions?: unknown },
): Promise<StoreResult<SpreadsheetComment>> {
  const body = cleanBody(input.body)
  if (!body) return refuse('invalid', 'A comment is 1 to 10,000 characters.')
  const patch: Record<string, unknown> = { body }
  if (input.mentions !== undefined) patch.mentions = cleanMentions(input.mentions)
  return applyUpdate(supabase, input.spreadsheetId, input.commentId, patch)
}

/** Resolve a thread as oneself, or reopen it. Only the thread's first comment carries this. */
export async function setResolved(
  supabase: SupabaseClient,
  input: { spreadsheetId: string; commentId: string; memberId: string; resolved: boolean },
): Promise<StoreResult<SpreadsheetComment>> {
  const patch = input.resolved
    ? { resolved_at: new Date().toISOString(), resolved_by: input.memberId }
    : { resolved_at: null, resolved_by: null }
  return applyUpdate(supabase, input.spreadsheetId, input.commentId, patch)
}

/** Move a thread's anchor (its cells moved). Sheet may change on a sheet delete. */
export async function moveAnchor(
  supabase: SupabaseClient,
  input: { spreadsheetId: string; commentId: string; anchor: unknown; sheetId?: unknown },
): Promise<StoreResult<SpreadsheetComment>> {
  const anchor = cleanAnchor(input.anchor)
  if (!anchor) return refuse('invalid', 'An anchor is a cell or range.')
  const patch: Record<string, unknown> = { anchor }
  if (input.sheetId !== undefined) {
    if (!Number.isInteger(input.sheetId)) return refuse('invalid', 'A sheet id is a whole number.')
    patch.sheet_id = input.sheetId
  }
  return applyUpdate(supabase, input.spreadsheetId, input.commentId, patch)
}

async function applyUpdate(
  supabase: SupabaseClient,
  spreadsheetId: string,
  commentId: string,
  patch: Record<string, unknown>,
): Promise<StoreResult<SpreadsheetComment>> {
  const { data, error } = await supabase
    .from('spreadsheet_comment')
    .update(patch)
    .eq('id', commentId)
    .eq('spreadsheet_id', spreadsheetId)
    .select(ROW)
  if (error) return refuse('failed', error.message)
  const saved = (data ?? [])[0] as unknown as SpreadsheetCommentRow | undefined
  if (!saved) return refuse('not_found', 'That comment is gone.')
  return { ok: true, value: await returnOne(supabase, saved) }
}

/** Delete one's own comment (a thread's first comment takes its replies with it, by the foreign key). */
export async function deleteComment(
  supabase: SupabaseClient,
  input: { spreadsheetId: string; commentId: string },
): Promise<StoreResult<{ id: string }>> {
  const { data, error } = await supabase
    .from('spreadsheet_comment')
    .delete()
    .eq('id', input.commentId)
    .eq('spreadsheet_id', input.spreadsheetId)
    .select('id')
  if (error) return refuse('failed', error.message)
  if (!(data ?? []).length) return refuse('not_found', 'That comment is gone, or not yours to delete.')
  return { ok: true, value: { id: input.commentId } }
}
