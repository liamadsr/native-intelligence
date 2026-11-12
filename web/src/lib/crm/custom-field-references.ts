/**
 * The custom field checks that need the database (Tables, phase 2): a person
 * field names a member of the workspace, and a relation links only records
 * the WRITER can read, in the workspace, of the field's target kind (a
 * table's rows: rows of that table). Only what a write ADDS is checked: an
 * id already on the record was checked when it came, and may be one this
 * writer can't see (a teammate linked their private document).
 *
 * The database checks the same on every write (migration 524's
 * custom_field_links_sync, for the signed-in writer or the user a table write
 * names), so this is the friendly half for the session routes and the one
 * the agent's service-role writes rely on.
 *
 * Also here: the names a person or a relation value shows as, read through
 * the viewer's own client (a record they can't read has no name to show).
 *
 * SERVER ONLY.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyCaptureVisibility, applyDocumentVisibility, documentRequesterMember } from '@/lib/ai/tools/_shared'
import { filterVisibleCompanies, filterVisibleContacts } from '@/lib/crm/contact-visibility'
import { withGrantedIds } from '@/lib/entity-access/grants'
import { visiblePrivateKindIds } from '@/lib/knowledge/entity-fences'
import { WORKSPACE_SCOPED_TABLE } from '@/lib/knowledge/entity-registry'
import { resolveEntityLabels } from '@/lib/knowledge/graph-map/source'
import type { CustomFieldDefinition, ReferenceCheck } from './custom-fields'
import { referencedIds, relationIds, type CustomFieldType, type RelationTarget } from './custom-field-types'

type Def = Pick<CustomFieldDefinition, 'key' | 'label' | 'field_type' | 'config'>

export interface ReferenceScope {
  workspaceId: string
  /** The writer: whose reads fence a relation (null: only what every member reads). */
  userId: string | null
  /** false on a guest's or a linked agent's turn: a grant opens nothing (entity-fences GrantOpts). */
  grants?: boolean
}

/**
 * The ids among `ids` of `target` that the writer may link: in the workspace
 * and readable by them. Fails closed (a read error links nothing).
 */
export async function visibleRelationTargets(
  db: SupabaseClient,
  scope: ReferenceScope,
  target: RelationTarget,
  ids: readonly string[],
): Promise<Set<string>> {
  if (!ids.length) return new Set()
  const { workspaceId, userId } = scope
  const grantOpts = scope.grants === false ? { grants: false } : {}
  try {
    if (target.kind === 'data_row') {
      // A table's rows: of that table, and the table readable by the writer.
      const { data, error } = await db.from('data_row').select('id').eq('workspace_id', workspaceId).eq('table_id', target.table_id ?? '').in('id', [...ids])
      if (error) return new Set()
      const inTable = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
      return inTable.length ? visiblePrivateKindIds(db, 'data_row', userId, inTable, workspaceId, grantOpts) : new Set()
    }
    const table = WORKSPACE_SCOPED_TABLE[target.kind]
    if (!table) return new Set()
    let query = db.from(table).select('id').eq('workspace_id', workspaceId).in('id', [...ids])
    if (target.kind === 'capture') query = applyCaptureVisibility(query, userId)
    if (target.kind === 'document') query = applyDocumentVisibility(query, userId ? await documentRequesterMember(db, userId, workspaceId) : null)
    const { data, error } = await query
    if (error) return new Set()
    const rows = ((data ?? []) as Array<{ id?: unknown }>).filter((r): r is { id: string } => typeof r.id === 'string')
    if (target.kind === 'contact') return new Set(userId ? (await filterVisibleContacts(db, userId, rows, grantOpts)).map((r) => r.id) : [])
    if (target.kind === 'company') return new Set(userId ? (await filterVisibleCompanies(db, userId, rows, grantOpts)).map((r) => r.id) : [])
    if ((target.kind === 'capture' || target.kind === 'document') && scope.grants !== false) {
      return withGrantedIds(db, { userId, workspaceId }, target.kind, ids, rows.map((r) => r.id))
    }
    return new Set(rows.map((r) => r.id))
  } catch (err) {
    console.warn('[custom-fields] relation fence threw:', target.kind, err instanceof Error ? err.message : 'unknown')
    return new Set()
  }
}

/** The ids `next` names that `before` did not. */
function added(fieldType: CustomFieldType, before: unknown, next: unknown): string[] {
  const had = new Set(referencedIds(fieldType, before))
  return referencedIds(fieldType, next).filter((id) => !had.has(id))
}

/**
 * The reference check a value write runs before it writes (setRecordCustomFields'
 * `checkReferences`, a deal's update, a table's batch): null when every person
 * is a member and every newly linked record is the writer's to link.
 */
export function fieldReferenceCheck(db: SupabaseClient, scope: ReferenceScope): ReferenceCheck {
  return async (defs, patch, current) => {
    const values = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {}
    return referenceProblem(db, scope, defs, [{ before: values, after: patch }])
  }
}

/**
 * The first reference problem across several records' writes (a table batch
 * writes many rows): `after` holds only the keys written. One read per kind.
 */
export async function referenceProblem(
  db: SupabaseClient,
  scope: ReferenceScope,
  defs: readonly Def[],
  writes: ReadonlyArray<{ before: Record<string, unknown>; after: Record<string, unknown>; self?: string }>,
): Promise<string | null> {
  const people = new Map<string, Def>()
  const linked = new Map<Def, Set<string>>()
  for (const w of writes) {
    for (const [key, value] of Object.entries(w.after)) {
      const def = defs.find((d) => d.key === key)
      if (!def || (def.field_type !== 'person' && def.field_type !== 'relation')) continue
      const fresh = added(def.field_type, w.before[key], value)
      if (def.field_type === 'person') for (const id of fresh) people.set(id, def)
      else {
        if (w.self && fresh.includes(w.self)) return `${def.label} can't link a record to itself.`
        const set = linked.get(def) ?? linked.set(def, new Set()).get(def)!
        for (const id of fresh) set.add(id)
      }
    }
  }
  if (people.size) {
    const { data, error } = await db.from('member').select('id').eq('workspace_id', scope.workspaceId).in('id', [...people.keys()])
    if (error) return 'Could not check the people named.'
    const found = new Set(((data ?? []) as Array<{ id: string }>).map((m) => m.id))
    for (const [id, def] of people) if (!found.has(id)) return `${def.label} takes a member of this workspace.`
  }
  for (const [def, ids] of linked) {
    const target = def.config?.target
    if (!target) return `${def.label} has no target to link to.`
    const ok = await visibleRelationTargets(db, scope, target, [...ids])
    if ([...ids].some((id) => !ok.has(id))) return `${def.label} links a record that isn't one you can link to.`
  }
  return null
}

/**
 * The names the person and relation values among `records` show as, by id,
 * read through `db` (the viewer's client: a record they can't read stays
 * nameless). One read for the members, one per linked kind.
 */
export async function fieldValueLabels(
  db: SupabaseClient,
  workspaceId: string,
  defs: readonly Def[],
  records: ReadonlyArray<Record<string, unknown> | null | undefined>,
): Promise<Record<string, string>> {
  const members = new Set<string>()
  const byType = new Map<string, Set<string>>()
  for (const values of records) {
    if (!values) continue
    for (const def of defs) {
      if (def.field_type === 'person') for (const id of referencedIds('person', values[def.key])) members.add(id)
      if (def.field_type === 'relation' && def.config?.target) {
        const ids = relationIds(values[def.key])
        if (ids.length) {
          const set = byType.get(def.config.target.kind) ?? byType.set(def.config.target.kind, new Set()).get(def.config.target.kind)!
          for (const id of ids) set.add(id)
        }
      }
    }
  }
  const out: Record<string, string> = {}
  const [memberRows, linked] = await Promise.all([
    members.size
      ? Promise.resolve(db.from('member').select('id, display_name').eq('workspace_id', workspaceId).in('id', [...members])).then(
          (res) => (res.error ? [] : ((res.data ?? []) as Array<{ id: string; display_name: string | null }>)),
          () => [],
        )
      : Promise.resolve([] as Array<{ id: string; display_name: string | null }>),
    byType.size ? resolveEntityLabels(db, workspaceId, byType).catch(() => new Map<string, string>()) : Promise.resolve(new Map<string, string>()),
  ])
  for (const m of memberRows) out[m.id] = m.display_name?.trim() || 'Member'
  for (const [key, label] of linked) {
    const id = key.slice(key.indexOf(':') + 1)
    out[id] = label || 'Untitled'
  }
  return out
}
