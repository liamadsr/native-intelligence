/**
 * Tables: the server half (migrations 520 and 521). Reads go through the
 * caller's client, so RLS decides what a table, a row or a change shows
 * (data_table_visible_to: workspace tables to every member, a private one to
 * its owner and its grantees). Every write is one batch through
 * `apply_data_ops` (or `create_data_table` for a new one), checked here first
 * with the same rules the database applies (./ops.ts).
 *
 * A write names the version it read. When someone else wrote in between, the
 * RPC refuses with PT409 and this answers `conflict` with the version now, so
 * the route can say 409 and the writer can read again. Undo is a batch too:
 * it names the change it takes back and marks it undone in the same
 * transaction (./ops.ts planUndo has the rule).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isUuid, planUndo, touchedBy, validateOps, type DataOpInput } from './ops'
import {
  NEW_TABLE_ROWS,
  TABLE_COLUMN_ENTITY_TYPE,
  TABLE_LIMITS,
  type ApplyResult,
  type DataChange,
  type DataChangeSource,
  type DataColumn,
  type DataColumnType,
  type DataOp,
  type DataRow,
  type DataTable,
  type DataTableVisibility,
  type DataTableWithColumns,
} from './types'

const TABLE_SELECT = 'id, workspace_id, name, icon, description, owner_member_id, visibility, version, position, archived_at, created_at, updated_at'
const COLUMN_SELECT = 'id, table_id, key, label, field_type, options, position, deleted_at'
const ROW_SELECT = 'id, table_id, title, custom_fields, position, archived_at, created_at, updated_at'
const CHANGE_SELECT = 'id, table_id, version, actor_user_id, actor_member_id, source, reason, changes, undo_of, undone_at, created_at'

/** The most rows one page reads. */
export const MAX_ROWS_PAGE = 200

/** Why a write was refused. */
export type TableRefusal = 'invalid' | 'not_found' | 'forbidden' | 'conflict'
export type TableWrite<T> = { ok: true; value: T } | { ok: false; reason: TableRefusal; error: string; version?: number }

/**
 * Who is writing and why: the person (`userId`, whose member row an undo
 * checks ownership against) and, on a service-role client only, `asUserId`,
 * the person the agent acts for (the RPC ignores it for a signed-in caller).
 */
export interface TableActor {
  userId: string | null
  source: DataChangeSource
  reason?: string | null
  asUserId?: string | null
}

type RpcError = { code?: string; message: string; details?: string | null }

/** An RPC error in this module's words: PT409 a stale version, P0002 not found, 42501 not allowed. */
function refusal(error: RpcError): { ok: false; reason: TableRefusal; error: string; version?: number } {
  if (error.code === 'PT409') {
    const version = Number(error.details)
    return {
      ok: false,
      reason: 'conflict',
      error: 'This table changed since you opened it. Read it again and retry.',
      ...(Number.isFinite(version) ? { version } : {}),
    }
  }
  if (error.code === 'P0002') return { ok: false, reason: 'not_found', error: 'Table not found' }
  if (error.code === '42501') return { ok: false, reason: 'forbidden', error: capitalize(error.message) }
  return { ok: false, reason: 'invalid', error: capitalize(error.message) }
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

function normalizeResult(raw: unknown): ApplyResult {
  const r = (raw ?? {}) as Record<string, unknown>
  return {
    version: Number(r.version ?? 0),
    change_id: typeof r.change_id === 'string' ? r.change_id : null,
    inserted_row_ids: Array.isArray(r.inserted_row_ids) ? (r.inserted_row_ids as string[]) : [],
    created_column_ids: r.created_column_ids && typeof r.created_column_ids === 'object' ? (r.created_column_ids as Record<string, string>) : {},
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** The workspace's tables the caller can read, in their order. Archived ones only when asked. */
export async function listTables(db: SupabaseClient, workspaceId: string, opts: { archived?: boolean } = {}): Promise<DataTable[]> {
  let q = db.from('data_table').select(TABLE_SELECT).eq('workspace_id', workspaceId)
  q = opts.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
  const { data, error } = await q.order('position', { ascending: true }).order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as DataTable[]
}

/** A table's columns in order; the deleted ones too when asked (an undo needs them). */
export async function listColumns(db: SupabaseClient, workspaceId: string, tableId: string, opts: { deleted?: boolean } = {}): Promise<DataColumn[]> {
  let q = db.from('custom_field_definition').select(COLUMN_SELECT).eq('workspace_id', workspaceId).eq('entity_type', TABLE_COLUMN_ENTITY_TYPE).eq('table_id', tableId)
  if (!opts.deleted) q = q.is('deleted_at', null)
  const { data, error } = await q.order('position', { ascending: true }).order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as DataColumn[]).map((c) => ({ ...c, options: c.options ?? [] }))
}

/** One table with its live columns, or null when the caller can't read it. */
export async function getTable(db: SupabaseClient, workspaceId: string, tableId: string): Promise<DataTableWithColumns | null> {
  if (!isUuid(tableId)) return null
  const { data, error } = await db.from('data_table').select(TABLE_SELECT).eq('workspace_id', workspaceId).eq('id', tableId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  return { ...(data as DataTable), columns: await listColumns(db, workspaceId, tableId) }
}

/** A page of a table's rows, in order: the live ones, or the archived ones. */
export async function listRows(
  db: SupabaseClient,
  workspaceId: string,
  tableId: string,
  opts: { offset?: number; limit?: number; archived?: boolean } = {},
): Promise<{ rows: DataRow[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), MAX_ROWS_PAGE)
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  let q = db.from('data_row').select(ROW_SELECT).eq('workspace_id', workspaceId).eq('table_id', tableId)
  q = opts.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
  // One more than the page: whether there is another.
  const { data, error } = await q.order('position', { ascending: true }).order('id', { ascending: true }).range(offset, offset + limit)
  if (error) throw new Error(error.message)
  const rows = ((data ?? []) as DataRow[]).map((r) => ({ ...r, custom_fields: r.custom_fields ?? {} }))
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit }
}

/** A table's write history, newest first. */
export async function listChanges(db: SupabaseClient, workspaceId: string, tableId: string, limit = 50): Promise<DataChange[]> {
  const { data, error } = await db
    .from('data_change')
    .select(CHANGE_SELECT)
    .eq('workspace_id', workspaceId)
    .eq('table_id', tableId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(1, limit), 200))
  if (error) throw new Error(error.message)
  return (data ?? []) as DataChange[]
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface CreateTableInput {
  name: string
  visibility?: DataTableVisibility
  icon?: string | null
  description?: string | null
  /** Columns past the Name column (the title, every table has it). */
  columns?: Array<{ label: string; field_type: DataColumnType; options?: string[] }>
  /** Blank rows to start with (default NEW_TABLE_ROWS). */
  blankRows?: number
}

/** A new table, owned by the caller: its columns and its first blank rows in the same batch. */
export async function createTable(
  db: SupabaseClient,
  workspaceId: string,
  input: CreateTableInput,
  actor: TableActor,
): Promise<TableWrite<ApplyResult & { table_id: string }>> {
  const name = (input.name ?? '').trim()
  if (!name) return { ok: false, reason: 'invalid', error: 'A table needs a name.' }
  if (name.length > TABLE_LIMITS.name) return { ok: false, reason: 'invalid', error: `A table's name is at most ${TABLE_LIMITS.name} characters.` }
  const visibility = input.visibility ?? 'workspace'
  if (visibility !== 'workspace' && visibility !== 'private') return { ok: false, reason: 'invalid', error: 'visibility is workspace or private' }
  const blank = Math.min(Math.max(0, Math.floor(input.blankRows ?? NEW_TABLE_ROWS)), 100)

  const raw: DataOpInput[] = (input.columns ?? []).map((c) => ({ op: 'create_column', label: c.label, field_type: c.field_type, options: c.options }))
  if (blank > 0) raw.push({ op: 'insert_rows', rows: Array.from({ length: blank }, () => ({})) })
  const checked = raw.length ? validateOps([], raw) : { ok: true as const, value: [] as DataOp[] }
  if (!checked.ok) return { ok: false, reason: 'invalid', error: checked.error }

  const { data, error } = await db.rpc('create_data_table', {
    p_workspace_id: workspaceId,
    p_name: name,
    p_visibility: visibility,
    p_icon: input.icon ?? null,
    p_description: input.description?.trim() || null,
    p_ops: checked.value,
    p_source: actor.source,
    p_as_user: actor.asUserId ?? null,
  })
  if (error) return refusal(error as RpcError)
  const r = (data ?? {}) as Record<string, unknown>
  return { ok: true, value: { ...normalizeResult(r), table_id: String(r.table_id) } }
}

/**
 * One batch of ops on a table: checked against its columns, then applied all
 * or nothing against `baseVersion` (null: no check, for a write that doesn't
 * depend on what it read, a rename from a menu).
 */
export async function applyOps(
  db: SupabaseClient,
  workspaceId: string,
  tableId: string,
  input: { baseVersion: number | null; ops: unknown },
  actor: TableActor,
): Promise<TableWrite<ApplyResult>> {
  if (!isUuid(tableId)) return { ok: false, reason: 'not_found', error: 'Table not found' }
  const table = await readTableRow(db, workspaceId, tableId)
  if (!table) return { ok: false, reason: 'not_found', error: 'Table not found' }
  const columns = await listColumns(db, workspaceId, tableId, { deleted: true })
  const checked = validateOps(columns, input.ops)
  if (!checked.ok) return { ok: false, reason: 'invalid', error: checked.error }
  return rpcApply(db, tableId, input.baseVersion, checked.value, actor, null)
}

async function readTableRow(db: SupabaseClient, workspaceId: string, tableId: string): Promise<DataTable | null> {
  const { data, error } = await db.from('data_table').select(TABLE_SELECT).eq('workspace_id', workspaceId).eq('id', tableId).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as DataTable | null) ?? null
}

async function rpcApply(
  db: SupabaseClient,
  tableId: string,
  baseVersion: number | null,
  ops: DataOp[],
  actor: TableActor,
  undoOf: string | null,
): Promise<TableWrite<ApplyResult>> {
  const reason = actor.reason?.trim().slice(0, TABLE_LIMITS.reason) || null
  const { data, error } = await db.rpc('apply_data_ops', {
    p_table_id: tableId,
    p_base_version: baseVersion,
    p_ops: ops,
    p_source: actor.source,
    p_reason: reason,
    p_undo_of: undoOf,
    p_as_user: actor.asUserId ?? null,
  })
  if (error) return refusal(error as RpcError)
  return { ok: true, value: normalizeResult(data) }
}

export interface UndoResult extends ApplyResult {
  undone_change_id: string
  restored: string[]
  kept: string[]
}

/**
 * Takes one change back (with no id, the table's latest that is not itself
 * an undo and not undone yet): each part it changed goes back unless it has
 * changed since (./ops.ts planUndo), in one batch that marks it undone.
 */
export async function undoChange(
  db: SupabaseClient,
  workspaceId: string,
  tableId: string,
  changeId: string | null,
  actor: TableActor,
): Promise<TableWrite<UndoResult>> {
  if (!isUuid(tableId)) return { ok: false, reason: 'not_found', error: 'Table not found' }
  const table = await readTableRow(db, workspaceId, tableId)
  if (!table) return { ok: false, reason: 'not_found', error: 'Table not found' }

  let change: DataChange | null = null
  if (changeId) {
    if (!isUuid(changeId)) return { ok: false, reason: 'not_found', error: 'Change not found' }
    const { data, error } = await db.from('data_change').select(CHANGE_SELECT).eq('id', changeId).eq('table_id', tableId).eq('workspace_id', workspaceId).maybeSingle()
    if (error) throw new Error(error.message)
    change = (data as DataChange | null) ?? null
    if (!change) return { ok: false, reason: 'not_found', error: 'Change not found' }
  } else {
    const recent = await listChanges(db, workspaceId, tableId, 50)
    change = recent.find((c) => !c.undo_of && !c.undone_at) ?? null
    if (!change) return { ok: false, reason: 'invalid', error: 'Nothing to undo on this table.' }
  }

  const columns = await listColumns(db, workspaceId, tableId, { deleted: true })
  const { rowIds } = touchedBy(change)
  const rows = new Map<string, { title: string; custom_fields: Record<string, never>; archived_at: string | null; position: string }>()
  for (let i = 0; i < rowIds.length; i += 200) {
    const { data, error } = await db
      .from('data_row')
      .select('id, title, custom_fields, archived_at, position_text:position::text')
      .eq('table_id', tableId)
      .in('id', rowIds.slice(i, i + 200))
    if (error) throw new Error(error.message)
    for (const r of (data ?? []) as Array<Record<string, unknown>>) {
      rows.set(String(r.id), {
        title: String(r.title ?? ''),
        custom_fields: (r.custom_fields ?? {}) as Record<string, never>,
        archived_at: (r.archived_at as string | null) ?? null,
        position: String(r.position_text ?? ''),
      })
    }
  }
  const memberId = await callerMemberId(db, workspaceId, actor)
  const plan = planUndo(change, {
    table,
    isOwner: !!memberId && table.owner_member_id === memberId,
    columns,
    rows,
  })
  if (!plan.ok) return { ok: false, reason: 'invalid', error: plan.error }

  const applied = await rpcApply(db, tableId, table.version, plan.ops, actor, change.id)
  if (!applied.ok) return applied
  return { ok: true, value: { ...applied.value, undone_change_id: change.id, restored: plan.restored, kept: plan.kept } }
}

/** The writer's member row in the workspace: the session's user, or the user a service client acts for. */
async function callerMemberId(db: SupabaseClient, workspaceId: string, actor: TableActor): Promise<string | null> {
  const userId = actor.asUserId ?? actor.userId
  if (!userId) return null
  const { data } = await db.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
  return ((data as { id?: string } | null)?.id as string | undefined) ?? null
}
