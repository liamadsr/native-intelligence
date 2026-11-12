/**
 * Custom fields (roadmap #8, migration 473; every kind, migration 496): a
 * workspace's own fields on the kinds the entity registry marks
 * `customFields` (deals, contacts, companies, tasks, projects, initiatives,
 * documents). A definition says what the field is called and what it holds
 * (the types, and how each is stored, are ./custom-field-types.ts); the
 * values live in each record's `custom_fields` jsonb, keyed by the
 * definition's `key` (a slug of its label, fixed at creation so a rename
 * never orphans a value).
 *
 * Client-safe apart from the db helpers' `SupabaseClient` type import.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  cleanFieldConfig,
  coerceCustomValue,
  hasOptions,
  isEmptyValue,
  type CustomFieldConfig,
  type CustomFieldType,
  type CustomFieldValue,
} from './custom-field-types'
import {
  CUSTOM_FIELD_ENTITY_TYPES,
  ENTITY_REGISTRY_BY_ID,
  isCustomFieldEntityType,
  type CustomFieldEntityType,
} from '@/lib/knowledge/entity-registry'

/** The kinds that take custom fields: the registry's `customFields` flag, never a hand list. */
export const CUSTOM_FIELD_ENTITIES = CUSTOM_FIELD_ENTITY_TYPES
export type CustomFieldEntity = CustomFieldEntityType
export const isCustomFieldEntity = isCustomFieldEntityType

/**
 * What people call each kind, one and many ("task", "tasks"). A Record over
 * the flag's kinds: a kind that gains the flag without a name here does not
 * compile.
 */
export const CUSTOM_FIELD_KIND_NOUNS: Readonly<Record<CustomFieldEntity, { one: string; many: string }>> = {
  document: { one: 'document', many: 'documents' },
  contact: { one: 'contact', many: 'contacts' },
  project: { one: 'project', many: 'projects' },
  action: { one: 'task', many: 'tasks' },
  initiative: { one: 'initiative', many: 'initiatives' },
  company: { one: 'company', many: 'companies' },
  deal: { one: 'deal', many: 'deals' },
}

/** "deals, contacts, companies, tasks, projects, initiatives and documents", in registry order. */
export function customFieldKindList(form: 'one' | 'many' = 'many', joiner = 'and'): string {
  const words = CUSTOM_FIELD_ENTITIES.map((k) => CUSTOM_FIELD_KIND_NOUNS[k][form])
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} ${joiner} ${words[words.length - 1]}` : words.join('')
}

/** The table a kind's values live on (the registry's own). */
export function customFieldTable(entity: CustomFieldEntity): string {
  return ENTITY_REGISTRY_BY_ID[entity].table
}

export {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABELS,
  RELATION_TARGET_KINDS,
  coerceCustomValue,
  cleanFieldConfig,
  formatFieldValue,
  hasOptions,
  isCustomFieldType,
  isIsoDate,
  isRelationTargetKind,
  type CurrencyValue,
  type CustomFieldConfig,
  type CustomFieldType,
  type CustomFieldValue,
  type RelationTarget,
  type RelationTargetKind,
  type RequiredWhen,
} from './custom-field-types'

export interface CustomFieldDefinition {
  id: string
  workspace_id: string
  entity_type: CustomFieldEntity
  key: string
  label: string
  field_type: CustomFieldType
  options: string[]
  /** What the type needs past its options (custom-field-types.ts CustomFieldConfig). */
  config: CustomFieldConfig
  position: number
}

const MAX_OPTIONS = 50
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

/** "Contract length (months)" → "contract_length_months". Empty when nothing usable is left. */
export function customFieldKey(label: string): string {
  let key = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '')
  if (key && !/^[a-z]/.test(key)) key = `f_${key}`.slice(0, 40)
  return KEY_RE.test(key) ? key : ''
}

/** A definition's options, trimmed, de-duplicated (case-insensitively), capped. */
export function cleanOptions(options: readonly string[] | undefined): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of options ?? []) {
    const o = String(raw).trim().slice(0, 60)
    if (!o || seen.has(o.toLowerCase())) continue
    seen.add(o.toLowerCase())
    out.push(o)
    if (out.length >= MAX_OPTIONS) break
  }
  return out
}

/**
 * Finds a definition by key or label (case-insensitive), the way the agent
 * names one ("Contract length" or "contract_length").
 */
export function findDefinition(defs: readonly CustomFieldDefinition[], name: string): CustomFieldDefinition | null {
  const n = name.trim().toLowerCase()
  return defs.find((d) => d.key === n) ?? defs.find((d) => d.label.toLowerCase() === n) ?? defs.find((d) => d.key === customFieldKey(name)) ?? null
}

/**
 * Checks a batch of named values against the definitions: the jsonb patch to
 * merge (keys → stored values, null clears), or the first problem.
 */
export function resolveCustomValues(
  defs: readonly CustomFieldDefinition[],
  values: Record<string, unknown>,
): { ok: true; patch: Record<string, CustomFieldValue> } | { ok: false; error: string } {
  const patch: Record<string, CustomFieldValue> = {}
  for (const [name, raw] of Object.entries(values)) {
    const def = findDefinition(defs, name)
    if (!def) {
      const known = defs.map((d) => d.label).join(', ')
      return { ok: false, error: `No custom field called "${name}".${known ? ` Fields: ${known}.` : ' Define it first with define_custom_field.'}` }
    }
    const coerced = coerceCustomValue(def, raw)
    if (!coerced.ok) return coerced
    patch[def.key] = coerced.value
  }
  return { ok: true, patch }
}

/** Merges a patch into a record's custom_fields: null removes the key. */
export function mergeCustomFields(current: unknown, patch: Record<string, CustomFieldValue>): Record<string, CustomFieldValue> {
  const base: Record<string, CustomFieldValue> =
    current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Record<string, CustomFieldValue>) } : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key]
    else base[key] = value
  }
  return base
}

// ── Database ────────────────────────────────────────────────────────────────

const DEF_SELECT = 'id, workspace_id, entity_type, key, label, field_type, options, config, position'

export async function listCustomFieldDefinitions(
  db: SupabaseClient,
  workspaceId: string,
  entityType?: CustomFieldEntity,
): Promise<CustomFieldDefinition[]> {
  let q = db.from('custom_field_definition').select(DEF_SELECT).eq('workspace_id', workspaceId)
  if (entityType) q = q.eq('entity_type', entityType)
  const { data, error } = await q.order('position', { ascending: true }).order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  // A table's columns share this table (entity_type 'data_row', migration 520)
  // but are the table's own (src/lib/tables): never a workspace's field.
  return ((data ?? []) as CustomFieldDefinition[])
    .filter((d) => isCustomFieldEntity(d.entity_type))
    .map((d) => ({ ...d, options: d.options ?? [], config: d.config ?? {} }))
}

export interface DefineCustomFieldInput {
  entity_type: CustomFieldEntity
  label: string
  field_type: CustomFieldType
  options?: string[]
  /** A currency's default code, a relation's target and whether it takes several. */
  config?: CustomFieldConfig
}

/**
 * Adds a field to every record of one kind in a workspace. A field of the
 * same name already there is returned as it is (`existed`), never duplicated.
 */
export async function defineCustomField(
  db: SupabaseClient,
  workspaceId: string,
  input: DefineCustomFieldInput,
): Promise<{ ok: true; field: CustomFieldDefinition; existed: boolean } | { ok: false; error: string }> {
  const label = input.label.trim().slice(0, 60)
  const key = customFieldKey(label)
  if (!label || !key) return { ok: false, error: 'A field needs a name with a letter or number in it.' }
  const options = cleanOptions(input.options)
  if (hasOptions(input.field_type) && options.length < 2) return { ok: false, error: 'A select field needs at least two options.' }
  const config = cleanFieldConfig(input.field_type, input.config)
  if (!config.ok) return config

  const existing = await listCustomFieldDefinitions(db, workspaceId, input.entity_type)
  const same = existing.find((d) => d.key === key)
  if (same) return { ok: true, field: same, existed: true }

  const { data, error } = await db
    .from('custom_field_definition')
    .insert({
      workspace_id: workspaceId,
      entity_type: input.entity_type,
      key,
      label,
      field_type: input.field_type,
      options: hasOptions(input.field_type) ? options : [],
      config: config.config,
      position: existing.length,
    })
    .select(DEF_SELECT)
    .single()
  if (error) return { ok: false, error: error.message }
  const field = data as CustomFieldDefinition
  return { ok: true, field: { ...field, options: field.options ?? [], config: field.config ?? {} }, existed: false }
}

export interface FieldTypeChange {
  /** The change's id: what undoCustomFieldChange takes back. */
  change_id: string
  /** How many records' values were converted. */
  converted: number
  field: CustomFieldDefinition
}

export type FieldTypeChangeResult = { ok: true; value: FieldTypeChange } | { ok: false; error: string; reason: 'invalid' | 'not_found' | 'forbidden' }

type RpcError = { code?: string; message: string }

function fieldRpcRefusal(error: RpcError): { ok: false; error: string; reason: 'invalid' | 'not_found' | 'forbidden' } {
  const message = error.message ? error.message.charAt(0).toUpperCase() + error.message.slice(1) : 'Could not change the field'
  if (error.code === 'P0002') return { ok: false, error: 'Field not found', reason: 'not_found' }
  if (error.code === '42501') return { ok: false, error: message, reason: 'forbidden' }
  return { ok: false, error: message, reason: 'invalid' }
}

async function readDefinition(db: SupabaseClient, workspaceId: string, id: string): Promise<CustomFieldDefinition | null> {
  const { data } = await db.from('custom_field_definition').select(DEF_SELECT).eq('workspace_id', workspaceId).eq('id', id).is('table_id', null).maybeSingle()
  if (!data) return null
  const d = data as CustomFieldDefinition
  return { ...d, options: d.options ?? [], config: d.config ?? {} }
}

/**
 * Changes a kind's field to another type (migration 526): every record's
 * value converts by the database's one cast rule, or nothing changes and the
 * answer says how many don't fit and shows a few. A select type given no
 * options takes the values' own. Undoable (undoCustomFieldChange).
 * `asUserId`: the person a service-role caller acts for.
 */
export async function changeCustomFieldType(
  db: SupabaseClient,
  workspaceId: string,
  input: { id: string; field_type: CustomFieldType; options?: string[]; config?: CustomFieldConfig },
  opts: { asUserId?: string | null } = {},
): Promise<FieldTypeChangeResult> {
  const current = await readDefinition(db, workspaceId, input.id)
  if (!current) return { ok: false, error: 'Field not found', reason: 'not_found' }
  const config = cleanFieldConfig(input.field_type, input.config ?? (input.field_type === current.field_type ? current.config : {}))
  if (!config.ok) return { ...config, reason: 'invalid' }
  const options = hasOptions(input.field_type) ? cleanOptions(input.options ?? (hasOptions(current.field_type) ? current.options : [])) : []
  const { data, error } = await db.rpc('change_custom_field_type', {
    p_definition_id: input.id,
    p_field_type: input.field_type,
    p_options: options,
    p_config: config.config,
    p_as_user: opts.asUserId ?? null,
  })
  if (error) return fieldRpcRefusal(error as RpcError)
  const field = await readDefinition(db, workspaceId, input.id)
  if (!field) return { ok: false, error: 'Field not found', reason: 'not_found' }
  const r = (data ?? {}) as { change_id?: string; converted?: number }
  return { ok: true, value: { change_id: String(r.change_id ?? ''), converted: Number(r.converted ?? 0), field } }
}

/** Takes a type change back: the old type, and each value as it was unless it has changed since (then converted back). */
export async function undoCustomFieldChange(
  db: SupabaseClient,
  workspaceId: string,
  changeId: string,
  opts: { asUserId?: string | null } = {},
): Promise<FieldTypeChangeResult> {
  const { data, error } = await db.rpc('undo_custom_field_change', { p_change_id: changeId, p_as_user: opts.asUserId ?? null })
  if (error) return fieldRpcRefusal(error as RpcError)
  const r = (data ?? {}) as { change_id?: string; converted?: number; definition_id?: string }
  const field = r.definition_id ? await readDefinition(db, workspaceId, r.definition_id) : null
  if (!field) return { ok: false, error: 'Field not found', reason: 'not_found' }
  return { ok: true, value: { change_id: String(r.change_id ?? ''), converted: Number(r.converted ?? 0), field } }
}

/** A kind whose values are set here (a deal's go through updateDeal, which logs them for undo). */
export type CustomFieldRecordEntity = Exclude<CustomFieldEntity, 'deal'>

/**
 * The checks a value write needs the database for (./custom-field-references.ts
 * fieldReferenceCheck): a person is a member, a linked record is one the
 * writer can read. Null when the patch passes; else why not, in words.
 */
export type ReferenceCheck = (
  defs: readonly Pick<CustomFieldDefinition, 'key' | 'label' | 'field_type' | 'config'>[],
  patch: Record<string, CustomFieldValue>,
  current: unknown,
) => Promise<string | null>

/** Why a set was refused: a value that doesn't fit, a record not there, or one the caller may only read. */
export type SetCustomFieldsRefusal = 'invalid' | 'not_found' | 'forbidden'

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** "Task not found", in the kind's own word. */
export const customFieldNotFound = (entity: CustomFieldEntity) => `${capitalize(CUSTOM_FIELD_KIND_NOUNS[entity].one)} not found`
/** "You can't edit this task", in the kind's own word. */
export const customFieldForbidden = (entity: CustomFieldEntity) => `You can't edit this ${CUSTOM_FIELD_KIND_NOUNS[entity].one}`

/**
 * Sets custom field values on any record but a deal: checked against the
 * kind's definitions, merged into its `custom_fields`, written to the kind's
 * own table. Returns the merged values.
 *
 * On a session client RLS decides who may write: the update reads back the
 * row it changed, so a row the caller sees but may not change (an initiative
 * that isn't theirs, a document shared to them for viewing only) is
 * `forbidden`, never a silent no-op. A service-role caller must check edit
 * rights first (src/lib/crm/custom-field-access.ts).
 */
export async function setRecordCustomFields(
  db: SupabaseClient,
  workspaceId: string,
  entityType: CustomFieldRecordEntity,
  recordId: string,
  values: Record<string, unknown>,
  opts: { checkReferences?: ReferenceCheck } = {},
): Promise<{ ok: true; custom_fields: Record<string, CustomFieldValue> } | { ok: false; error: string; reason: SetCustomFieldsRefusal }> {
  const defs = await listCustomFieldDefinitions(db, workspaceId, entityType)
  const resolved = resolveCustomValues(defs, values)
  if (!resolved.ok) return { ...resolved, reason: 'invalid' }
  const table = customFieldTable(entityType)
  const { data: row, error: readError } = await db
    .from(table)
    .select('id, custom_fields')
    .eq('id', recordId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (readError) return { ok: false, error: readError.message, reason: 'invalid' }
  if (!row) return { ok: false, error: customFieldNotFound(entityType), reason: 'not_found' }
  const current = (row as { custom_fields?: unknown }).custom_fields
  if (opts.checkReferences) {
    const problem = await opts.checkReferences(defs, resolved.patch, current)
    if (problem) return { ok: false, error: problem, reason: 'invalid' }
  }
  const merged = mergeCustomFields(current, resolved.patch)
  const { data: written, error } = await db
    .from(table)
    .update({ custom_fields: merged })
    .eq('id', recordId)
    .eq('workspace_id', workspaceId)
    .select('id')
  if (error) {
    // 42501: a policy or guard refused the write outright.
    if ((error as { code?: string }).code === '42501') return { ok: false, error: customFieldForbidden(entityType), reason: 'forbidden' }
    return { ok: false, error: error.message, reason: 'invalid' }
  }
  if (!written || (Array.isArray(written) && written.length === 0)) {
    return { ok: false, error: customFieldForbidden(entityType), reason: 'forbidden' }
  }
  return { ok: true, custom_fields: merged }
}

/**
 * A record's custom values as the agent's read tools return them: the SET
 * ones only, keyed by the field's label, in definition order
 * ({ "Contract length": 12, "Region": "West" }), the names set_custom_fields
 * takes. A stored key with no definition (a field since removed) is left
 * out, as the panels leave it out.
 */
export function customFieldsForModel(
  defs: readonly CustomFieldDefinition[],
  values: unknown,
): Record<string, CustomFieldValue> {
  const v = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, unknown>) : {}
  const out: Record<string, CustomFieldValue> = {}
  for (const d of defs) {
    const value = v[d.key]
    if (isEmptyValue(value)) continue
    out[d.label] = value as CustomFieldValue
  }
  return out
}

/** `{ custom_fields }` for a read tool's row when any value is set, else nothing (an empty widget shows nothing). */
export function withCustomFields(
  defs: readonly CustomFieldDefinition[],
  values: unknown,
): { custom_fields?: Record<string, CustomFieldValue> } {
  if (defs.length === 0) return {}
  const fields = customFieldsForModel(defs, values)
  return Object.keys(fields).length > 0 ? { custom_fields: fields } : {}
}

/**
 * The kind's field definitions in a workspace for a READ tool, or none when
 * the read fails: the record still comes back, without its fields, rather
 * than the whole read failing. One query, whatever the number of records.
 */
export async function customFieldDefsOrNone(
  db: SupabaseClient,
  workspaceId: string,
  entityType: CustomFieldEntity,
): Promise<CustomFieldDefinition[]> {
  try {
    return await listCustomFieldDefinitions(db, workspaceId, entityType)
  } catch (err) {
    console.warn('[custom-fields] definitions read failed:', err instanceof Error ? err.message : 'unknown')
    return []
  }
}

/**
 * One record's `{ custom_fields }` for a read tool that did not select the
 * column itself (the CRM overviews read through shared context helpers):
 * the definitions and the record's values, two reads in parallel. Nothing
 * when none is set or a read fails. Call it only for a record the caller has
 * already been shown (it re-checks the workspace, not visibility).
 */
export async function recordCustomFieldsForModel(
  db: SupabaseClient,
  workspaceId: string,
  entityType: CustomFieldRecordEntity,
  recordId: string,
): Promise<{ custom_fields?: Record<string, CustomFieldValue> }> {
  const [defs, row] = await Promise.all([
    customFieldDefsOrNone(db, workspaceId, entityType),
    Promise.resolve(
      db.from(customFieldTable(entityType)).select('custom_fields').eq('id', recordId).eq('workspace_id', workspaceId).maybeSingle(),
    ).then(
      (res) => (res.error ? null : (res.data as { custom_fields?: unknown } | null)),
      () => null,
    ),
  ])
  return withCustomFields(defs, row?.custom_fields)
}

/** A record's custom values as "Label: value" pairs, in definition order (for the model and the panels). */
export function describeCustomFields(
  defs: readonly CustomFieldDefinition[],
  values: unknown,
): Array<{ key: string; label: string; field_type: CustomFieldType; value: CustomFieldValue }> {
  const v = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, CustomFieldValue>) : {}
  return defs.map((d) => ({ key: d.key, label: d.label, field_type: d.field_type, value: v[d.key] ?? null }))
}
