/**
 * Comments on a canvas (migration 682's canvas_comment): threads about the
 * canvas or one of its items, and their replies. Everything here goes through
 * the caller's own client, so the table's policies and guard decide: readers
 * of the canvas read and write comments, only its author changes a comment's
 * words or takes it back, anyone who can open the canvas resolves a thread.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isUuid, type CanvasWrite } from './store'

export const COMMENT_LIMITS = { body: 10_000, perCanvas: 2000 } as const

export interface CanvasComment {
  id: string
  canvas_id: string
  parent_id: string | null
  item_id: string | null
  x: number | null
  y: number | null
  body: string
  /** The teammates it @-mentions (member ids). */
  mentions: string[]
  author_id: string | null
  author_name: string | null
  /** The assistant wrote it for its author (migration 692). */
  via_agent: boolean
  resolved_at: string | null
  resolved_by: string | null
  created_at: string
  updated_at: string
}

export interface CanvasThread {
  root: CanvasComment
  replies: CanvasComment[]
}

const BASE_SELECT = 'id, canvas_id, parent_id, item_id, x, y, body, mentions, author_id, resolved_at, resolved_by, created_at, updated_at'
/** With the assistant's mark (692). A database without it yet is read without. */
const SELECT = `${BASE_SELECT}, via_agent`

type Row = Omit<CanvasComment, 'author_name'>
type Stored = Omit<Row, 'mentions' | 'via_agent'> & { mentions?: unknown; via_agent?: unknown }

/** The column is not there: 692 has not been applied to this database yet. */
export function markMissing(error: DbError | null | undefined): boolean {
  if (!error) return false
  return (error.code === '42703' || error.code === 'PGRST204') && /via_agent/.test(error.message)
}

const tidy = (row: Stored): Row => ({
  ...row,
  mentions: Array.isArray(row.mentions) ? row.mentions.filter((m): m is string => typeof m === 'string') : [],
  via_agent: row.via_agent === true,
})

/** A read of comment rows that still works before 692: asked with the mark, and again without it when the column is not there. */
async function read<T>(run: (select: string) => PromiseLike<{ data: T | null; error: DbError | null }>): Promise<{ data: T | null; error: DbError | null }> {
  const first = await run(SELECT)
  return markMissing(first.error) ? await run(BASE_SELECT) : first
}

type DbError = { code?: string; message: string }

/** The table is not there: 682 has not been applied to this database yet. */
export function commentsMissing(error: DbError | null | undefined): boolean {
  if (!error) return false
  return error.code === '42P01' || error.code === 'PGRST205' || /canvas_comment.*(does not exist|schema cache)/i.test(error.message)
}

export class CommentsUnavailable extends Error {
  constructor() {
    super('Comments are not set up on this server yet.')
  }
}

function refusal(error: DbError): Extract<CanvasWrite<never>, { ok: false }> {
  if (commentsMissing(error)) throw new CommentsUnavailable()
  if (error.code === '42501') return { ok: false, reason: 'forbidden', error: 'You cannot change that comment.' }
  if (error.code === '23514' || error.code === '22P02' || error.code === '23503') return { ok: false, reason: 'invalid', error: 'That comment could not be saved.' }
  throw new Error(error.message)
}

/** Threads in the order they were started, each with its replies oldest first. A reply whose thread is gone is dropped. */
export function threadsOf(comments: readonly CanvasComment[]): CanvasThread[] {
  const byTime = [...comments].sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : 1))
  const threads = new Map<string, CanvasThread>()
  for (const c of byTime) if (!c.parent_id) threads.set(c.id, { root: c, replies: [] })
  for (const c of byTime) if (c.parent_id) threads.get(c.parent_id)?.replies.push(c)
  return [...threads.values()]
}

/** Every comment on a canvas the caller can open, with its author's name. */
export async function listComments(db: SupabaseClient, workspaceId: string, canvasId: string): Promise<CanvasComment[] | null> {
  if (!isUuid(canvasId)) return null
  const canvas = await db.from('canvas').select('id').eq('workspace_id', workspaceId).eq('id', canvasId).maybeSingle()
  if (canvas.error) throw new Error(canvas.error.message)
  if (!canvas.data) return null
  const rows: Row[] = []
  for (let from = 0; from < COMMENT_LIMITS.perCanvas; from += 1000) {
    const { data, error } = await read<Stored[]>((select) => db.from('canvas_comment').select(select).eq('canvas_id', canvasId).order('created_at', { ascending: true }).range(from, from + 999) as unknown as PromiseLike<{ data: Stored[] | null; error: DbError | null }>)
    if (error) {
      if (commentsMissing(error)) throw new CommentsUnavailable()
      throw new Error(error.message)
    }
    const page = (data ?? []).map(tidy)
    rows.push(...page)
    if (page.length < 1000) break
  }
  const authors = [...new Set(rows.map((r) => r.author_id).filter((id): id is string => !!id))]
  const names = new Map<string, string>()
  if (authors.length) {
    const { data } = await db.from('member').select('id, display_name').eq('workspace_id', workspaceId).in('id', authors)
    for (const m of (data ?? []) as Array<{ id: string; display_name: string | null }>) if (m.display_name) names.set(m.id, m.display_name)
  }
  return rows.map((r) => ({ ...r, author_name: r.author_id ? (names.get(r.author_id) ?? null) : null }))
}

/** One comment of a canvas the caller can open, or null. */
export async function getComment(db: SupabaseClient, canvasId: string, commentId: string): Promise<CanvasComment | null> {
  if (!isUuid(canvasId) || !isUuid(commentId)) return null
  const { data, error } = await read<Stored>((select) => db.from('canvas_comment').select(select).eq('canvas_id', canvasId).eq('id', commentId).maybeSingle() as unknown as PromiseLike<{ data: Stored | null; error: DbError | null }>)
  if (error) {
    if (commentsMissing(error)) throw new CommentsUnavailable()
    throw new Error(error.message)
  }
  return data ? { ...tidy(data), author_name: null } : null
}

export interface NewComment {
  body: unknown
  parent_id?: unknown
  item_id?: unknown
  x?: unknown
  y?: unknown
  /** Member ids, already fenced to the workspace (record-comments/mentions.ts). */
  mentions?: readonly string[]
  /** The assistant is writing it for this member (needs migration 692). */
  viaAgent?: boolean
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) < 1e9 ? v : null)

/** Write a comment as this member: a new thread (about the canvas or one item), or a reply to one. */
export async function addComment(
  db: SupabaseClient,
  workspaceId: string,
  canvasId: string,
  memberId: string,
  input: NewComment,
): Promise<CanvasWrite<CanvasComment>> {
  if (!isUuid(canvasId)) return { ok: false, reason: 'not_found', error: 'Canvas not found' }
  const body = typeof input.body === 'string' ? input.body.trim() : ''
  if (!body) return { ok: false, reason: 'invalid', error: 'A comment needs some words.' }
  if (body.length > COMMENT_LIMITS.body) return { ok: false, reason: 'invalid', error: 'That comment is too long.' }
  const parentId = input.parent_id == null ? null : input.parent_id
  if (parentId !== null && !isUuid(parentId)) return { ok: false, reason: 'invalid', error: 'That thread does not exist.' }
  const itemId = input.item_id == null ? null : input.item_id
  if (itemId !== null && (typeof itemId !== 'string' || !itemId || itemId.length > 64)) return { ok: false, reason: 'invalid', error: 'That item does not exist.' }

  const canvas = await db.from('canvas').select('id').eq('workspace_id', workspaceId).eq('id', canvasId).maybeSingle()
  if (canvas.error) throw new Error(canvas.error.message)
  if (!canvas.data) return { ok: false, reason: 'not_found', error: 'Canvas not found' }

  // A reply takes its thread's place; a thread is pinned where it was started.
  const row = {
    id: crypto.randomUUID(),
    canvas_id: canvasId,
    workspace_id: workspaceId,
    parent_id: parentId,
    item_id: parentId ? null : itemId,
    x: parentId ? null : finite(input.x),
    y: parentId ? null : finite(input.y),
    body,
    mentions: [...new Set(input.mentions ?? [])].slice(0, 50),
    author_id: memberId,
    // Only ever sent when true: a person's comment saves on a database that has no such column yet.
    ...(input.viaAgent ? { via_agent: true } : {}),
  }
  // Insert, then read: a RETURNING on a row the read policy has yet to see is refused (as with a new canvas).
  const ins = await db.from('canvas_comment').insert(row)
  if (ins.error) {
    if (markMissing(ins.error)) return { ok: false, reason: 'invalid', error: 'The assistant cannot comment here yet: this server is missing an update.' }
    return refusal(ins.error)
  }
  const one = await getComment(db, canvasId, row.id)
  if (!one) return { ok: false, reason: 'forbidden', error: 'That comment could not be saved.' }
  return { ok: true, value: one }
}

/** Change a comment's words (its author), or resolve / reopen its thread (anyone who can open the canvas). */
export async function updateComment(
  db: SupabaseClient,
  canvasId: string,
  commentId: string,
  memberId: string,
  input: { body?: unknown; resolved?: unknown; mentions?: readonly string[] },
): Promise<CanvasWrite<CanvasComment>> {
  if (!isUuid(canvasId) || !isUuid(commentId)) return { ok: false, reason: 'not_found', error: 'Comment not found' }
  const patch: Record<string, unknown> = {}
  if (input.body !== undefined) {
    const body = typeof input.body === 'string' ? input.body.trim() : ''
    if (!body) return { ok: false, reason: 'invalid', error: 'A comment needs some words.' }
    if (body.length > COMMENT_LIMITS.body) return { ok: false, reason: 'invalid', error: 'That comment is too long.' }
    patch.body = body
    if (input.mentions !== undefined) patch.mentions = [...new Set(input.mentions)].slice(0, 50)
  }
  if (input.resolved !== undefined) {
    if (typeof input.resolved !== 'boolean') return { ok: false, reason: 'invalid', error: 'Resolved is yes or no.' }
    patch.resolved_at = input.resolved ? new Date().toISOString() : null
    patch.resolved_by = input.resolved ? memberId : null
  }
  if (!Object.keys(patch).length) return { ok: false, reason: 'invalid', error: 'Nothing to change.' }
  const upd = await db.from('canvas_comment').update(patch).eq('canvas_id', canvasId).eq('id', commentId)
  if (upd.error) return refusal(upd.error)
  const one = await getComment(db, canvasId, commentId)
  if (!one) return { ok: false, reason: 'not_found', error: 'Comment not found' }
  return { ok: true, value: one }
}

/** Take a comment back (its author only; a thread's replies go with it). */
export async function deleteComment(db: SupabaseClient, canvasId: string, commentId: string): Promise<CanvasWrite<{ id: string }>> {
  if (!isUuid(canvasId) || !isUuid(commentId)) return { ok: false, reason: 'not_found', error: 'Comment not found' }
  const { data, error } = await db.from('canvas_comment').delete().eq('canvas_id', canvasId).eq('id', commentId).select('id').maybeSingle()
  if (error) return refusal(error)
  if (!data) return { ok: false, reason: 'forbidden', error: 'Only its author deletes a comment.' }
  return { ok: true, value: { id: commentId } }
}
