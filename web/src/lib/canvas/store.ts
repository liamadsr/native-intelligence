/**
 * Canvas: the server half (migration 676). Reads go through the caller's
 * client, so RLS decides what a canvas and its items show (canvas_visible_to:
 * workspace canvases to every member, a private one to its owner). Writes go
 * through the same client under RLS too (canvas_editable_by) — there is no
 * SECURITY DEFINER RPC like the tables', because a canvas write is item
 * upserts and deletes, not a typed op log.
 *
 * A canvas keeps a `version` the API bumps once per write batch (never a
 * per-row trigger: a 2,000-row write would be 2,000 updates). One realtime
 * event on the canvas row tells its other viewers to read the changed items.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CANVAS_ITEM_KINDS,
  CANVAS_LIMITS,
  type CanvasItemRow,
  type CanvasItemsWrite,
  type CanvasRecord,
  type CanvasSettings,
  type CanvasVisibility,
} from './types'

const CANVAS_SELECT =
  'id, workspace_id, title, visibility, project_id, owner_member_id, settings, version, archived_at, created_at, updated_at'
const ITEM_SELECT = 'canvas_id, id, parent_id, sort_key, kind, data, updated_at, updated_by'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v)
}

const KIND_SET = new Set<string>(CANVAS_ITEM_KINDS)

/** Why a write was refused. */
export type CanvasRefusal = 'invalid' | 'not_found' | 'forbidden' | 'conflict'
export type CanvasWrite<T> = { ok: true; value: T } | { ok: false; reason: CanvasRefusal; error: string; version?: number }

/** Who is writing: the person (and, on a service client, the member they own the canvas as on create). */
export interface CanvasActor {
  userId: string | null
  /** The member id to own a new canvas as (the insert policy requires owner = own member). */
  ownerMemberId?: string | null
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** The workspace's canvases the caller can read, newest first. Archived ones only when asked. */
export async function listCanvases(
  db: SupabaseClient,
  workspaceId: string,
  opts: { archived?: boolean } = {},
): Promise<CanvasRecord[]> {
  let q = db.from('canvas').select(CANVAS_SELECT).eq('workspace_id', workspaceId)
  q = opts.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
  const { data, error } = await q.order('updated_at', { ascending: false })
  if (error) throw new Error(error.message)
  return ((data ?? []) as CanvasRecord[]).map(normalizeRecord)
}

/**
 * One canvas with its items, or null when the caller can't read it. With
 * `userId`, also whether that person may change it (`can_edit`).
 */
export async function getCanvas(
  db: SupabaseClient,
  workspaceId: string,
  canvasId: string,
  opts: { userId?: string } = {},
): Promise<{ canvas: CanvasRecord; items: CanvasItemRow[]; can_edit: boolean } | null> {
  if (!isUuid(canvasId)) return null
  const { data, error } = await db.from('canvas').select(CANVAS_SELECT).eq('workspace_id', workspaceId).eq('id', canvasId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const [items, editable] = await Promise.all([
    listItems(db, canvasId),
    opts.userId ? db.rpc('canvas_editable_by', { p_canvas_id: canvasId, p_user_id: opts.userId }) : Promise.resolve(null),
  ])
  if (editable?.error) throw new Error(editable.error.message)
  return { canvas: normalizeRecord(data as CanvasRecord), items, can_edit: editable ? editable.data === true : false }
}

/** A canvas's items (RLS decides visibility, which follows the canvas). */
export async function listItems(db: SupabaseClient, canvasId: string): Promise<CanvasItemRow[]> {
  const { data, error } = await db.from('canvas_item').select(ITEM_SELECT).eq('canvas_id', canvasId).order('sort_key', { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as CanvasItemRow[]).map((r) => ({ ...r, data: (r.data ?? {}) as Record<string, unknown> }))
}

function normalizeRecord(row: CanvasRecord): CanvasRecord {
  return {
    ...row,
    settings: (row.settings ?? {}) as CanvasSettings,
    version: Number(row.version ?? 0),
  }
}

// ── Writes ────────────────────────────────────────────────────────────────────

export interface CreateCanvasInput {
  title?: string
  visibility?: CanvasVisibility
  project_id?: string | null
  settings?: CanvasSettings
}

/** A new canvas, owned by the caller. */
export async function createCanvas(
  db: SupabaseClient,
  workspaceId: string,
  input: CreateCanvasInput,
  actor: CanvasActor,
): Promise<CanvasWrite<CanvasRecord>> {
  const title = (input.title ?? '').trim() || 'Untitled canvas'
  if (title.length > CANVAS_LIMITS.title) return { ok: false, reason: 'invalid', error: `A canvas's title is at most ${CANVAS_LIMITS.title} characters.` }
  const visibility = input.visibility ?? 'workspace'
  if (visibility !== 'workspace' && visibility !== 'private') return { ok: false, reason: 'invalid', error: 'visibility is workspace or private' }
  if (input.project_id != null && !isUuid(input.project_id)) return { ok: false, reason: 'invalid', error: 'project_id is not an id' }
  if (!actor.ownerMemberId) return { ok: false, reason: 'forbidden', error: 'Only a workspace member can make a canvas.' }
  const { data, error } = await db
    .from('canvas')
    .insert({
      workspace_id: workspaceId,
      title,
      visibility,
      owner_member_id: actor.ownerMemberId,
      created_by_user_id: actor.userId,
      ...(input.project_id ? { project_id: input.project_id } : {}),
      ...(input.settings ? { settings: input.settings } : {}),
    })
    .select(CANVAS_SELECT)
    .maybeSingle()
  if (error) return refusal(error)
  if (!data) return { ok: false, reason: 'forbidden', error: 'Could not make the canvas.' }
  return { ok: true, value: normalizeRecord(data as CanvasRecord) }
}

export interface UpdateCanvasInput {
  title?: string
  visibility?: CanvasVisibility
  project_id?: string | null
  settings?: CanvasSettings
  /** Archive (true) or restore (false) the canvas. */
  archived?: boolean
}

/**
 * Change a canvas's own fields. Only the owner may change visibility (the RLS
 * update policy can't compare old against new for the owner alone, so it is
 * enforced here).
 */
export async function updateCanvas(
  db: SupabaseClient,
  workspaceId: string,
  canvasId: string,
  input: UpdateCanvasInput,
  actor: CanvasActor,
): Promise<CanvasWrite<CanvasRecord>> {
  if (!isUuid(canvasId)) return { ok: false, reason: 'not_found', error: 'Canvas not found' }
  const current = await readCanvasRow(db, workspaceId, canvasId)
  if (!current) return { ok: false, reason: 'not_found', error: 'Canvas not found' }

  const patch: Record<string, unknown> = {}
  if (input.title !== undefined) {
    const title = (input.title ?? '').trim()
    if (!title || title.length > CANVAS_LIMITS.title) return { ok: false, reason: 'invalid', error: `A canvas's title is 1 to ${CANVAS_LIMITS.title} characters.` }
    patch.title = title
  }
  if (input.project_id !== undefined) {
    if (input.project_id != null && !isUuid(input.project_id)) return { ok: false, reason: 'invalid', error: 'project_id is not an id' }
    patch.project_id = input.project_id
  }
  if (input.settings !== undefined) {
    if (!input.settings || typeof input.settings !== 'object' || Array.isArray(input.settings)) return { ok: false, reason: 'invalid', error: 'settings is an object' }
    patch.settings = input.settings
  }
  if (input.archived !== undefined) patch.archived_at = input.archived ? new Date().toISOString() : null
  if (input.visibility !== undefined) {
    if (input.visibility !== 'workspace' && input.visibility !== 'private') return { ok: false, reason: 'invalid', error: 'visibility is workspace or private' }
    if (input.visibility !== current.visibility) {
      // Only the owner may change who sees a canvas.
      const memberId = await callerMemberId(db, workspaceId, actor.userId)
      if (!memberId || current.owner_member_id !== memberId) {
        return { ok: false, reason: 'forbidden', error: "Only the canvas's owner can change who sees it." }
      }
      patch.visibility = input.visibility
    }
  }
  if (Object.keys(patch).length === 0) return { ok: true, value: current }
  patch.updated_at = new Date().toISOString()

  const { data, error } = await db.from('canvas').update(patch).eq('workspace_id', workspaceId).eq('id', canvasId).select(CANVAS_SELECT).maybeSingle()
  if (error) return refusal(error)
  if (!data) return { ok: false, reason: 'forbidden', error: 'You can view this canvas but not change it.' }
  return { ok: true, value: normalizeRecord(data as CanvasRecord) }
}

/** Archive a canvas (default) or delete it for good (`permanent`). */
export async function deleteCanvas(
  db: SupabaseClient,
  workspaceId: string,
  canvasId: string,
  actor: CanvasActor,
  opts: { permanent?: boolean } = {},
): Promise<CanvasWrite<{ id: string }>> {
  if (!isUuid(canvasId)) return { ok: false, reason: 'not_found', error: 'Canvas not found' }
  if (opts.permanent) {
    const { data, error } = await db.from('canvas').delete().eq('workspace_id', workspaceId).eq('id', canvasId).select('id').maybeSingle()
    if (error) return refusal(error)
    if (!data) return { ok: false, reason: 'forbidden', error: 'Only the owner or a workspace admin can delete this canvas.' }
    return { ok: true, value: { id: canvasId } }
  }
  const archived = await updateCanvas(db, workspaceId, canvasId, { archived: true }, actor)
  if (!archived.ok) return archived
  return { ok: true, value: { id: canvasId } }
}

/**
 * One write batch of items: validated, then the upserts applied and the
 * removed ids deleted under RLS, and the canvas's version bumped once. Returns
 * the new version. All the rows must be the canvas's workspace (the policy
 * checks the same).
 */
export async function writeItems(
  db: SupabaseClient,
  workspaceId: string,
  canvasId: string,
  write: CanvasItemsWrite,
  actor: CanvasActor,
): Promise<CanvasWrite<{ version: number }>> {
  if (!isUuid(canvasId)) return { ok: false, reason: 'not_found', error: 'Canvas not found' }
  const canvas = await readCanvasRow(db, workspaceId, canvasId)
  if (!canvas) return { ok: false, reason: 'not_found', error: 'Canvas not found' }

  const upsert = Array.isArray(write.upsert) ? write.upsert : []
  const remove = Array.isArray(write.remove) ? write.remove.filter((id) => typeof id === 'string') : []
  if (upsert.length > CANVAS_LIMITS.batch || remove.length > CANVAS_LIMITS.batch) {
    return { ok: false, reason: 'invalid', error: `At most ${CANVAS_LIMITS.batch} items in one write.` }
  }

  const rows: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const raw of upsert) {
    const row = raw as Partial<CanvasItemRow>
    const id = typeof row.id === 'string' ? row.id : ''
    if (id.length < 1 || id.length > 64) return { ok: false, reason: 'invalid', error: 'Each item needs an id of 1 to 64 characters.' }
    if (seen.has(id)) return { ok: false, reason: 'invalid', error: `item ${id} is written twice in one batch.` }
    seen.add(id)
    if (typeof row.kind !== 'string' || !KIND_SET.has(row.kind)) return { ok: false, reason: 'invalid', error: `item ${id} has an unknown kind.` }
    const sortKey = typeof row.sort_key === 'string' ? row.sort_key : ''
    if (sortKey.length < 1 || sortKey.length > 64) return { ok: false, reason: 'invalid', error: `item ${id} needs a sort key of 1 to 64 characters.` }
    const parentId = row.parent_id == null ? null : typeof row.parent_id === 'string' && row.parent_id.length <= 64 ? row.parent_id : undefined
    if (parentId === undefined) return { ok: false, reason: 'invalid', error: `item ${id} has a bad parent.` }
    const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? (row.data as Record<string, unknown>) : null
    if (!data) return { ok: false, reason: 'invalid', error: `item ${id} needs a data object.` }
    if (jsonBytes(data) > CANVAS_LIMITS.itemBytes) return { ok: false, reason: 'invalid', error: `item ${id} is too large.` }
    rows.push({
      canvas_id: canvasId,
      id,
      workspace_id: workspaceId,
      parent_id: parentId,
      sort_key: sortKey,
      kind: row.kind,
      data,
      ...(actor.userId ? { updated_by: actor.userId } : {}),
      updated_at: new Date().toISOString(),
    })
  }

  if (rows.length) {
    const { error } = await db.from('canvas_item').upsert(rows, { onConflict: 'canvas_id,id' })
    if (error) return refusal(error)
  }
  if (remove.length) {
    const { error } = await db.from('canvas_item').delete().eq('canvas_id', canvasId).in('id', remove.slice(0, CANVAS_LIMITS.batch))
    if (error) return refusal(error)
  }

  // One version bump per batch (no per-row trigger).
  const { data, error } = await db
    .from('canvas')
    .update({ version: canvas.version + 1, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('id', canvasId)
    .select('version')
    .maybeSingle()
  if (error) return refusal(error)
  if (!data) return { ok: false, reason: 'forbidden', error: 'You can view this canvas but not change it.' }
  return { ok: true, value: { version: Number((data as { version: number }).version) } }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readCanvasRow(db: SupabaseClient, workspaceId: string, canvasId: string): Promise<CanvasRecord | null> {
  const { data, error } = await db.from('canvas').select(CANVAS_SELECT).eq('workspace_id', workspaceId).eq('id', canvasId).maybeSingle()
  if (error) throw new Error(error.message)
  return data ? normalizeRecord(data as CanvasRecord) : null
}

async function callerMemberId(db: SupabaseClient, workspaceId: string, userId: string | null): Promise<string | null> {
  if (!userId) return null
  const { data } = await db.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
  return ((data as { id?: string } | null)?.id as string | undefined) ?? null
}

function jsonBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

type DbError = { code?: string; message: string }

/** An RLS/write error in this module's words: a hidden row reads as not-found, a refused write as forbidden. */
function refusal(error: DbError): { ok: false; reason: CanvasRefusal; error: string } {
  // RLS refuses an insert/update the caller may not do with 42501.
  if (error.code === '42501') return { ok: false, reason: 'forbidden', error: 'You can view this canvas but not change it.' }
  if (error.code === '23514') return { ok: false, reason: 'invalid', error: error.message }
  return { ok: false, reason: 'invalid', error: error.message }
}
