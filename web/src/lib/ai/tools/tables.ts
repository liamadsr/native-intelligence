import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { CUSTOM_FIELD_TYPES, coerceCustomValue, hasOptions, type CustomFieldConfig, type CustomFieldValue } from '@/lib/crm/custom-fields'
import { RELATION_TARGET_KINDS, formatCurrency, relationIds, type CurrencyValue } from '@/lib/crm/custom-field-types'
import { fieldValueLabels, visibleRelationTargets } from '@/lib/crm/custom-field-references'
import { visiblePrivateKindIds } from '@/lib/knowledge/entity-fences'
import { readMemberTimeZone } from '@/lib/agent-events/member-time-zone'
import { isTimeZone } from '@/lib/chat-cards/calendar'
import { canOfferUndo, describeChange } from '@/lib/tables/describe'
import { isUuid, newColumnKey } from '@/lib/tables/ops'
import { applyOps, createTable, getTable, listChanges, listColumns, listTables, queryRows, undoChange, MAX_ROWS_PAGE, type TableActor } from '@/lib/tables/store'
import { COMPUTED_COLUMN_TYPES, isComputedType, TABLE_LIMITS, type DataColumn, type DataOp, type DataRow, type DataTable, type DataTableWithColumns, type NewRow } from '@/lib/tables/types'
import { cellValueOfRow, ROLLUP_FNS, type RollupFn } from '@/lib/tables/computed'
import { TITLE_REF, toDisplayFormula } from '@/lib/tables/formula'
import { customFieldPath } from '@/lib/views/custom-field-columns'
import type { FilterOperator, SortConfig, ViewFilter } from '@/lib/views/types'
import { resolveCreateWorkspace, resolveEntityWorkspace, workspaceEcho, type CreateWorkspacePolicy } from './_shared'

/**
 * Tables (phase 5): the agent finds, makes and fills the workspace's own
 * tables (src/lib/tables). A table is rows under typed columns; every write
 * is one batch through applyOps (or createTable), logged with its before and
 * after, so the person sees it in the table's History with Undo.
 *
 * Apply with undo: when the person asks, or an email, meeting
 * or text clearly changes a row, the agent writes it with `because` and says
 * what it changed; there is no approval queue. `undo_table_change` takes a
 * change back. A table the agent made is archived by the person's own click.
 *
 * These may run on a service-role client (the eve tool proxies, the MCP
 * bridge): RLS does not apply, so every table is fenced here first with the
 * database's own rule (visible_data_table_ids), without grants on a guest's
 * or a linked agent's turn (omitGrants), and every write names the person
 * (asUserId) and passes the same grants answer to the RPC (530). A grant to
 * edit lets a write through only on the person's own attended turn
 * (editGrants). Linked records are named only when the person can read them.
 */

/** Rows one query_rows page returns by default. */
const DEFAULT_ROWS = 25

const columnTypes = [...CUSTOM_FIELD_TYPES, ...COMPUTED_COLUMN_TYPES] as const

const columnSpec = z.object({
  name: z.string().min(1).max(TABLE_LIMITS.label).describe('e.g. "Due back".'),
  type: z
    .enum(columnTypes)
    .describe(
      'text, number, date, select, multi_select, checkbox, url, email, phone, person (a workspace member), currency, relation, formula (worked out from the row\'s other columns) or rollup (worked out from the records a relation links).',
    ),
  options: z.array(z.string()).max(TABLE_LIMITS.options).optional().describe('select and multi_select: the choices, e.g. ["Out", "Returned", "Late"].'),
  currency: z.string().length(3).optional().describe('currency: the ISO code, default USD.'),
  links_to: z.enum(RELATION_TARGET_KINDS).optional().describe("relation: the kind it links (data_row: another table's rows, with links_to_table)."),
  links_to_table: z.string().optional().describe('relation to data_row: that table, by id or name.'),
  multiple: z.boolean().optional().describe('relation: links several records.'),
  expression: z
    .string()
    .max(2000)
    .optional()
    .describe(
      'formula: the expression. Columns by name in braces ({Name} is the row\'s name), numbers, "text", true/false; + - * / and = != < <= > >=; if(cond, a, b), and(), or(), not(), concat(), round(n, digits), min(), max(), today(), days_between(start, end), empty(x). E.g. "{Qty} * {Unit price}", "days_between(today(), {Due back})", "if({Paid}, \\"Done\\", \\"Chase\\")". Only columns made before it.',
    ),
  through: z.string().optional().describe('rollup: the relation column it reads through, by name.'),
  aggregate: z.enum(ROLLUP_FNS).optional().describe('rollup: count, sum, avg, min, max, earliest, latest or list.'),
  of: z.string().optional().describe('rollup: the linked records\' field it reads, by name ("Name" for their names). Not for count.'),
})

const valueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.object({ amount: z.number(), currency: z.string().optional() }), z.null()])

const valuesSchema = z
  .record(z.string(), valueSchema)
  .optional()
  .describe('Values by column name, e.g. {"Item": "Tile saw", "Due back": "2026-11-20", "Status": "Out"}. A date is YYYY-MM-DD, a person a member\'s name or "me", a relation record ids; null clears one.')

const becauseField = z
  .string()
  .max(TABLE_LIMITS.reason)
  .optional()
  .describe('One sentence the person sees in the table\'s History, e.g. "Robin texted that the saw came back". Always set it when an email, meeting or text made the change.')

const tableField = z.string().min(1).describe('The table: its id (from find_tables) or its name.')

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

/** An id or a name? (isUuid narrows, and a name is a string too.) */
const isId = (s: string): boolean => isUuid(s)

/** Today's date in a zone, as YYYY-MM-DD (UTC when the zone is not one). */
function localDay(timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  } catch {
    return new Date().toISOString().slice(0, 10)
  }
}

/**
 * "today", "tomorrow", "yesterday" as the person's day in their zone; null
 * for anything else. A day is added to the local date as a calendar day, not
 * as 24 hours, so a DST change can't skip or repeat one.
 */
export function dayWordDate(value: unknown, timeZone: string): string | null {
  if (typeof value !== 'string') return null
  const word = value.trim().toLowerCase()
  const shift = word === 'today' ? 0 : word === 'tomorrow' ? 1 : word === 'yesterday' ? -1 : null
  if (shift === null) return null
  const [y, m, d] = localDay(timeZone).split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + shift)).toISOString().slice(0, 10)
}

const isDayWord = (value: unknown) => dayWordDate(value, 'UTC') !== null

const isTitleName = (name: string) => ['name', 'title'].includes(name.trim().toLowerCase())

/** A column by its key or its name, any case. */
function columnNamed(columns: readonly DataColumn[], name: string): DataColumn | null {
  const want = name.trim().toLowerCase()
  return columns.find((c) => c.key === name) ?? columns.find((c) => c.label.toLowerCase() === want) ?? null
}

function noColumn(table: DataTableWithColumns, name: string): string {
  const names = ['Name', ...table.columns.map((c) => c.label)].join(', ')
  return `No column "${name}" in ${table.name}. Its columns: ${names}.`
}

/** A column as the agent reads it: its name, type and what the type takes. */
function describeColumn(c: DataColumn, columns: readonly DataColumn[], tableNames: ReadonlyMap<string, string>) {
  const config = c.config ?? {}
  const rule = config.required_when
  const on = rule ? columns.find((x) => x.key === rule.key) : null
  const target = config.target
  return {
    name: c.label,
    key: c.key,
    type: c.field_type,
    ...(hasOptions(c.field_type) ? { options: c.options } : {}),
    ...(c.field_type === 'currency' ? { currency: config.currency ?? 'USD' } : {}),
    ...(target ? { links_to: target.kind, ...(target.table_id ? { links_to_table: tableNames.get(target.table_id) ?? target.table_id } : {}), multiple: !!config.multiple } : {}),
    ...(rule && on ? { required_when: `${on.label} is ${rule.option}` } : {}),
    ...(c.field_type === 'formula' ? { expression: toDisplayFormula(config.expression ?? '', columns) } : {}),
    ...(c.field_type === 'rollup'
      ? { through: columns.find((x) => x.key === config.relation)?.label ?? config.relation, aggregate: config.fn, ...(config.field ? { of: config.field === TITLE_REF ? 'Name' : config.field } : {}) }
      : {}),
    ...(c.computed?.error ? { error: c.computed.error } : {}),
  }
}

/** A value as the agent reads it: a date stays YYYY-MM-DD, a person or a linked record is its name. */
function compactValue(c: DataColumn, value: unknown, labels: Record<string, string>): unknown {
  if (value === null || value === undefined) return undefined
  switch (c.field_type) {
    case 'currency': {
      const v = value as Partial<CurrencyValue>
      return typeof v?.amount === 'number' && typeof v.currency === 'string' ? formatCurrency(v as CurrencyValue) : undefined
    }
    case 'person':
      return typeof value === 'string' ? (labels[value] ?? 'a member') : undefined
    case 'relation': {
      const names = relationIds(value).map((id) => labels[id]).filter((x): x is string => !!x)
      return names.length ? names : undefined
    }
    default:
      return value
  }
}

function compactRow(row: DataRow, columns: readonly DataColumn[], labels: Record<string, string>) {
  const values: Record<string, unknown> = {}
  for (const c of columns) {
    if (isComputedType(c.field_type)) {
      // A formula's or a rollup's cell, worked out for the person as the rows were read.
      const { value, error } = cellValueOfRow(c, row)
      if (error) values[c.label] = { error }
      else if (value !== null && value !== '') values[c.label] = value
      continue
    }
    const v = compactValue(c, Object.prototype.hasOwnProperty.call(row.custom_fields ?? {}, c.key) ? row.custom_fields[c.key] : undefined, labels)
    if (v !== undefined && v !== '') values[c.label] = v
  }
  return { id: row.id, name: row.title || 'Untitled', ...(Object.keys(values).length ? { values } : {}) }
}

export function createTableTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
  createWorkspacePolicy: CreateWorkspacePolicy = 'session',
  // EDIT GRANTS (512): a grant to edit lets a write through only on the
  // person's own attended turn (createTools derives it).
  editGrants = false,
  // A guest's or a linked agent's turn: a table shared with the person is not
  // there, and the writes say so to the database (530).
  omitGrants = false,
  /** The person's zone this turn: "today" in a filter is their day. */
  timeZone?: string | null,
) {
  const grantOpts = omitGrants ? { grants: false } : {}
  const actor = (because: string | undefined): TableActor => ({
    userId,
    source: 'agent',
    reason: because?.trim() || null,
    asUserId: userId,
    ...(omitGrants ? { grants: false } : {}),
  })
  const workspaceIdField = z
    .string()
    .optional()
    .describe('Workspace to create in. Defaults to the active workspace. Copy it from the workspace_id on rows you read, or from active_workspace.')

  const lookupWorkspaceField = z
    .string()
    .optional()
    .describe("A table named in another of the person's workspaces: that workspace's id. Defaults to the active workspace; a table's id finds it anywhere.")

  /**
   * The person's zone, read once and only when a day is needed: the browser's
   * this turn, else their saved one (readMemberTimeZone's chain), else UTC.
   * Most turns (texts, Slack, MCP, runs) carry no browser zone.
   */
  let zone: Promise<string> | null = null
  const personZone = () =>
    (zone ??= (async () => {
      if (isTimeZone(timeZone)) return timeZone
      try {
        return (await readMemberTimeZone(supabase, { workspaceId, userId })).timeZone
      } catch {
        return 'UTC'
      }
    })())
  /** A day word as the person's date; any other value as it is. */
  const dayIn = async (value: unknown) => (isDayWord(value) ? dayWordDate(value, await personZone()) : value)

  /** The ids among `ids` the person may read in `ws`. */
  const readableIds = (ws: string, ids: string[]) => visiblePrivateKindIds(supabase, 'data_table', userId, ids, ws, grantOpts)

  /** The workspace a table's name is looked up in: the one named (a member's), else the active one. */
  async function lookupWorkspace(explicit: string | undefined): Promise<Checked<string>> {
    if (!explicit) return { ok: true, value: workspaceId }
    const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, explicit, { strictWorkspace, policy: 'session' })
    return ws.ok ? { ok: true, value: ws.workspaceId } : fail('Workspace not found.')
  }

  /** One table by id or name, among those the person can read, with its live columns. */
  async function openTable(ref: string, explicitWorkspace?: string): Promise<Checked<{ ws: string; table: DataTableWithColumns }>> {
    const text = ref.trim()
    if (isId(text)) {
      const ws = (await resolveEntityWorkspace(supabase, userId, 'data_table', text, workspaceId, strictWorkspace))?.workspaceId
      if (!ws || !(await readableIds(ws, [text])).has(text)) return fail(`No table ${text} that you can open. find_tables lists them.`)
      const table = await getTable(supabase, ws, text)
      return table ? { ok: true, value: { ws, table } } : fail(`No table ${text} that you can open. find_tables lists them.`)
    }
    const lookup = await lookupWorkspace(explicitWorkspace)
    if (!lookup.ok) return lookup
    const ws = lookup.value
    const all = await listTables(supabase, ws)
    const seen = await readableIds(ws, all.map((t) => t.id))
    const tables = all.filter((t) => seen.has(t.id))
    const want = text.toLowerCase()
    const exact = tables.filter((t) => t.name.toLowerCase() === want)
    const hits = exact.length ? exact : tables.filter((t) => t.name.toLowerCase().includes(want))
    if (hits.length > 1) return fail(`"${text}" matches several tables: ${hits.slice(0, 8).map((t) => `${t.name} (${t.id})`).join(', ')}. Use its id.`)
    if (!hits.length) {
      const some = tables.slice(0, 12).map((t) => t.name)
      return fail(`No table named "${text}".${some.length ? ` Tables: ${some.join(', ')}.` : ' There are no tables yet: create_table makes one.'}`)
    }
    const table = await getTable(supabase, ws, hits[0].id)
    return table ? { ok: true, value: { ws, table } } : fail(`No table named "${text}".`)
  }

  /**
   * Why the person can't change this table here, or null. A table reached
   * only by a grant changes on their own attended turn (editGrants) and only
   * with an edit grant; the database checks the same (data_table_editable_by).
   */
  async function editRefusal(ws: string, table: DataTable): Promise<string | null> {
    const { data } = await supabase.from('member').select('id, role').eq('workspace_id', ws).eq('user_id', userId).maybeSingle()
    const me = data as { id: string; role: string } | null
    if (!me) return 'Table not found.'
    if (me.role === 'guest') return "A guest of this workspace can read its tables but can't change them."
    if (table.visibility === 'workspace' || table.owner_member_id === me.id) return null
    if (!editGrants) return `${table.name} was shared with the person, so it changes only when they ask you in their own chat.`
    const { data: editable, error } = await supabase.rpc('data_table_editable_by', { p_table_id: table.id, p_user_id: userId })
    if (error || editable !== true) return `The person can view ${table.name} but not change it.`
    return null
  }

  /** A table to write: found, readable and the person's to change. */
  async function writableTable(ref: string, explicitWorkspace?: string): Promise<Checked<{ ws: string; table: DataTableWithColumns }>> {
    const found = await openTable(ref, explicitWorkspace)
    if (!found.ok) return found
    const refused = await editRefusal(found.value.ws, found.value.table)
    return refused ? fail(refused) : found
  }

  /** The workspace's members by name, for a person column ("me", "Robin"). */
  async function members(ws: string): Promise<Array<{ id: string; name: string; me: boolean }>> {
    const { data } = await supabase.from('member').select('id, display_name, user_id').eq('workspace_id', ws)
    return ((data ?? []) as Array<{ id: string; display_name: string | null; user_id: string | null }>).map((m) => ({
      id: m.id,
      name: (m.display_name ?? '').trim(),
      me: m.user_id === userId,
    }))
  }

  /** Values by column name, each in its column's stored form (coerceCustomValue), keyed by column key. */
  async function valuesFor(ws: string, table: DataTableWithColumns, raw: Record<string, unknown> | undefined): Promise<Checked<{ title?: string; values: Record<string, CustomFieldValue> }>> {
    const out: Record<string, CustomFieldValue> = {}
    let title: string | undefined
    let people: Awaited<ReturnType<typeof members>> | null = null
    for (const [name, value] of Object.entries(raw ?? {})) {
      const col = columnNamed(table.columns, name)
      if (!col) {
        if (isTitleName(name)) {
          title = value === null ? '' : String(value).trim()
          continue
        }
        return fail(noColumn(table, name))
      }
      let v: unknown = value
      if (col.field_type === 'person' && typeof v === 'string' && v.trim() && !isId(v.trim())) {
        people ??= await members(ws)
        const want = v.trim().toLowerCase()
        const hit = want === 'me' || want === '@me' ? people.find((m) => m.me) : people.filter((m) => m.name.toLowerCase() === want).length === 1 ? people.find((m) => m.name.toLowerCase() === want) : null
        if (!hit) return fail(`${col.label} takes a member of this workspace: no one named "${v}" (or several are).`)
        v = hit.id
      }
      if (col.field_type === 'date') v = await dayIn(v)
      const coerced = coerceCustomValue(col, v)
      if (!coerced.ok) return fail(coerced.error)
      out[col.key] = coerced.value
    }
    return { ok: true, value: { ...(title !== undefined ? { title } : {}), values: out } }
  }

  /** A column's config from its spec: a currency's code, a relation's target. */
  async function configFor(
    spec: z.infer<typeof columnSpec>,
    /** The table's columns as the batch has them so far: a rollup's relation is one of them. */
    columns: ReadonlyArray<{ key: string; label: string; field_type: string; config?: CustomFieldConfig }> = [],
  ): Promise<Checked<CustomFieldConfig | undefined>> {
    if (spec.type === 'formula') {
      if (!spec.expression?.trim()) return fail(`${spec.name}: a formula needs its expression.`)
      return { ok: true, value: { expression: spec.expression.trim() } }
    }
    if (spec.type === 'rollup') {
      const want = spec.through?.trim().toLowerCase()
      const relation = want ? columns.find((c) => c.label.trim().toLowerCase() === want) : undefined
      if (!relation || relation.field_type !== 'relation' || !relation.config?.target) return fail(`${spec.name}: a rollup reads through one of the table's relation columns (through).`)
      const fn: RollupFn = spec.aggregate ?? 'count'
      let field: string | null = null
      const of = spec.of?.trim()
      if (of && fn !== 'count') {
        if (['name', 'title'].includes(of.toLowerCase())) field = TITLE_REF
        else if (relation.config.target.kind === 'data_row' && relation.config.target.table_id) {
          const other = await openTable(relation.config.target.table_id)
          if (!other.ok) return other
          const col = columnNamed(other.value.table.columns, of)
          if (!col) return fail(noColumn(other.value.table, of))
          field = col.key
        } else field = of
      }
      return { ok: true, value: { relation: relation.key, fn, field } }
    }
    if (spec.type === 'currency') return { ok: true, value: spec.currency ? { currency: spec.currency.toUpperCase() } : undefined }
    if (spec.type !== 'relation') return { ok: true, value: undefined }
    if (!spec.links_to) return fail(`${spec.name}: a relation needs links_to, the kind it links.`)
    if (spec.links_to !== 'data_row') return { ok: true, value: { target: { kind: spec.links_to }, ...(spec.multiple ? { multiple: true } : {}) } }
    if (!spec.links_to_table) return fail(`${spec.name}: a relation to a table's rows needs links_to_table.`)
    const other = await openTable(spec.links_to_table)
    if (!other.ok) return other
    return { ok: true, value: { target: { kind: 'data_row', table_id: other.value.table.id }, ...(spec.multiple ? { multiple: true } : {}) } }
  }

  /**
   * The names the person and relation values among `rows` show as. A linked
   * record is named only when the person may read it; members always are.
   */
  async function labelsFor(ws: string, columns: readonly DataColumn[], rows: readonly DataRow[]): Promise<Record<string, string>> {
    const named = columns.filter((c) => c.field_type === 'person' || (c.field_type === 'relation' && c.config?.target))
    if (!named.length || !rows.length) return {}
    const records = rows.map((r) => ({ ...(r.custom_fields ?? {}) }) as Record<string, unknown>)
    for (const c of named) {
      if (c.field_type !== 'relation') continue
      const ids = [...new Set(records.flatMap((v) => relationIds(v[c.key])))]
      const ok = ids.length ? await visibleRelationTargets(supabase, { workspaceId: ws, userId, grants: !omitGrants }, c.config!.target!, ids) : new Set<string>()
      for (const v of records) {
        const kept = relationIds(v[c.key]).filter((id) => ok.has(id))
        if (kept.length) v[c.key] = kept
        else delete v[c.key]
      }
    }
    return fieldValueLabels(supabase, ws, named, records)
  }

  /** The rows of `table` named in `refs`, by id or by name; one problem refuses them all. */
  async function rowsNamed(table: DataTableWithColumns, refs: string[]): Promise<Checked<Array<{ id: string; title: string }>>> {
    const ids = refs.filter(isUuid)
    const names = refs.filter((r) => !isId(r))
    const out: Array<{ id: string; title: string }> = []
    if (ids.length) {
      const { data, error } = await supabase.from('data_row').select('id, title').eq('table_id', table.id).is('archived_at', null).in('id', ids)
      if (error) return fail(error.message)
      const found = (data ?? []) as Array<{ id: string; title: string }>
      const missing = ids.filter((id) => !found.some((r) => r.id === id))
      if (missing.length) return fail(`${table.name} has no live row ${missing[0]}. query_rows finds rows.`)
      out.push(...found)
    }
    for (const name of names) {
      const pattern = name.trim().replace(/[\\%_]/g, (m) => `\\${m}`)
      const { data, error } = await supabase.from('data_row').select('id, title').eq('table_id', table.id).is('archived_at', null).ilike('title', pattern).limit(6)
      if (error) return fail(error.message)
      const hits = (data ?? []) as Array<{ id: string; title: string }>
      if (!hits.length) return fail(`${table.name} has no row named "${name}". query_rows finds rows; leave match out to add a new one.`)
      if (hits.length > 1) return fail(`${hits.length > 5 ? 'Several' : hits.length} rows in ${table.name} are named "${name}". Use their ids: ${hits.slice(0, 5).map((r) => r.id).join(', ')}.`)
      out.push(hits[0])
    }
    return { ok: true, value: out }
  }

  /** A view's filter field for a column name: the row's name, its times, or a column. */
  function fieldFor(table: DataTableWithColumns, name: string): Checked<{ field: string; column: DataColumn | null }> {
    const col = columnNamed(table.columns, name)
    if (col) return { ok: true, value: { field: customFieldPath(col.key), column: col } }
    const want = name.trim().toLowerCase()
    if (isTitleName(want)) return { ok: true, value: { field: 'title', column: null } }
    if (want === 'created' || want === 'created_at') return { ok: true, value: { field: 'created_at', column: null } }
    if (want === 'updated' || want === 'updated_at') return { ok: true, value: { field: 'updated_at', column: null } }
    return fail(noColumn(table, name))
  }

  const refusal = (r: { ok: false; error: string; version?: number; reason?: string }) => ({
    success: false,
    error: r.reason === 'conflict' ? 'The table changed while you were writing. Read it again and retry.' : r.error,
  })

  const createIn = (explicit: string | undefined) =>
    resolveCreateWorkspace(supabase, userId, workspaceId, explicit, { strictWorkspace, policy: createWorkspacePolicy })

  return {
    find_tables: tool({
      description:
        'Find the workspace\'s tables (its own databases: rows under typed columns), each with its columns. Use it before create_table, so a list the person already keeps is added to, not made twice, and to find a table to read or write.',
      inputSchema: z.object({
        search: z.string().optional().describe('Part of the table\'s name.'),
        workspace_id: lookupWorkspaceField,
      }),
      execute: async ({ search, workspace_id }) => {
        try {
          const lookup = await lookupWorkspace(workspace_id)
          if (!lookup.ok) return { success: false, error: lookup.error }
          const ws = lookup.value
          const all = await listTables(supabase, ws)
          const seen = await readableIds(ws, all.map((t) => t.id))
          const want = search?.trim().toLowerCase()
          const tables = all.filter((t) => seen.has(t.id) && (!want || t.name.toLowerCase().includes(want))).slice(0, 50)
          const columns = await Promise.all(tables.map((t) => getTable(supabase, ws, t.id).then((x) => x?.columns ?? [])))
          return {
            success: true,
            count: tables.length,
            tables: tables.map((t, i) => ({
              id: t.id,
              name: t.name,
              ...(t.icon ? { icon: t.icon } : {}),
              ...(t.description ? { description: t.description } : {}),
              visibility: t.visibility,
              columns: ['Name (each row\'s name)', ...columns[i].map((c) => `${c.label} (${c.field_type})`)],
              updated_at: t.updated_at,
            })),
            ...(tables.length === 0 ? { note: search ? `No table matches "${search}".` : 'There are no tables yet.' } : {}),
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),

    get_table: tool({
      description:
        "One table in full: every column with its type, options and what it links to, how many rows it has, its saved views, whether the person can change it, and its latest changes (the change ids are what undo_table_change takes).",
      inputSchema: z.object({ table: tableField, workspace_id: lookupWorkspaceField }),
      execute: async ({ table: ref, workspace_id }) => {
        try {
          const found = await openTable(ref, workspace_id)
          if (!found.ok) return { success: false, error: found.error }
          const { ws, table } = found.value
          const [count, views, changes, refused] = await Promise.all([
            supabase.from('data_row').select('id', { count: 'exact', head: true }).eq('table_id', table.id).is('archived_at', null),
            supabase.from('view').select('id, name, layout, visibility, created_by').eq('workspace_id', ws).eq('entity_type', 'data_row').eq('scope_type', 'data_table').eq('scope_id', table.id),
            listChanges(supabase, ws, table.id, 5, { summary: true }),
            editRefusal(ws, table),
          ])
          const linked = table.columns.map((c) => c.config?.target?.table_id).filter((x): x is string => !!x)
          const seen = linked.length ? await readableIds(ws, linked) : new Set<string>()
          const tableNames = new Map<string, string>()
          for (const id of seen) {
            const other = await getTable(supabase, ws, id)
            if (other) tableNames.set(id, other.name)
          }
          // A personal view is its maker's alone.
          const ownViews = ((views.data ?? []) as Array<{ id: string; name: string; layout: string; visibility: string; created_by: string | null }>).filter(
            (v) => v.visibility === 'workspace' || v.created_by === userId,
          )
          const rowCount = typeof count.count === 'number' ? count.count : Array.isArray(count.data) ? count.data.length : null
          return {
            success: true,
            table: {
              id: table.id,
              name: table.name,
              ...(table.icon ? { icon: table.icon } : {}),
              ...(table.description ? { description: table.description } : {}),
              visibility: table.visibility,
              ...(table.archived_at ? { archived: true } : {}),
              row_count: rowCount,
              columns: [{ name: 'Name', type: 'title', note: "each row's name" }, ...table.columns.map((c) => describeColumn(c, table.columns, tableNames))],
              views: ownViews.map((v) => ({ id: v.id, name: v.name, layout: v.layout, visibility: v.visibility })),
              can_edit: refused === null,
              ...(refused ? { why_not: refused } : {}),
            },
            recent_changes: changes.map((c) => ({
              change_id: c.id,
              what: describeChange(c, table.columns),
              by: c.source === 'agent' ? 'agent' : c.source,
              ...(c.reason ? { reason: c.reason } : {}),
              at: c.created_at,
              ...(c.undone_at ? { undone: true } : {}),
            })),
            ...workspaceEcho(ws),
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),

    create_table: tool({
      description:
        'Make a table when the person asks you to track, log or keep a list of something ("track my equipment rentals", "keep a list of our suppliers", "log the jobs we quote"). find_tables first: add to one that fits instead. Every table has a Name column (each row\'s name). Add the columns the thing needs, with real types: a date for when something is due or back, a select with its options for a status, a number or currency for amounts, a person for who has it, a checkbox for yes or no; a formula for a value worked out of the row (a total, days left), after the columns it uses. Rows only from what they told you. Then say in one line what you made and its columns.',
      inputSchema: z.object({
        name: z.string().min(1).max(TABLE_LIMITS.name).describe('e.g. "Equipment rentals".'),
        description: z.string().max(TABLE_LIMITS.description).optional(),
        icon: z.string().max(TABLE_LIMITS.icon).optional().describe('One emoji, e.g. "🛠️".'),
        visibility: z.enum(['workspace', 'private']).optional().describe('workspace (default: every member sees it) or private (only the person).'),
        columns: z.array(columnSpec).max(30).describe('The columns past Name, left to right.'),
        rows: z
          .array(z.object({ name: z.string().max(TABLE_LIMITS.title).optional(), values: valuesSchema }))
          .max(100)
          .optional()
          .describe('Rows to start with, only from what the person said. Omit for an empty table.'),
        because: becauseField,
        workspace_id: workspaceIdField,
      }),
      execute: async ({ name, description, icon, visibility, columns, rows, because, workspace_id }) => {
        try {
          const ws = await createIn(workspace_id)
          if (!ws.ok) return ws.error
          // Keys made here, so the starter rows can name their columns.
          const taken: string[] = []
          const specs: Array<{ key: string; label: string; field_type: DataColumn['field_type']; options?: string[]; config?: CustomFieldConfig }> = []
          for (const spec of columns) {
            if (isTitleName(spec.name)) continue
            const key = newColumnKey(spec.name, taken)
            if (!key) return { success: false, error: `"${spec.name}" needs a letter or number in it.` }
            if (specs.some((s) => s.label.toLowerCase() === spec.name.trim().toLowerCase())) return { success: false, error: `Two columns are named "${spec.name}".` }
            const config = await configFor(spec, specs)
            if (!config.ok) return { success: false, error: config.error }
            taken.push(key)
            specs.push({ key, label: spec.name.trim(), field_type: spec.type, ...(spec.options ? { options: spec.options } : {}), ...(config.value ? { config: config.value } : {}) })
          }
          const draft = { id: '', name, columns: specs.map((s, i) => ({ id: s.key, table_id: '', key: s.key, label: s.label, field_type: s.field_type, options: s.options ?? [], config: s.config ?? {}, position: i, deleted_at: null })) } as unknown as DataTableWithColumns
          const starter: NewRow[] = []
          for (const r of rows ?? []) {
            const v = await valuesFor(ws.workspaceId, draft, r.values)
            if (!v.ok) return { success: false, error: v.error }
            starter.push({ title: (r.name ?? v.value.title ?? '').trim(), values: v.value.values })
          }
          const result = await createTable(
            supabase,
            ws.workspaceId,
            { name, description: description ?? null, icon: icon ?? null, visibility, columns: specs, rows: starter, blankRows: 0 },
            actor(because),
          )
          if (!result.ok) return refusal(result)
          return {
            success: true,
            table: { id: result.value.table_id, name: name.trim(), columns: ['Name', ...specs.map((s) => `${s.label} (${s.field_type})`)], rows: result.value.inserted_row_ids.length },
            message: `Made the table "${name.trim()}" with ${specs.length ? `${specs.map((s) => s.label).join(', ')}` : 'a Name column'}${starter.length ? ` and ${starter.length} row${starter.length === 1 ? '' : 's'}` : ''}.`,
            ...workspaceEcho(ws.workspaceId, ws.workspaceName),
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),

    update_table_columns: tool({
      description:
        "Change a table's columns: add one (a formula, worked out of the row, or a rollup, worked out of the records a relation links, too), rename one, change its type (every value converts, or it refuses with how many don't fit), set a select's options, make one required while a select holds an option, or delete one. All in one batch; the person can undo it.",
      inputSchema: z.object({
        table: tableField,
        workspace_id: lookupWorkspaceField,
        changes: z
          .array(
            z.object({
              action: z.enum(['add', 'rename', 'change_type', 'set_options', 'required_when', 'delete']),
              column: z.string().min(1).describe('The column it changes, by name (add: the new column\'s name).'),
              new_name: z.string().max(TABLE_LIMITS.label).optional().describe('rename: its new name.'),
              type: z.enum(columnTypes).optional().describe('add, change_type: the type.'),
              options: z.array(z.string()).max(TABLE_LIMITS.options).optional().describe('add, change_type, set_options: a select\'s choices (set_options replaces the list).'),
              currency: z.string().length(3).optional(),
              links_to: z.enum(RELATION_TARGET_KINDS).optional(),
              links_to_table: z.string().optional(),
              multiple: z.boolean().optional(),
              expression: columnSpec.shape.expression,
              through: columnSpec.shape.through,
              aggregate: columnSpec.shape.aggregate,
              of: columnSpec.shape.of,
              when: z
                .object({ column: z.string(), option: z.string() })
                .nullable()
                .optional()
                .describe('required_when: needed while that select column holds that option, e.g. {"column": "Status", "option": "Returned"}; null drops the rule.'),
            }),
          )
          .min(1)
          .max(50),
        because: becauseField,
      }),
      execute: async ({ table: ref, workspace_id, changes, because }) => {
        try {
          const found = await writableTable(ref, workspace_id)
          if (!found.ok) return { success: false, error: found.error }
          const { ws, table } = found.value
          // A deleted column keeps its key (its undo brings it back).
          const taken = new Set<string>((await listColumns(supabase, ws, table.id, { deleted: true })).map((c) => c.key))
          const ops: Array<Record<string, unknown>> = []
          const said: string[] = []
          for (const ch of changes) {
            if (ch.action === 'add') {
              if (!ch.type) return { success: false, error: `add "${ch.column}": give its type.` }
              if (isTitleName(ch.column) || columnNamed(table.columns, ch.column)) return { success: false, error: `${table.name} already has a column "${ch.column}".` }
              const config = await configFor(
                { name: ch.column, type: ch.type, options: ch.options, currency: ch.currency, links_to: ch.links_to, links_to_table: ch.links_to_table, multiple: ch.multiple, expression: ch.expression, through: ch.through, aggregate: ch.aggregate, of: ch.of },
                table.columns,
              )
              if (!config.ok) return { success: false, error: config.error }
              const key = newColumnKey(ch.column, taken)
              if (!key) return { success: false, error: `"${ch.column}" needs a letter or number in it.` }
              taken.add(key)
              ops.push({ op: 'create_column', key, label: ch.column.trim(), field_type: ch.type, ...(ch.options ? { options: ch.options } : {}), ...(config.value ? { config: config.value } : {}) })
              said.push(`added ${ch.column.trim()}`)
              continue
            }
            if (isTitleName(ch.column) && !columnNamed(table.columns, ch.column)) return { success: false, error: "The Name column is every row's name: it can't be changed." }
            const col = columnNamed(table.columns, ch.column)
            if (!col) return { success: false, error: noColumn(table, ch.column) }
            switch (ch.action) {
              case 'rename':
                if (!ch.new_name?.trim()) return { success: false, error: `rename "${col.label}": give new_name.` }
                ops.push({ op: 'update_column', key: col.key, label: ch.new_name.trim() })
                said.push(`renamed ${col.label} to ${ch.new_name.trim()}`)
                break
              case 'change_type': {
                if (!ch.type) return { success: false, error: `change_type "${col.label}": give its new type.` }
                const config = await configFor({ name: col.label, type: ch.type, options: ch.options, currency: ch.currency, links_to: ch.links_to, links_to_table: ch.links_to_table, multiple: ch.multiple })
                if (!config.ok) return { success: false, error: config.error }
                ops.push({ op: 'change_column_type', key: col.key, field_type: ch.type, ...(ch.options ? { options: ch.options } : {}), ...(config.value ? { config: config.value } : {}) })
                said.push(`made ${col.label} a ${ch.type.replace('_', '-')} column`)
                break
              }
              case 'set_options':
                if (!ch.options) return { success: false, error: `set_options "${col.label}": give the options.` }
                ops.push({ op: 'update_column', key: col.key, options: ch.options })
                said.push(`set ${col.label}'s options`)
                break
              case 'required_when': {
                const config: CustomFieldConfig = { ...(col.config ?? {}) }
                if (ch.when) {
                  const on = columnNamed(table.columns, ch.when.column)
                  if (!on) return { success: false, error: noColumn(table, ch.when.column) }
                  config.required_when = { key: on.key, option: ch.when.option }
                  said.push(`made ${col.label} needed when ${on.label} is ${ch.when.option}`)
                } else {
                  delete config.required_when
                  said.push(`${col.label} is no longer required`)
                }
                ops.push({ op: 'update_column', key: col.key, config })
                break
              }
              case 'delete':
                ops.push({ op: 'delete_column', key: col.key })
                said.push(`deleted ${col.label}`)
                break
            }
          }
          const result = await applyOps(supabase, ws, table.id, { baseVersion: null, ops }, actor(because))
          if (!result.ok) return refusal(result)
          return {
            success: true,
            table: { id: table.id, name: table.name },
            change_id: result.value.change_id,
            message: result.value.change_id ? `In ${table.name}: ${said.join('; ')}. The person can undo it.` : 'Nothing changed.',
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),

    write_rows: tool({
      description:
        "Add rows to a table, or change rows already there, in one batch. A row with `id` (or `match`, its exact name) is changed; one with neither is added. Values go by column name and must fit the column's type (get_table has them). When the person asks, or an email, meeting or text clearly changes a row (a rental came back, an order's date moved), write it with `because`, then say what you changed; they can undo it. Don't ask first.",
      inputSchema: z.object({
        table: tableField,
        workspace_id: lookupWorkspaceField,
        rows: z
          .array(
            z.object({
              id: z.string().optional().describe('A row to change, by id.'),
              match: z.string().optional().describe("A row to change, by its name (exact, any case)."),
              name: z.string().max(TABLE_LIMITS.title).optional().describe("The row's name: a new row's, or a new one for a row you change."),
              values: valuesSchema,
            }),
          )
          .min(1)
          .max(200),
        because: becauseField,
      }),
      execute: async ({ table: ref, workspace_id, rows, because }) => {
        try {
          const found = await writableTable(ref, workspace_id)
          if (!found.ok) return { success: false, error: found.error }
          const { ws, table } = found.value
          const refs = rows.flatMap((r) => (r.id ? [r.id] : r.match ? [r.match] : []))
          const existing = refs.length ? await rowsNamed(table, refs) : { ok: true as const, value: [] }
          if (!existing.ok) return { success: false, error: existing.error }
          const byRef = new Map<string, { id: string; title: string }>()
          for (const r of rows) {
            const key = r.id ?? r.match
            if (!key) continue
            const hit = isId(key) ? existing.value.find((x) => x.id === key) : existing.value.find((x) => x.title.toLowerCase() === key.trim().toLowerCase())
            if (hit) byRef.set(key, hit)
          }
          const inserts: NewRow[] = []
          const ops: Array<Record<string, unknown>> = []
          const touched: Array<{ name: string; action: 'added' | 'changed' }> = []
          for (const r of rows) {
            const v = await valuesFor(ws, table, r.values)
            if (!v.ok) return { success: false, error: v.error }
            const name = r.name?.trim() ?? v.value.title
            const key = r.id ?? r.match
            if (key) {
              const hit = byRef.get(key)
              if (!hit) return { success: false, error: `${table.name} has no row "${key}".` }
              // A row keeps its name: a blank one is never written over it.
              if (name === '') return { success: false, error: `"${hit.title || 'Untitled'}" keeps its name: give a new one, or leave name out.` }
              const values = v.value.values
              if (name === undefined && !Object.keys(values).length) return { success: false, error: `Nothing to change on "${hit.title}".` }
              ops.push({ op: 'update_row', row_id: hit.id, ...(name !== undefined ? { title: name } : {}), ...(Object.keys(values).length ? { values } : {}) })
              touched.push({ name: name || hit.title || 'Untitled', action: 'changed' })
            } else {
              const values = Object.fromEntries(Object.entries(v.value.values).filter(([, x]) => x !== null))
              inserts.push({ title: name ?? '', ...(Object.keys(values).length ? { values } : {}) })
              touched.push({ name: name || 'Untitled', action: 'added' })
            }
          }
          if (inserts.length) ops.unshift({ op: 'insert_rows', rows: inserts })
          const result = await applyOps(supabase, ws, table.id, { baseVersion: null, ops }, actor(because))
          if (!result.ok) return refusal(result)
          const added = touched.filter((t) => t.action === 'added')
          const changed = touched.filter((t) => t.action === 'changed')
          const parts = [
            added.length ? `added ${added.map((t) => `"${t.name}"`).join(', ')}` : '',
            changed.length ? `changed ${changed.map((t) => `"${t.name}"`).join(', ')}` : '',
          ].filter(Boolean)
          return {
            success: true,
            table: { id: table.id, name: table.name },
            change_id: result.value.change_id,
            ...(result.value.inserted_row_ids.length ? { added_row_ids: result.value.inserted_row_ids } : {}),
            message: result.value.change_id ? `In ${table.name}: ${parts.join('; ')}. The person can undo it.` : 'Nothing changed: the rows already said that.',
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),

    query_rows: tool({
      description:
        'Read a table\'s rows, filtered and sorted on the server: "which rentals are overdue" is a filter on the due date column (lt "today") and on the status. Filters all must match. Returns a page of rows, each with its id, name and values by column name, and whether there are more. To show the rows to the person, use show with kind tables instead.',
      inputSchema: z.object({
        table: tableField,
        workspace_id: lookupWorkspaceField,
        filters: z
          .array(
            z.object({
              column: z.string().describe('A column by name; "Name" for the row\'s name, "Created" or "Updated" for its times.'),
              operator: z
                .enum(['is', 'is_not', 'is_any_of', 'is_none_of', 'contains', 'does_not_contain', 'gt', 'gte', 'lt', 'lte', 'between', 'is_relative', 'is_empty', 'is_not_empty'])
                .describe('A date compares with gt / lt (before "today" is lt "today"); a select with is / is_any_of.'),
              value: z
                .unknown()
                .optional()
                .describe('A date as YYYY-MM-DD or "today", "tomorrow", "yesterday"; a select\'s option; "@me" for the person; a list for is_any_of; {"from","to"} for between; omit for is_empty.'),
            }),
          )
          .max(20)
          .optional(),
        sort: z
          .array(z.object({ column: z.string(), direction: z.enum(['asc', 'desc']).optional() }))
          .max(5)
          .optional(),
        limit: z.number().int().min(1).max(100).optional().describe(`Default ${DEFAULT_ROWS}.`),
        offset: z.number().int().min(0).optional(),
      }),
      execute: async ({ table: ref, workspace_id, filters, sort, limit, offset }) => {
        try {
          const found = await openTable(ref, workspace_id)
          if (!found.ok) return { success: false, error: found.error }
          const { ws, table } = found.value
          const viewFilters: ViewFilter[] = []
          for (const [i, f] of (filters ?? []).entries()) {
            const field = fieldFor(table, f.column)
            if (!field.ok) return { success: false, error: field.error }
            const isDay = field.value.column?.field_type === 'date' || field.value.field === 'created_at' || field.value.field === 'updated_at'
            const fix = (v: unknown) => (isDay ? dayIn(v) : Promise.resolve(v))
            const raw = f.value as unknown
            const value =
              f.operator === 'between' && raw && typeof raw === 'object' && !Array.isArray(raw)
                ? { from: await fix((raw as { from?: unknown }).from), to: await fix((raw as { to?: unknown }).to) }
                : Array.isArray(raw)
                  ? await Promise.all(raw.map(fix))
                  : await fix(raw)
            viewFilters.push({ id: `agent-${i}`, field: field.value.field, operator: f.operator as FilterOperator, value: value as ViewFilter['value'] })
          }
          const ordering: SortConfig[] = []
          for (const s of sort ?? []) {
            const field = fieldFor(table, s.column)
            if (!field.ok) return { success: false, error: field.error }
            ordering.push({ field: field.value.field, direction: s.direction ?? 'asc' })
          }
          const pageSize = Math.min(limit ?? DEFAULT_ROWS, MAX_ROWS_PAGE)
          const from = offset ?? 0
          const page = await queryRows(supabase, ws, table.id, table.columns, {
            filters: viewFilters,
            ordering,
            limit: pageSize,
            offset: from,
            userId,
            // A relative window ("this week") is the person's days, as the grid reads it.
            ...(viewFilters.length ? { timeZone: await personZone() } : {}),
            // Formulas and rollups worked out for the person: a rollup counts only what they read,
            // and on a guest's or a linked agent's turn nothing a grant opens.
            computed: { workspaceId: ws, userId, grants: !omitGrants, timeZone: await personZone() },
          })
          const labels = await labelsFor(ws, table.columns, page.rows)
          return {
            success: true,
            table: { id: table.id, name: table.name },
            count: page.rows.length,
            rows: page.rows.map((r) => compactRow(r, table.columns, labels)),
            ...(page.hasMore ? { has_more: true, next_offset: from + page.rows.length } : {}),
            ...(page.computedSkipped ? { note: 'The table is too big to filter or sort by a formula or a rollup; those were left out.' } : {}),
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),

    archive_rows: tool({
      description: "Archive rows of a table (by id, or by exact name): they leave the table's views and come back with Undo. Only when the person asks, or a row is clearly finished with and they keep it that way.",
      inputSchema: z.object({
        table: tableField,
        workspace_id: lookupWorkspaceField,
        rows: z.array(z.string()).min(1).max(TABLE_LIMITS.rowsPerOp).describe('Row ids, or exact row names.'),
        because: becauseField,
      }),
      execute: async ({ table: ref, workspace_id, rows, because }) => {
        try {
          const found = await writableTable(ref, workspace_id)
          if (!found.ok) return { success: false, error: found.error }
          const { ws, table } = found.value
          const named = await rowsNamed(table, rows)
          if (!named.ok) return { success: false, error: named.error }
          const ops: DataOp[] = [{ op: 'archive_rows', row_ids: [...new Set(named.value.map((r) => r.id))] }]
          const result = await applyOps(supabase, ws, table.id, { baseVersion: null, ops }, actor(because))
          if (!result.ok) return refusal(result)
          return {
            success: true,
            table: { id: table.id, name: table.name },
            change_id: result.value.change_id,
            message: `Archived ${named.value.map((r) => `"${r.title || 'Untitled'}"`).join(', ')} in ${table.name}. The person can undo it.`,
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),

    undo_table_change: tool({
      description:
        "Take back a change to a table: every row and column it touched goes back, unless it has changed again since (then the newer value stays). Without change_id, the person's own latest change (yours on their behalf included); when a teammate changed the table after it, it asks which change, listing the latest with their ids: ask the person, then pass change_id. Use it when the person says a table change was wrong (\"undo that\").",
      inputSchema: z.object({
        table: tableField,
        workspace_id: lookupWorkspaceField,
        change_id: z.string().optional().describe('From get_table, or the change_id a write returned.'),
      }),
      execute: async ({ table: ref, workspace_id, change_id }) => {
        try {
          const found = await writableTable(ref, workspace_id)
          if (!found.ok) return { success: false, error: found.error }
          const { ws, table } = found.value
          let target = change_id ?? null
          if (!target) {
            // The person's own latest change, never a teammate's newer one by default.
            const recent = await listChanges(supabase, ws, table.id, 20, { summary: true })
            const at = recent.findIndex((c) => c.actor_user_id === userId && canOfferUndo(c))
            if (at < 0) return { success: false, error: `Nothing of the person's to undo in ${table.name}.` }
            const newer = recent.slice(0, at).filter((c) => c.actor_user_id !== userId && !c.undone_at)
            if (newer.length) {
              return {
                success: false,
                needs_change_id: true,
                error: `Someone else changed ${table.name} after the person's latest change. Ask which one to undo, then pass its change_id.`,
                changes: recent.slice(0, 5).map((c) => ({
                  change_id: c.id,
                  what: describeChange(c, table.columns),
                  by: c.actor_user_id === userId ? 'the person' : 'a teammate',
                  at: c.created_at,
                  ...(c.undone_at ? { undone: true } : {}),
                })),
              }
            }
            target = recent[at].id
          }
          const result = await undoChange(supabase, ws, table.id, target, actor(undefined))
          if (!result.ok) return refusal(result)
          const { restored, kept } = result.value
          return {
            success: true,
            table: { id: table.id, name: table.name },
            undone_change_id: result.value.undone_change_id,
            change_id: result.value.change_id,
            restored,
            kept,
            message: restored.length
              ? `Undone in ${table.name}: ${restored.join(', ')}.${kept.length ? ` Kept newer: ${kept.join(', ')}.` : ''}`
              : `Nothing to put back in ${table.name}: each part has changed again since.`,
          }
        } catch (e) {
          return { success: false, error: e instanceof Error ? e.message : String(e) }
        }
      },
    }),
  }
}

export const TABLE_TOOL_NAMES = [
  'find_tables',
  'get_table',
  'create_table',
  'update_table_columns',
  'write_rows',
  'query_rows',
  'archive_rows',
  'undo_table_change',
] as const
