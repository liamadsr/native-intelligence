/**
 * Views by custom field: a workspace's own fields (migrations 473, 496) as
 * filters, sort keys, groupings and columns in the view engine, on every kind
 * the entity registry marks `customFields`.
 *
 * A custom field is named in a view by its PATH, `custom_fields.<key>`:
 *
 *   - the same dotted path the client-side grouping already reads
 *     (getNestedValue in the query engine), so grouping by a select field
 *     needs no engine seam of its own;
 *   - a value no built-in field can take (no table has a column with a dot
 *     in its name), so a saved view can never confuse the two;
 *   - keyed by the definition's `key`, which is fixed at creation: renaming a
 *     field never orphans a saved filter, a sort or a column.
 *
 * The key is checked against the definitions' own key shape before it gets
 * anywhere near a PostgREST column string, so a hand-written filter cannot
 * smuggle an operator or a second path through it.
 *
 * Client-safe: the filter UI, the settings popover and the row cells read the
 * definitions through `useCustomFieldDefinitions` and turn them into the same
 * FilterFieldDefinition / DisplayPropertyDefinition shapes the built-in fields
 * use, so every existing picker draws them unchanged.
 */
import { isCustomFieldEntityType, type CustomFieldEntityType } from '@/lib/knowledge/entity-registry'
import type { CustomFieldDefinition, CustomFieldType } from '@/lib/crm/custom-fields'
import type { DisplayPropertyDefinition, FilterFieldDefinition, FilterFieldType, ViewEntityType } from './types'

export const CUSTOM_FIELD_PATH_PREFIX = 'custom_fields.'

/**
 * A field was defined (or changed) somewhere: every mounted view drops its
 * cached definitions and reads them again (use-custom-field-definitions
 * listens). Here, not in the hook, so the record panel's add-a-field form can
 * announce it without loading the views chrome.
 */
export const CUSTOM_FIELDS_CHANGED_EVENT = 'ni:custom-fields-changed'

export function announceCustomFieldsChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(CUSTOM_FIELDS_CHANGED_EVENT))
}

/** The definitions' key shape (custom-fields.ts KEY_RE): a slug, at most 40 characters. */
const KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

/** The definition fields a view needs (the GET route returns more). */
export type CustomFieldColumnDefinition = Pick<CustomFieldDefinition, 'key' | 'label' | 'field_type' | 'options'>

/** `contract_length` → `custom_fields.contract_length`. */
export function customFieldPath(key: string): string {
  return `${CUSTOM_FIELD_PATH_PREFIX}${key}`
}

/** Whether a view field names a custom field at all (well-formed or not). */
export function isCustomFieldPath(field: string): boolean {
  return field.startsWith(CUSTOM_FIELD_PATH_PREFIX)
}

/**
 * The key a view field names, or null when it is not a custom field path or
 * its key is not one a definition could have.
 */
export function customFieldKeyOf(field: string): string | null {
  if (!isCustomFieldPath(field)) return null
  const key = field.slice(CUSTOM_FIELD_PATH_PREFIX.length)
  return KEY_RE.test(key) ? key : null
}

/** Whether a view of this kind can carry custom fields (the registry's flag). */
export function viewTakesCustomFields(entityType: ViewEntityType): entityType is ViewEntityType & CustomFieldEntityType {
  return isCustomFieldEntityType(entityType)
}

/** How each field type filters: the built-in filter type with the same editors and operators. */
const FILTER_TYPE: Record<CustomFieldType, FilterFieldType> = {
  text: 'text',
  number: 'number',
  date: 'date',
  select: 'enum',
}

/**
 * A kind's custom fields as filter fields, in definition order. Every one is
 * `allowEmpty` (a record that never had the field set is the common case) and
 * `custom` (it lives in the record's `custom_fields`, not a column of its own).
 */
export function customFieldFilterFields(defs: readonly CustomFieldColumnDefinition[]): FilterFieldDefinition[] {
  const out: FilterFieldDefinition[] = []
  for (const d of defs) {
    if (!KEY_RE.test(d.key)) continue
    const type = FILTER_TYPE[d.field_type]
    if (!type) continue
    const field: FilterFieldDefinition = { field: customFieldPath(d.key), label: d.label, type, allowEmpty: true, custom: true }
    if (d.field_type === 'select') field.options = [...(d.options ?? [])]
    out.push(field)
  }
  return out
}

/** A kind's custom fields as display properties (columns), read-only, in definition order. */
export function customFieldDisplayProperties(defs: readonly CustomFieldColumnDefinition[]): DisplayPropertyDefinition[] {
  return defs.filter((d) => KEY_RE.test(d.key)).map((d) => ({ field: customFieldPath(d.key), label: d.label }))
}

/** The built-in filter fields followed by the custom ones (the filter chip and summaries look fields up here). */
export function withCustomFilterFields(
  builtIn: readonly FilterFieldDefinition[],
  defs: readonly CustomFieldColumnDefinition[],
): FilterFieldDefinition[] {
  return defs.length ? [...builtIn, ...customFieldFilterFields(defs)] : [...builtIn]
}

/**
 * A stored value as a cell shows it: a number with its digit grouping, a
 * date as "Mar 4" (with the year when it is not this one), the rest as typed.
 * Empty for a value that isn't there, so the cell renders nothing.
 */
export function formatCustomFieldValue(fieldType: CustomFieldType | undefined, value: unknown, now: Date = new Date()): string {
  if (value === null || value === undefined || value === '') return ''
  if (typeof value === 'object') return ''
  if (fieldType === 'number' && typeof value === 'number') return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
  if (fieldType === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number)
    const day = new Date(y, m - 1, d)
    return day.toLocaleDateString('en-US', y === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return String(value)
}
