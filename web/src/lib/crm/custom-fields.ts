/**
 * Custom fields (roadmap #8, migration 473): a workspace's own fields on
 * deals, contacts and companies. A definition says what the field is called
 * and what it holds (text, number, date or one of a few options); the values
 * live in each record's `custom_fields` jsonb, keyed by the definition's
 * `key` (a slug of its label, fixed at creation so a rename never orphans a
 * value).
 *
 * Client-safe apart from the db helpers' `SupabaseClient` type import.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

export const CUSTOM_FIELD_ENTITIES = ['deal', 'contact', 'company'] as const
export type CustomFieldEntity = (typeof CUSTOM_FIELD_ENTITIES)[number]

export const CUSTOM_FIELD_TYPES = ['text', 'number', 'date', 'select'] as const
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

export interface CustomFieldDefinition {
  id: string
  workspace_id: string
  entity_type: CustomFieldEntity
  key: string
  label: string
  field_type: CustomFieldType
  options: string[]
  position: number
}

export type CustomFieldValue = string | number | null

const MAX_TEXT = 2000
const MAX_OPTIONS = 50
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** "Contract length (months)" → "contract_length_months". Empty when nothing usable is left. */
export function customFieldKey(label: string): string {
  let key = label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
    .replace(/_+$/g, '')
  if (key && !/^[a-z]/.test(key)) key = `f_${key}`.slice(0, 40)
  return KEY_RE.test(key) ? key : ''
}

/** A valid calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

/**
 * A raw value checked against its definition: the stored form, or why not.
 * `null` and '' clear the field. A select takes its option case-insensitively
 * and stores the option's own spelling.
 */
export function coerceCustomValue(
  def: Pick<CustomFieldDefinition, 'label' | 'field_type' | 'options'>,
  raw: unknown,
): { ok: true; value: CustomFieldValue } | { ok: false; error: string } {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
  switch (def.field_type) {
    case 'text': {
      const text = String(raw).trim()
      if (text.length > MAX_TEXT) return { ok: false, error: `${def.label} is longer than ${MAX_TEXT} characters` }
      return { ok: true, value: text || null }
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, ''))
      if (!Number.isFinite(n)) return { ok: false, error: `${def.label} needs a number` }
      return { ok: true, value: n }
    }
    case 'date': {
      const text = String(raw).trim()
      if (!isIsoDate(text)) return { ok: false, error: `${def.label} needs a date as YYYY-MM-DD` }
      return { ok: true, value: text }
    }
    case 'select': {
      const text = String(raw).trim().toLowerCase()
      const match = def.options.find((o) => o.toLowerCase() === text)
      if (!match) return { ok: false, error: `${def.label} is one of: ${def.options.join(', ')}` }
      return { ok: true, value: match }
    }
  }
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

const DEF_SELECT = 'id, workspace_id, entity_type, key, label, field_type, options, position'

export async function listCustomFieldDefinitions(
  db: SupabaseClient,
  workspaceId: string,
  entityType?: CustomFieldEntity,
): Promise<CustomFieldDefinition[]> {
  let q = db.from('custom_field_definition').select(DEF_SELECT).eq('workspace_id', workspaceId)
  if (entityType) q = q.eq('entity_type', entityType)
  const { data, error } = await q.order('position', { ascending: true }).order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data ?? []) as CustomFieldDefinition[]
}

export interface DefineCustomFieldInput {
  entity_type: CustomFieldEntity
  label: string
  field_type: CustomFieldType
  options?: string[]
}

/**
 * Adds a field to a workspace's deals, contacts or companies. A field of the
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
  if (input.field_type === 'select' && options.length < 2) return { ok: false, error: 'A select field needs at least two options.' }

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
      options: input.field_type === 'select' ? options : [],
      position: existing.length,
    })
    .select(DEF_SELECT)
    .single()
  if (error) return { ok: false, error: error.message }
  return { ok: true, field: data as CustomFieldDefinition, existed: false }
}

/**
 * Sets custom field values on a contact or company (a deal's go through
 * updateDeal, which logs them for undo). Returns the merged values.
 */
export async function setRecordCustomFields(
  db: SupabaseClient,
  workspaceId: string,
  entityType: 'contact' | 'company',
  recordId: string,
  values: Record<string, unknown>,
): Promise<{ ok: true; custom_fields: Record<string, CustomFieldValue> } | { ok: false; error: string }> {
  const defs = await listCustomFieldDefinitions(db, workspaceId, entityType)
  const resolved = resolveCustomValues(defs, values)
  if (!resolved.ok) return resolved
  const { data: row, error: readError } = await db
    .from(entityType)
    .select('id, custom_fields')
    .eq('id', recordId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (readError) return { ok: false, error: readError.message }
  if (!row) return { ok: false, error: `${entityType === 'contact' ? 'Contact' : 'Company'} not found` }
  const merged = mergeCustomFields((row as { custom_fields?: unknown }).custom_fields, resolved.patch)
  const { error } = await db.from(entityType).update({ custom_fields: merged }).eq('id', recordId).eq('workspace_id', workspaceId)
  if (error) return { ok: false, error: error.message }
  return { ok: true, custom_fields: merged }
}

/** A record's custom values as "Label: value" pairs, in definition order (for the model and the panels). */
export function describeCustomFields(
  defs: readonly CustomFieldDefinition[],
  values: unknown,
): Array<{ key: string; label: string; field_type: CustomFieldType; value: CustomFieldValue }> {
  const v = values && typeof values === 'object' && !Array.isArray(values) ? (values as Record<string, CustomFieldValue>) : {}
  return defs.map((d) => ({ key: d.key, label: d.label, field_type: d.field_type, value: v[d.key] ?? null }))
}
