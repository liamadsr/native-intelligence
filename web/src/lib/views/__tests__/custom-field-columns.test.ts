/**
 * The custom field ↔ view vocabulary: the `custom_fields.<key>` path, which
 * kinds take it (the registry's flag, nothing else), and how a definition
 * becomes a filter field and a column.
 */
import { describe, it, expect } from 'vitest'
import {
  customFieldDisplayProperties,
  customFieldFilterFields,
  customFieldKeyOf,
  customFieldPath,
  filterValueLabel,
  formatCustomFieldValue,
  orderCustomSelectGroups,
  isCustomFieldPath,
  viewTakesCustomFields,
  withCustomFilterFields,
  type CustomFieldColumnDefinition,
} from '@/lib/views/custom-field-columns'
import { CUSTOM_FIELD_ENTITY_TYPES } from '@/lib/knowledge/entity-registry'
import { FILTERABLE_FIELDS, OPERATORS_BY_TYPE, type ViewEntityType } from '@/lib/views/types'

const DEFS: CustomFieldColumnDefinition[] = [
  { key: 'project_type', label: 'Project type', field_type: 'select', options: ['Brand', 'Website', 'Packaging'] },
  { key: 'retainer_months', label: 'Retainer (months)', field_type: 'number', options: [] },
  { key: 'renewal_date', label: 'Renewal date', field_type: 'date', options: [] },
  { key: 'referral_source', label: 'Referral source', field_type: 'text', options: [] },
]

describe('the custom field path', () => {
  it('round-trips a key', () => {
    expect(customFieldPath('project_type')).toBe('custom_fields.project_type')
    expect(customFieldKeyOf('custom_fields.project_type')).toBe('project_type')
    expect(isCustomFieldPath('custom_fields.project_type')).toBe(true)
  })

  it('is not a built-in field', () => {
    for (const fields of Object.values(FILTERABLE_FIELDS)) {
      for (const f of fields) expect(isCustomFieldPath(f.field)).toBe(false)
    }
    expect(customFieldKeyOf('status')).toBeNull()
  })

  it('only takes a key a definition could have', () => {
    for (const bad of ['custom_fields.', 'custom_fields.Tier', 'custom_fields.a->>b', 'custom_fields.a,b', 'custom_fields.a.b', 'custom_fields._a', `custom_fields.${'a'.repeat(41)}`]) {
      expect(customFieldKeyOf(bad)).toBeNull()
    }
  })
})

describe('which views take custom fields', () => {
  it('is exactly the registry flag, and every such kind is a view', () => {
    for (const kind of CUSTOM_FIELD_ENTITY_TYPES) {
      expect(viewTakesCustomFields(kind as ViewEntityType)).toBe(true)
      expect(FILTERABLE_FIELDS[kind as ViewEntityType]).toBeDefined()
    }
    const others = (Object.keys(FILTERABLE_FIELDS) as ViewEntityType[]).filter(
      (k) => !(CUSTOM_FIELD_ENTITY_TYPES as readonly string[]).includes(k) && k !== 'data_row',
    )
    for (const kind of others) expect(viewTakesCustomFields(kind)).toBe(false)
    // A table's rows: their columns are their table's own fields.
    expect(viewTakesCustomFields('data_row')).toBe(true)
    expect(viewTakesCustomFields('company')).toBe(true)
    expect(viewTakesCustomFields('action')).toBe(true)
  })
})

describe('definitions as filter fields', () => {
  it('maps each type to the built-in type with the same editors', () => {
    const fields = customFieldFilterFields(DEFS)
    expect(fields).toEqual([
      { field: 'custom_fields.project_type', label: 'Project type', type: 'enum', options: ['Brand', 'Website', 'Packaging'], allowEmpty: true, custom: true },
      { field: 'custom_fields.retainer_months', label: 'Retainer (months)', type: 'number', allowEmpty: true, custom: true },
      { field: 'custom_fields.renewal_date', label: 'Renewal date', type: 'date', allowEmpty: true, custom: true },
      { field: 'custom_fields.referral_source', label: 'Referral source', type: 'text', allowEmpty: true, custom: true },
    ])
    // Every one offers "is empty", the common case for a field nobody filled in.
    for (const f of fields.filter((f) => f.type !== 'enum')) expect(OPERATORS_BY_TYPE[f.type]).toContain('is_empty')
  })

  it('skips a definition whose key could not be a path', () => {
    expect(customFieldFilterFields([{ key: 'Bad Key', label: 'Bad', field_type: 'text', options: [] }])).toEqual([])
  })

  it('appends to the built-in fields, and adds nothing when there are none', () => {
    expect(withCustomFilterFields(FILTERABLE_FIELDS.company, [])).toEqual(FILTERABLE_FIELDS.company)
    const all = withCustomFilterFields(FILTERABLE_FIELDS.company, DEFS)
    expect(all.slice(0, FILTERABLE_FIELDS.company.length)).toEqual(FILTERABLE_FIELDS.company)
    expect(all.length).toBe(FILTERABLE_FIELDS.company.length + DEFS.length)
  })

  it('definitions as columns, in definition order', () => {
    expect(customFieldDisplayProperties(DEFS).map((p) => [p.field, p.label])).toEqual([
      ['custom_fields.project_type', 'Project type'],
      ['custom_fields.retainer_months', 'Retainer (months)'],
      ['custom_fields.renewal_date', 'Renewal date'],
      ['custom_fields.referral_source', 'Referral source'],
    ])
  })
})

describe('a filter value as a chip reads it', () => {
  it('reads every value shape', () => {
    expect(filterValueLabel(['Brand', 'Website'])).toBe('Brand, Website')
    expect(filterValueLabel({ from: 3, to: 12 })).toBe('3 – 12')
    expect(filterValueLabel({ direction: 'future', count: 3, unit: 'month' })).toBe('next 3 months')
    expect(filterValueLabel({ direction: 'this', unit: 'week' })).toBe('this week')
    expect(filterValueLabel(6)).toBe('6')
    expect(filterValueLabel('')).toBe('…')
  })
})

describe('select groups in option order', () => {
  it('keeps the groups it was given, adds the missing options, ends with No value', () => {
    const website = { key: 'Website', label: 'Website', items: [{ id: 'd1' }] }
    const out = orderCustomSelectGroups([website], ['Brand', 'Website'])
    expect(out.map((g) => g.key)).toEqual(['Brand', 'Website', '__none__'])
    expect(out[1]).toBe(website)
  })
})

describe('a value as a cell shows it', () => {
  const now = new Date(2026, 10, 10)
  it('formats by type', () => {
    expect(formatCustomFieldValue('number', 12500, now)).toBe('12,500')
    expect(formatCustomFieldValue('number', 2.5, now)).toBe('2.5')
    expect(formatCustomFieldValue('date', '2026-12-01', now)).toBe('Dec 1')
    expect(formatCustomFieldValue('date', '2027-01-15', now)).toBe('Jan 15, 2027')
    expect(formatCustomFieldValue('select', 'Website', now)).toBe('Website')
    expect(formatCustomFieldValue('text', 'Trade fair', now)).toBe('Trade fair')
  })

  it('is empty when there is nothing to show', () => {
    for (const v of [null, undefined, '', { a: 1 }, ['x']]) expect(formatCustomFieldValue('text', v, now)).toBe('')
  })
})
