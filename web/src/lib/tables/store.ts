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
import type { CustomFieldConfig } from '@/lib/crm/custom-fields'
import type { CustomFieldType } from '@/lib/crm/custom-field-types'
import { applyFilters, applyOrdering, fieldShapes, NoMatchSignal, type CustomFieldTypes } from '@/lib/views/query-engine'
import { customFieldKeyOf } from '@/lib/views/custom-field-columns'
import type { SortConfig, ViewFilter } from '@/lib/views/types'
import { format } from 'date-fns'
import { resolveRelativeDate, wallClockIn } from '@/lib/views/query-engine'
import { cellMatches, cellValue, compareValues } from './computed'
import { annotateColumns, attachComputed, computedContext, hasComputed, type ComputedContext, type ComputedReader } from './computed-server'
import { isUuid, optionsAnUndoCouldDrop, planUndo, requiredWhenProblem, touchedBy, validateOps, type DataOpInput } from './ops'
import {
  isComputedType,
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
  type DataTableKind,
  type DataTableVisibility,
  type DataTableWithColumns,
  type NewRow,
} from './types'

// `table_kind` reads as `kind` (540 names the column so: 525's _data_apply has a `kind` variable).
const TABLE_SELECT = 'id, workspace_id, name, icon, description, owner_member_id, visibility, kind:table_kind, is_default, version, position, archived_at, created_at, updated_at'
const COLUMN_SELECT = 'id, table_id, key, label, field_type, options, config, position, deleted_at, system'
export const ROW_SELECT = 'id, table_id, title, custom_fields, position, archived_at, created_at, updated_at, stage_changed_at, closed_at'
export const CHANGE_SELECT = 'id, table_id, version, actor_user_id, actor_member_id, source, reason, changes, undo_of, undone_at, created_at, source_ref'

/** The most rows one page reads. */
export const MAX_ROWS_PAGE = 200

/**
 * The most rows a view filtered or sorted by a formula or a rollup reads:
 * those are worked out as rows are read, so the view is run in memory over
 * this many rows. A table with more drops those filters and sorts (the page
 * says so) and keeps the rest.
 */
export const COMPUTED_SCAN_ROWS = 2000

/** The most rows an export reads at once (pageCap): one PostgREST read, with the one past it. */
export const EXPORT_PAGE = 999

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
  /** The email thread, capture or text a change came from (540's data_change.source_ref). */
  sourceRef?: string | null
  asUserId?: string | null
  /**
   * false on a guest's or a linked agent's turn (530): a table the writer
   * reads only through a grant is not there, and a relation value links only
   * what they read without one. Absent: grants count, as for the person.
   */
  grants?: boolean
}

/** The RPC arguments only some writes send (530): nothing for the person's own write. */
function writeExtras(actor: TableActor): { p_grants?: false } {
  return actor.grants === false ? { p_grants: false } : {}
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
export async function listTables(db: SupabaseClient, workspaceId: string, opts: { archived?: boolean; kind?: DataTableKind } = {}): Promise<DataTable[]> {
  let q = db.from('data_table').select(TABLE_SELECT).eq('workspace_id', workspaceId)
  if (opts.kind) q = q.eq('table_kind', opts.kind)
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
  return ((data ?? []) as DataColumn[]).map((c) => ({ ...c, options: c.options ?? [], config: c.config ?? {} }))
}

/**
 * One table with its live columns, or null when the caller can't read it.
 * With `userId`, also whether that person may change it (`can_edit`): a
 * reader with a view grant sees no Undo.
 */
export async function getTable(db: SupabaseClient, workspaceId: string, tableId: string, opts: { userId?: string } = {}): Promise<DataTableWithColumns | null> {
  if (!isUuid(tableId)) return null
  const { data, error } = await db.from('data_table').select(TABLE_SELECT).eq('workspace_id', workspaceId).eq('id', tableId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const [columns, editable] = await Promise.all([
    listColumns(db, workspaceId, tableId),
    opts.userId ? db.rpc('data_table_editable_by', { p_table_id: tableId, p_user_id: opts.userId }) : Promise.resolve(null),
  ])
  if (editable?.error) throw new Error(editable.error.message)
  const shown = hasComputed(columns) ? annotateColumns(await computedContext(db, workspaceId, columns)) : columns
  return { ...(data as DataTable), columns: shown, ...(editable ? { can_edit: editable.data === true } : {}) }
}

/**
 * Rows with their formulas' and rollups' cells, worked out for `reader` (a
 * rollup counts only what they may read). `ctx` is read once per call when
 * not given.
 */
export async function withComputed(
  db: SupabaseClient,
  columns: readonly DataColumn[],
  rows: DataRow[],
  reader: ComputedReader,
  ctx?: ComputedContext,
): Promise<DataRow[]> {
  if (!hasComputed(columns) || !rows.length) return rows
  return attachComputed(db, ctx ?? (await computedContext(db, reader.workspaceId, columns)), rows, reader)
}

/**
 * A page of a table's rows, in order: the live ones, or the archived ones.
 * With `ids`, those rows whatever their state (the grid reads the rows a
 * teammate just added or moved).
 */
export async function listRows(
  db: SupabaseClient,
  workspaceId: string,
  tableId: string,
  opts: { offset?: number; limit?: number; archived?: boolean; ids?: readonly string[] } = {},
): Promise<{ rows: DataRow[]; hasMore: boolean }> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), MAX_ROWS_PAGE)
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  let q = db.from('data_row').select(ROW_SELECT).eq('workspace_id', workspaceId).eq('table_id', tableId)
  if (opts.ids) {
    const ids = opts.ids.filter(isUuid).slice(0, MAX_ROWS_PAGE)
    if (!ids.length) return { rows: [], hasMore: false }
    q = q.in('id', ids)
  } else q = opts.archived ? q.not('archived_at', 'is', null) : q.is('archived_at', null)
  // One more than the page: whether there is another.
  const { data, error } = await q.order('position', { ascending: true }).order('id', { ascending: true }).range(offset, offset + limit)
  if (error) throw new Error(error.message)
  const rows = ((data ?? []) as DataRow[]).map((r) => ({ ...r, custom_fields: r.custom_fields ?? {} }))
  return { rows: rows.slice(0, limit), hasMore: rows.length > limit }
}

/** What a view asks of a table's rows: its filters and sorts (src/lib/views). */
export interface RowQuery {
  filters?: readonly ViewFilter[]
  ordering?: readonly SortConfig[]
}

/** The fields every row has, beside its table's columns. */
const ROW_FIELDS = new Set(['title', 'created_at', 'updated_at'])

/** Whether a view's field is one this table has: a row field, or a live column's path. */
function isTableField(field: string, types: CustomFieldTypes): boolean {
  if (ROW_FIELDS.has(field)) return true
  const key = customFieldKeyOf(field)
  return !!key && types.has(key)
}

/**
 * A page of a table's live rows as a view asks for them: filtered and sorted
 * on the server by the views query engine, each column read by its type
 * (the table's columns are the types), then in the table's order. A filter
 * or a sort on a column since deleted is dropped: a saved view degrades, it
 * never fails. `userId` resolves "me" on a person column; `timeZone` (the
 * reader's) makes a relative window that zone's days.
 */
export async function queryRows(
  db: SupabaseClient,
  workspaceId: string,
  tableId: string,
  columns: ReadonlyArray<Pick<DataColumn, 'key' | 'field_type'> & { config?: DataColumn['config']; label?: string; deleted_at?: string | null }>,
  opts: RowQuery & {
    offset?: number
    limit?: number
    userId?: string
    timeZone?: string
    /** Who reads: formulas and rollups are worked out for them (without it, rows come without cells). */
    computed?: ComputedReader
    pageCap?: number
    /**
     * When the view filters or sorts on a formula or a rollup: every matching
     * row in one answer (at most COMPUTED_SCAN_ROWS), so the pages after it
     * need no second run. Offset past 0 answers nothing more.
     */
    computedWhole?: boolean
  } = {},
): Promise<{ rows: DataRow[]; hasMore: boolean; computedSkipped?: boolean }> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), Math.min(opts.pageCap ?? MAX_ROWS_PAGE, EXPORT_PAGE))
  const offset = Math.max(0, Math.floor(opts.offset ?? 0))
  const stored = columns.filter((c) => !isComputedType(c.field_type)) as ReadonlyArray<Pick<DataColumn, 'key' | 'field_type'> & { field_type: CustomFieldType; config?: DataColumn['config'] }>
  const computedKeys = new Set(columns.filter((c) => isComputedType(c.field_type) && !c.deleted_at).map((c) => c.key))
  const fieldTypes: CustomFieldTypes = fieldShapes(stored)
  const onComputed = (field: string) => computedKeys.has(customFieldKeyOf(field) ?? '')
  const filters = (opts.filters ?? []).filter((f) => isTableField(f.field, fieldTypes))
  const ordering = (opts.ordering ?? []).filter((s) => isTableField(s.field, fieldTypes))
  // A filter or a sort on a formula or a rollup runs here, over the rows the rest let through.
  const computedFilters = (opts.filters ?? []).filter((f) => onComputed(f.field))
  const computedSort = (opts.ordering ?? []).some((s) => onComputed(s.field))
  // Without a reader there are no cells to run them on: the rest of the view, and it says so.
  if ((computedFilters.length || computedSort) && !opts.computed) {
    const page = await queryRows(db, workspaceId, tableId, columns, { ...opts, filters, ordering })
    return { ...page, computedSkipped: true }
  }
  const base = () => db.from('data_row').select(ROW_SELECT).eq('workspace_id', workspaceId).eq('table_id', tableId).is('archived_at', null)
  const narrowed = async (q: ReturnType<typeof base>) => {
    try {
      await applyFilters(q as never, 'data_row', [...filters], db, workspaceId, { userId: opts.userId }, { fieldTypes, timeZone: opts.timeZone })
      return true
    } catch (e) {
      if (e instanceof NoMatchSignal) return false
      throw e
    }
  }
  const fullColumns = columns as readonly DataColumn[]

  if (computedFilters.length || computedSort) {
    const all: DataRow[] = []
    let skipped = false
    for (let from = 0; ; from += 1000) {
      const q = base()
      if (!(await narrowed(q))) return { rows: [], hasMore: false }
      const { data, error } = await q.order('position', { ascending: true }).order('id', { ascending: true }).range(from, Math.min(from + 999, COMPUTED_SCAN_ROWS))
      if (error) throw new Error(error.message)
      all.push(...((data ?? []) as DataRow[]).map((r) => ({ ...r, custom_fields: r.custom_fields ?? {} })))
      if (all.length > COMPUTED_SCAN_ROWS) {
        skipped = true
        break
      }
      if ((data ?? []).length < 1000 || from + 1000 > COMPUTED_SCAN_ROWS) break
    }
    if (!skipped) {
      const reader = opts.computed!
      const ctx = await computedContext(db, workspaceId, fullColumns)
      const results = new Map(annotateColumns(ctx).map((c) => [c.key, c.computed?.result ?? null]))
      // As the query engine reads a relative window on a date column: its days, in the reader's zone.
      const window = (v: Parameters<typeof resolveRelativeDate>[0]) => {
        const w = resolveRelativeDate(v, opts.timeZone ? wallClockIn(opts.timeZone) : undefined)
        return { from: format(new Date(w.from), 'yyyy-MM-dd'), to: format(new Date(w.to), 'yyyy-MM-dd') }
      }
      let rows = await attachComputed(db, ctx, all, reader)
      for (const f of computedFilters) {
        const key = customFieldKeyOf(f.field)!
        rows = rows.filter((r) => cellMatches(r.computed?.[key], results.get(key) ?? null, f, { window }))
      }
      const sorts = opts.ordering ?? []
      if (sorts.length) {
        const typeOf = new Map(fullColumns.map((c) => [c.key, c.field_type]))
        const sortValue = (r: DataRow, field: string): unknown => {
          if (field === 'title') return r.title
          if (field === 'created_at' || field === 'updated_at') return r[field]
          const key = customFieldKeyOf(field)
          if (!key) return null
          if (computedKeys.has(key)) return cellValue(r.computed?.[key])
          const v = r.custom_fields?.[key]
          const t = typeOf.get(key)
          if (t === 'currency') return (v as { amount?: number } | null)?.amount ?? null
          return Array.isArray(v) || (v && typeof v === 'object') ? null : v
        }
        rows = rows
          .map((r, i) => ({ r, i }))
          .sort((a, b) => {
            for (const s of sorts) {
              const c = compareValues(sortValue(a.r, s.field), sortValue(b.r, s.field), s.direction)
              if (c) return c
            }
            return a.i - b.i
          })
          .map((x) => x.r)
      }
      if (opts.computedWhole) return { rows: offset === 0 ? rows : [], hasMore: false }
      return { rows: rows.slice(offset, offset + limit), hasMore: rows.length > offset + limit }
    }
    // Too many rows to run it here: the view without those filters and sorts.
    const page = await queryRows(db, workspaceId, tableId, columns, { ...opts, filters, ordering })
    return { ...page, computedSkipped: true }
  }

  const q = base()
  if (!(await narrowed(q))) return { rows: [], hasMore: false }
  applyOrdering(q as never, [...ordering], 'data_row', { fieldTypes })
  // One more than the page: whether there is another.
  const { data, error } = await q.order('position', { ascending: true }).order('id', { ascending: true }).range(offset, offset + limit)
  if (error) throw new Error(error.message)
  const rows = ((data ?? []) as DataRow[]).map((r) => ({ ...r, custom_fields: r.custom_fields ?? {} }))
  const page = rows.slice(0, limit)
  return { rows: opts.computed ? await withComputed(db, fullColumns, page, opts.computed) : page, hasMore: rows.length > limit }
}

/**
 * A table's write history, newest first. With `afterVersion`, only the
 * changes after it, oldest first (what a reader holding that version missed).
 * With `summary`, a type change's every-row values are its count.
 */
export async function listChanges(
  db: SupabaseClient,
  workspaceId: string,
  tableId: string,
  limit = 50,
  opts: { summary?: boolean; afterVersion?: number } = {},
): Promise<DataChange[]> {
  let q = db.from('data_change').select(CHANGE_SELECT).eq('workspace_id', workspaceId).eq('table_id', tableId)
  if (opts.afterVersion !== undefined) q = q.gt('version', opts.afterVersion)
  const { data, error } = await q
    .order(opts.afterVersion !== undefined ? 'version' : 'created_at', { ascending: opts.afterVersion !== undefined })
    .limit(Math.min(Math.max(1, limit), 200))
  if (error) throw new Error(error.message)
  const changes = (data ?? []) as DataChange[]
  return opts.summary ? changes.map(summarizeChange) : changes
}

/**
 * A change as the history shows it: a type change's every-row before and
 * after (about 100 bytes a value, so a megabyte for 10,000 rows) becomes its
 * count. The undo reads the whole change by its id.
 */
export function summarizeChange(change: DataChange): DataChange {
  if (!Array.isArray(change.changes) || !change.changes.some((e) => e?.op === 'change_column_type')) return change
  return {
    ...change,
    changes: change.changes.map((e) =>
      e?.op === 'change_column_type' ? { ...e, values: {}, value_count: Object.keys(e.values ?? {}).length } : e,
    ),
  }
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface CreateTableInput {
  name: string
  visibility?: DataTableVisibility
  icon?: string | null
  description?: string | null
  /** Columns past the Name column (the title, every table has it). A key, when given, is the column's (else made from its label). */
  columns?: Array<{ key?: string; label: string; field_type: DataColumnType; options?: string[]; config?: CustomFieldConfig }>
  /** Blank rows to start with (default NEW_TABLE_ROWS), when it has no `rows`. */
  blankRows?: number
  /** Rows to start with instead of blank ones, their values by column key. */
  rows?: NewRow[]
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

  const raw: DataOpInput[] = (input.columns ?? []).map((c) => ({ op: 'create_column', ...(c.key ? { key: c.key } : {}), label: c.label, field_type: c.field_type, options: c.options, config: c.config }))
  if (input.rows?.length) raw.push({ op: 'insert_rows', rows: input.rows })
  else if (blank > 0) raw.push({ op: 'insert_rows', rows: Array.from({ length: blank }, () => ({})) })
  const checked = raw.length ? validateOps([], raw) : { ok: true as const, value: [] as DataOp[] }
  if (!checked.ok) return { ok: false, reason: 'invalid', error: checked.error }
  const reason = actor.reason?.trim().slice(0, TABLE_LIMITS.reason) || null

  const { data, error } = await db.rpc('create_data_table', {
    p_workspace_id: workspaceId,
    p_name: name,
    p_visibility: visibility,
    p_icon: input.icon ?? null,
    p_description: input.description?.trim() || null,
    p_ops: checked.value,
    p_source: actor.source,
    p_as_user: actor.asUserId ?? null,
    ...(reason ? { p_reason: reason } : {}),
    ...writeExtras(actor),
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
  const checked = validateOps(columns, input.ops, { archived: !!table.archived_at })
  if (!checked.ok) return { ok: false, reason: 'invalid', error: checked.error }
  const required = await requiredWhenOnRows(db, tableId, columns, checked.value)
  if (required) return { ok: false, reason: 'invalid', error: required }
  const rollup = await rollupProblem(db, workspaceId, tableId, columns, checked.value)
  if (rollup) return { ok: false, reason: 'invalid', error: rollup }
  return rpcApply(db, tableId, input.baseVersion, checked.value, actor, null)
}

/**
 * Required when, for the rows a batch edits that it didn't make (validateOps
 * checks the ones it makes): their values now, the batch's edits merged in,
 * against the columns' rules. One read, and only when a column has a rule.
 * The database checks the same (525), so a row someone changed in between
 * is still caught.
 */
async function requiredWhenOnRows(db: SupabaseClient, tableId: string, columns: readonly DataColumn[], ops: readonly DataOp[]): Promise<string | null> {
  if (!columns.some((c) => c.config?.required_when && !c.deleted_at)) return null
  const made = new Set(ops.flatMap((o) => (o.op === 'insert_rows' ? o.rows.map((r) => r.id).filter((id): id is string => !!id) : [])))
  const edits = new Map<string, { title?: string; values: Record<string, unknown>; changed: Set<string> }>()
  for (const o of ops) {
    if (o.op !== 'update_row' || made.has(o.row_id)) continue
    const e = edits.get(o.row_id) ?? edits.set(o.row_id, { values: {}, changed: new Set() }).get(o.row_id)!
    if (o.title !== undefined) e.title = o.title
    for (const [k, v] of Object.entries(o.values ?? {})) {
      e.values[k] = v
      e.changed.add(k)
    }
  }
  const ids = [...edits.keys()].filter((id) => edits.get(id)!.changed.size)
  if (!ids.length) return null
  const { data, error } = await db.from('data_row').select('id, title, custom_fields').eq('table_id', tableId).in('id', ids.slice(0, 1000))
  if (error) return null
  for (const r of (data ?? []) as Array<{ id: string; title: string | null; custom_fields: Record<string, unknown> | null }>) {
    const e = edits.get(r.id)!
    const values: Record<string, unknown> = { ...(r.custom_fields ?? {}) }
    for (const [k, v] of Object.entries(e.values)) {
      if (v === null) delete values[k]
      else values[k] = v
    }
    const problem = requiredWhenProblem(columns, { title: e.title ?? r.title ?? '', values }, e.changed)
    if (problem) return problem
  }
  return null
}

/**
 * A rollup the batch makes or changes, checked against the records it reads
 * (validateOps can't see another table): its field there, and a function
 * that suits that field's type.
 */
async function rollupProblem(db: SupabaseClient, workspaceId: string, tableId: string, columns: readonly DataColumn[], ops: readonly DataOp[]): Promise<string | null> {
  const touched = ops.filter(
    (o): o is Extract<DataOp, { op: 'create_column' | 'update_column' }> =>
      (o.op === 'create_column' && o.field_type === 'rollup') || (o.op === 'update_column' && !!o.config && columns.some((c) => c.key === o.key && c.field_type === 'rollup')),
  )
  if (!touched.length) return null
  // The columns as the batch leaves them, as far as rollups need.
  let after: DataColumn[] = columns.filter((c) => !c.deleted_at)
  for (const o of ops) {
    if (o.op === 'create_column') {
      after.push({ id: '', table_id: tableId, key: o.key, label: o.label, field_type: o.field_type, options: o.options ?? [], config: o.config ?? {}, position: after.length, deleted_at: null })
    } else if (o.op === 'update_column') {
      after = after.map((c) => (c.key === o.key ? { ...c, ...(o.label !== undefined ? { label: o.label } : {}), ...(o.config ? { config: o.config } : {}) } : c))
    } else if (o.op === 'delete_column') {
      after = after.filter((c) => c.key !== o.key)
    }
  }
  const ctx = await computedContext(db, workspaceId, after)
  for (const o of touched) {
    const e = ctx.plan.entries.get(o.key)
    if (e?.error) return `${after.find((c) => c.key === o.key)?.label ?? o.key}: ${e.error}`
  }
  return null
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
    ...writeExtras(actor),
    ...(actor.sourceRef?.trim() ? { p_source_ref: actor.sourceRef.trim().slice(0, 200) } : {}),
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
  // The rows holding an option the undo could drop (520 refuses to drop one in use).
  const optionUses = new Map<string, Array<{ rowId: string; value: string }>>()
  for (const [key, { options, multi }] of optionsAnUndoCouldDrop(change, columns)) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(key)) continue
    // One past the touched rows is enough: then at least one untouched row holds it.
    if (!multi) {
      const { data, error } = await db
        .from('data_row')
        .select(`id, value:custom_fields->>${key}`)
        .eq('table_id', tableId)
        .in(`custom_fields->>${key}`, options)
        .limit(rows.size + 1)
      if (error) throw new Error(error.message)
      optionUses.set(key, ((data ?? []) as unknown as Array<{ id: string; value: string }>).map((r) => ({ rowId: String(r.id), value: String(r.value) })))
      continue
    }
    // A multi-select holds a list: each option is read by containment.
    const uses: Array<{ rowId: string; value: string }> = []
    for (const option of options.slice(0, 50)) {
      const { data, error } = await db
        .from('data_row')
        .select('id')
        .eq('table_id', tableId)
        .contains('custom_fields', { [key]: [option] })
        .limit(rows.size + 1)
      if (error) throw new Error(error.message)
      for (const r of (data ?? []) as Array<{ id: string }>) uses.push({ rowId: String(r.id), value: option })
    }
    optionUses.set(key, uses)
  }
  const memberId = await callerMemberId(db, workspaceId, actor)
  const plan = planUndo(change, {
    table,
    isOwner: !!memberId && table.owner_member_id === memberId,
    columns,
    rows,
    optionUses,
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
