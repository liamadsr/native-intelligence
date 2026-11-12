/**
 * Computed columns, the server half (Tables, phase 6): a page of rows gets
 * its formulas' and rollups' cells as it is read (./computed.ts says why
 * they are never stored).
 *
 * A rollup reads only what the READER may read. The records a relation
 * links are first fenced for the reader by the same check a relation write
 * runs (custom-field-references.ts visibleRelationTargets: RLS for the
 * person's own client, and the private-kind fences, grants included or not,
 * for the agent's service-role client), and only those are aggregated. A
 * linked row of a table the reader can't open, a private document, a
 * contact kept from them: none of it counts, and a count says how many they
 * see. The linked table's columns are read the same way, so a rollup over a
 * table the reader can't open says so instead of a type.
 *
 * Cost: one read of the linked fields' definitions per table read, and per
 * page, for each relation a rollup reads through, one fence and one read of
 * the linked records (in chunks of 200, four at a time), whatever the number
 * of rollups on it.
 *
 * SERVER ONLY.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { relationIds, type CustomFieldType, type RelationTarget } from '@/lib/crm/custom-field-types'
import { visibleRelationTargets, type ReferenceScope } from '@/lib/crm/custom-field-references'
import { entityDescriptor, WORKSPACE_SCOPED_TABLE } from '@/lib/knowledge/entity-registry'
import { resolveEntityLabels } from '@/lib/knowledge/graph-map/source'
import { aggregate, computedInfo, computeRow, own, MAX_ROLLUP_LINKS, planComputed, todayIn, type ComputedPlan, type LinkedValue, type TargetFieldType } from './computed'
import { TITLE_REF } from './formula'
import { isComputedType, TABLE_COLUMN_ENTITY_TYPE, type ComputedCell, type DataColumn, type DataRow } from './types'

const CHUNK = 200
/** Chunks read at once (a page of 2,000 rows may link thousands of records). */
const PARALLEL = 4

/** `fn` over `items` in chunks, PARALLEL chunks at a time, results in order. */
async function inChunks<T, R>(items: readonly T[], fn: (chunk: T[]) => Promise<R>): Promise<R[]> {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += CHUNK) chunks.push(items.slice(i, i + CHUNK))
  const out: R[] = new Array(chunks.length)
  let next = 0
  const worker = async () => {
    while (next < chunks.length) {
      const i = next++
      out[i] = await fn(chunks[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL, chunks.length) }, worker))
  return out
}

/** Who reads: the rollups count what they may read. */
export interface ComputedReader {
  workspaceId: string
  userId: string | null
  /** false on a guest's or a linked agent's turn (a grant opens nothing). */
  grants?: boolean
  /** The reader's zone: today() is their day. */
  timeZone?: string
}

/** What computing a table's cells needs, read once per table read. */
export interface ComputedContext {
  columns: readonly DataColumn[]
  plan: ComputedPlan
  /** Per rollup key: its relation's target and the linked field's type. */
  rollups: Map<string, { relationKey: string; target: RelationTarget; field: string | null; fieldType: TargetFieldType | null }>
}

export const hasComputed = (columns: readonly Pick<DataColumn, 'field_type' | 'deleted_at'>[]) => columns.some((c) => !c.deleted_at && isComputedType(c.field_type))

/**
 * The linked fields' types for the table's rollups: a linked table's columns
 * (through `db`, so a table the reader can't open has none), a kind's own
 * fields. One read for the tables, one for the kinds.
 */
async function targetFieldTypes(db: SupabaseClient, workspaceId: string, columns: readonly DataColumn[]): Promise<{ tables: Map<string, Map<string, CustomFieldType | 'formula' | 'rollup'>>; kinds: Map<string, Map<string, CustomFieldType>> }> {
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const tableIds = new Set<string>()
  const kinds = new Set<string>()
  for (const c of columns) {
    if (c.field_type !== 'rollup' || c.deleted_at || !c.config?.field || c.config.field === TITLE_REF) continue
    const target = byKey.get(c.config.relation ?? '')?.config?.target
    if (!target) continue
    if (target.kind === 'data_row' && target.table_id) tableIds.add(target.table_id)
    else if (entityDescriptor(target.kind)?.customFields) kinds.add(target.kind)
  }
  const tables = new Map<string, Map<string, CustomFieldType | 'formula' | 'rollup'>>()
  const kindTypes = new Map<string, Map<string, CustomFieldType>>()
  const [t, k] = await Promise.all([
    tableIds.size
      ? db.from('custom_field_definition').select('table_id, key, field_type').eq('workspace_id', workspaceId).eq('entity_type', TABLE_COLUMN_ENTITY_TYPE).in('table_id', [...tableIds]).is('deleted_at', null)
      : Promise.resolve({ data: [], error: null }),
    kinds.size
      ? db.from('custom_field_definition').select('entity_type, key, field_type').eq('workspace_id', workspaceId).in('entity_type', [...kinds]).is('table_id', null)
      : Promise.resolve({ data: [], error: null }),
  ])
  for (const r of ((t.error ? [] : t.data) ?? []) as Array<{ table_id: string; key: string; field_type: CustomFieldType }>) {
    const m = tables.get(r.table_id) ?? tables.set(r.table_id, new Map()).get(r.table_id)!
    m.set(r.key, r.field_type)
  }
  for (const r of ((k.error ? [] : k.data) ?? []) as Array<{ entity_type: string; key: string; field_type: CustomFieldType }>) {
    const m = kindTypes.get(r.entity_type) ?? kindTypes.set(r.entity_type, new Map()).get(r.entity_type)!
    m.set(r.key, r.field_type)
  }
  return { tables, kinds: kindTypes }
}

/** The plan for a table's computed columns, with each rollup's linked field read for this reader. */
export async function computedContext(db: SupabaseClient, workspaceId: string, columns: readonly DataColumn[]): Promise<ComputedContext> {
  const types = await targetFieldTypes(db, workspaceId, columns)
  const byKey = new Map(columns.filter((c) => !c.deleted_at).map((c) => [c.key, c]))
  const rollups: ComputedContext['rollups'] = new Map()
  const problems = new Map<string, string>()
  for (const c of byKey.values()) {
    if (c.field_type !== 'rollup') continue
    const relation = byKey.get(c.config?.relation ?? '')
    const target = relation?.field_type === 'relation' ? relation.config?.target : undefined
    if (!relation || !target) continue
    const field = c.config?.field ?? null
    let fieldType: TargetFieldType | null = null
    if (field === TITLE_REF) fieldType = 'title'
    else if (field !== null && target.kind === 'data_row') {
      const cols = types.tables.get(target.table_id ?? '')
      const t = cols?.get(field)
      if (!cols) problems.set(c.key, 'You can’t open the table this rollup reads.')
      else if (!t) problems.set(c.key, 'The field this rollup reads is gone.')
      else if (isComputedType(t)) problems.set(c.key, 'A rollup can’t read another table’s formula or rollup.')
      else fieldType = t
    } else if (field !== null) {
      const t = types.kinds.get(target.kind)?.get(field)
      if (!t) problems.set(c.key, 'The field this rollup reads is gone.')
      else fieldType = t
    }
    rollups.set(c.key, { relationKey: relation.key, target, field, fieldType })
  }
  const plan = planComputed(columns, (rollup) => {
    const problem = problems.get(rollup.key)
    return problem ? { error: problem } : rollups.get(rollup.key)?.fieldType ?? null
  })
  return { columns, plan, rollups }
}

/** The table's columns with each computed one's result type and error (what the grid reads). */
export function annotateColumns(ctx: ComputedContext): DataColumn[] {
  return ctx.columns.map((c) => (isComputedType(c.field_type) ? { ...c, computed: computedInfo(ctx.plan.entries.get(c.key)) } : c))
}

/** The linked records' names and fields, for one relation's target: only those the reader may read. */
async function readLinked(
  db: SupabaseClient,
  reader: ComputedReader,
  target: RelationTarget,
  ids: readonly string[],
  fields: ReadonlySet<string>,
): Promise<Map<string, { name: string; values: Record<string, unknown> }>> {
  const out = new Map<string, { name: string; values: Record<string, unknown> }>()
  if (!ids.length) return out
  const scope: ReferenceScope = { workspaceId: reader.workspaceId, userId: reader.userId, ...(reader.grants === false ? { grants: false } : {}) }
  const visible = (
    await inChunks(ids, async (chunk) => {
      const ok = await visibleRelationTargets(db, scope, target, chunk)
      return chunk.filter((id) => ok.has(id))
    })
  ).flat()
  if (!visible.length) return out
  if (target.kind === 'data_row') {
    const pages = await inChunks(visible, async (chunk) => {
      const { data, error } = await db
        .from('data_row')
        .select('id, title, custom_fields')
        .eq('workspace_id', reader.workspaceId)
        .eq('table_id', target.table_id ?? '')
        .is('archived_at', null)
        .in('id', chunk)
      if (error) throw new Error(error.message)
      return (data ?? []) as Array<{ id: string; title: string | null; custom_fields: Record<string, unknown> | null }>
    })
    for (const r of pages.flat()) out.set(r.id, { name: r.title?.trim() || 'Untitled', values: r.custom_fields ?? {} })
    return out
  }
  const names = await resolveEntityLabels(db, reader.workspaceId, new Map([[target.kind, new Set(visible)]])).catch(() => new Map<string, string>())
  for (const id of visible) out.set(id, { name: names.get(`${target.kind}:${id}`) || 'Untitled', values: {} })
  const table = WORKSPACE_SCOPED_TABLE[target.kind]
  const custom = [...fields].some((f) => f !== TITLE_REF)
  if (table && custom && entityDescriptor(target.kind)?.customFields) {
    const pages = await inChunks(visible, async (chunk) => {
      const { data, error } = await db.from(table).select('id, custom_fields').eq('workspace_id', reader.workspaceId).in('id', chunk)
      if (error) throw new Error(error.message)
      return (data ?? []) as Array<{ id: string; custom_fields: Record<string, unknown> | null }>
    })
    for (const r of pages.flat()) {
      const hit = out.get(r.id)
      if (hit) hit.values = r.custom_fields ?? {}
    }
  }
  return out
}

/**
 * The rows with their computed cells (`computed`), for this reader. Rows of
 * a table with no formula or rollup come back as they are.
 */
export async function attachComputed(db: SupabaseClient, ctx: ComputedContext, rows: readonly DataRow[], reader: ComputedReader): Promise<DataRow[]> {
  if (!hasComputed(ctx.columns) || !rows.length) return [...rows]
  // Per relation a rollup reads: every id the page links, one fence and one read.
  const byRelation = new Map<string, { target: RelationTarget; ids: Set<string>; fields: Set<string> }>()
  for (const [key, r] of ctx.rollups) {
    if (ctx.plan.entries.get(key)?.error) continue
    const g = byRelation.get(r.relationKey) ?? byRelation.set(r.relationKey, { target: r.target, ids: new Set(), fields: new Set() }).get(r.relationKey)!
    if (r.field) g.fields.add(r.field)
    for (const row of rows) for (const id of relationIds(own(row.custom_fields, r.relationKey)).slice(0, MAX_ROLLUP_LINKS)) g.ids.add(id)
  }
  const linked = new Map<string, Map<string, { name: string; values: Record<string, unknown> }>>()
  const failed = new Set<string>()
  await Promise.all(
    [...byRelation].map(async ([relationKey, g]) => {
      try {
        linked.set(relationKey, await readLinked(db, reader, g.target, [...g.ids], g.fields))
      } catch {
        failed.add(relationKey)
      }
    }),
  )
  const today = todayIn(reader.timeZone)
  return rows.map((row) => {
    const rollups: Record<string, ComputedCell> = {}
    for (const [key, r] of ctx.rollups) {
      const entry = ctx.plan.entries.get(key)
      if (!entry || entry.error || !entry.rollup) continue
      if (failed.has(r.relationKey)) {
        rollups[key] = { error: 'The linked records could not be read.' }
        continue
      }
      const records = linked.get(r.relationKey) ?? new Map()
      const items: LinkedValue[] = []
      for (const id of relationIds(own(row.custom_fields, r.relationKey)).slice(0, MAX_ROLLUP_LINKS)) {
        const rec = records.get(id)
        if (rec) items.push({ name: rec.name, value: r.field && r.field !== TITLE_REF ? own(rec.values, r.field) : rec.name })
      }
      const v = aggregate(entry.rollup.fn, r.fieldType, items)
      rollups[key] = { value: v === null ? null : v.v }
    }
    return { ...row, computed: computeRow(row, ctx.columns, ctx.plan, rollups, { today }) }
  })
}
