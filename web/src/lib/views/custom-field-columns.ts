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
import { DEFAULT_CURRENCY, formatFieldValue } from '@/lib/crm/custom-field-types'
import type { DisplayPropertyDefinition, FilterFieldDefinition, FilterFieldType, FilterValue, GroupedResults, ViewEntityType } from './types'

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

/** The definition fields a view needs (the GET route returns more). `config` names a relation's target. */
export type CustomFieldColumnDefinition = Pick<CustomFieldDefinition, 'key' | 'label' | 'field_type' | 'options'> &
  Partial<Pick<CustomFieldDefinition, 'config'>>

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

/**
 * Whether a view of this kind can carry custom fields: the registry's flag,
 * and a table's rows, whose columns are custom fields of their table's own.
 */
export function viewTakesCustomFields(entityType: ViewEntityType): entityType is (ViewEntityType & CustomFieldEntityType) | 'data_row' {
  return entityType === 'data_row' || isCustomFieldEntityType(entityType)
}

/**
 * How each field type filters: the built-in filter type with the same editors.
 * A multi-select is an enum over its options that holds a list (`isArray`), a
 * currency filters by its amount, a person by member ("me" too), a relation
 * by the records it links. The engine reads each by the field's own type,
 * which the query route takes from the definitions (CustomFieldTypes).
 */
const FILTER_TYPE: Record<CustomFieldType, FilterFieldType> = {
  text: 'text',
  number: 'number',
  date: 'date',
  select: 'enum',
  multi_select: 'enum',
  checkbox: 'boolean',
  url: 'text',
  email: 'text',
  phone: 'text',
  person: 'member',
  currency: 'number',
  relation: 'relation',
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
    if (d.field_type === 'select' || d.field_type === 'multi_select') field.options = [...(d.options ?? [])]
    if (d.field_type === 'multi_select') field.isArray = true
    if (d.field_type === 'currency') field.currency = d.config?.currency || DEFAULT_CURRENCY
    if (d.field_type === 'relation') {
      const target = d.config?.target
      if (!target) continue
      field.relationTarget = target.table_id ? { kind: target.kind, table_id: target.table_id } : { kind: target.kind }
    }
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
export function formatCustomFieldValue(
  fieldType: CustomFieldType | undefined,
  value: unknown,
  now: Date = new Date(),
  labels?: Record<string, string>,
): string {
  return formatFieldValue(fieldType, value, { now, labels })
}

/**
 * A board (or grouped list) by a custom select field, laid out by the field:
 * one group per option, in the definition's option order (reversed for a
 * descending grouping), the empty ones included, so a card can be dragged to
 * any option even before a record has one. A value no option holds any more
 * (an option since removed) follows the options, by label; the records with
 * no value ("No value") come last, and are there even when empty, so a card
 * can be dragged off an option. A new array; the groups are not copied.
 */
export function orderCustomSelectGroups(
  groups: readonly GroupedResults[],
  options: readonly string[],
  direction: 'asc' | 'desc' = 'asc',
): GroupedResults[] {
  const byKey = new Map(groups.map((g) => [g.key, g]))
  const ordered = direction === 'desc' ? [...options].reverse() : [...options]
  const out: GroupedResults[] = []
  const seen = new Set<string>()
  for (const option of ordered) {
    if (seen.has(option)) continue
    seen.add(option)
    out.push(byKey.get(option) ?? { key: option, label: option, items: [] })
  }
  const rest = groups.filter((g) => !seen.has(g.key) && g.key !== '__none__')
  rest.sort((a, b) => (direction === 'desc' ? b.label.localeCompare(a.label) : a.label.localeCompare(b.label)))
  out.push(...rest)
  out.push(byKey.get('__none__') ?? { key: '__none__', label: 'No value', items: [] })
  return out
}

/** A filter value as a chip or a summary reads it ("Brand, Website", "next 3 months", "…" while unset). */
export function filterValueLabel(val: FilterValue | null | undefined): string {
  if (val === '@me') return 'Me'
  if (Array.isArray(val)) return val.join(', ')
  if (val && typeof val === 'object' && 'from' in val && 'to' in val) return `${String(val.from)} – ${String(val.to)}`
  if (val && typeof val === 'object' && 'unit' in val) {
    const rel = val as { direction: string; count?: number; unit: string }
    const count = rel.count ?? 1
    return rel.direction === 'this' ? `this ${rel.unit}` : `${rel.direction === 'past' ? 'last' : 'next'} ${count} ${rel.unit}${count === 1 ? '' : 's'}`
  }
  if (typeof val === 'boolean') return val ? 'Yes' : 'No'
  if (val === '' || val === null || val === undefined) return '…'
  return String(val)
}
