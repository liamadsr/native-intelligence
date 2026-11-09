import { describe, it, expect } from 'vitest'
import {
  cleanOptions,
  coerceCustomValue,
  customFieldKey,
  describeCustomFields,
  findDefinition,
  isIsoDate,
  mergeCustomFields,
  resolveCustomValues,
  type CustomFieldDefinition,
} from '../custom-fields'

const def = (over: Partial<CustomFieldDefinition>): CustomFieldDefinition => ({
  id: 'd1',
  workspace_id: 'w1',
  entity_type: 'deal',
  key: 'k',
  label: 'K',
  field_type: 'text',
  options: [],
  position: 0,
  ...over,
})

describe('custom fields', () => {
  it('slugs a label into a key the migration accepts', () => {
    expect(customFieldKey('Contract length (months)')).toBe('contract_length_months')
    expect(customFieldKey('  Région  ')).toBe('region')
    expect(customFieldKey('2026 budget')).toBe('f_2026_budget')
    expect(customFieldKey('!!!')).toBe('')
    expect(customFieldKey('x'.repeat(80))).toHaveLength(40)
    for (const k of ['contract_length_months', 'region', 'f_2026_budget']) expect(k).toMatch(/^[a-z][a-z0-9_]{0,39}$/)
  })

  it('checks dates as real calendar days', () => {
    expect(isIsoDate('2026-02-28')).toBe(true)
    expect(isIsoDate('2026-02-30')).toBe(false)
    expect(isIsoDate('Feb 3')).toBe(false)
  })

  it('coerces each type, and refuses what does not fit', () => {
    expect(coerceCustomValue(def({ field_type: 'number', label: 'Seats' }), '1,200')).toEqual({ ok: true, value: 1200 })
    expect(coerceCustomValue(def({ field_type: 'number', label: 'Seats' }), 'lots')).toEqual({ ok: false, error: 'Seats needs a number' })
    expect(coerceCustomValue(def({ field_type: 'date', label: 'Renewal' }), '2026-12-01')).toEqual({ ok: true, value: '2026-12-01' })
    expect(coerceCustomValue(def({ field_type: 'date', label: 'Renewal' }), 'soon').ok).toBe(false)
    // A select takes its option case-insensitively and stores the option's spelling.
    const tier = def({ field_type: 'select', label: 'Tier', options: ['Gold', 'Silver'] })
    expect(coerceCustomValue(tier, 'gold')).toEqual({ ok: true, value: 'Gold' })
    expect(coerceCustomValue(tier, 'bronze')).toEqual({ ok: false, error: 'Tier is one of: Gold, Silver' })
    // Empty clears, whatever the type.
    expect(coerceCustomValue(tier, '')).toEqual({ ok: true, value: null })
    expect(coerceCustomValue(def({ field_type: 'text' }), null)).toEqual({ ok: true, value: null })
  })

  it('finds a field by key or label, and resolves a batch to one patch', () => {
    const defs = [def({ key: 'tier', label: 'Tier', field_type: 'select', options: ['Gold'] }), def({ key: 'seats', label: 'Seats', field_type: 'number' })]
    expect(findDefinition(defs, 'TIER')?.key).toBe('tier')
    expect(findDefinition(defs, 'seats')?.key).toBe('seats')
    expect(resolveCustomValues(defs, { Tier: 'gold', seats: 12 })).toEqual({ ok: true, patch: { tier: 'Gold', seats: 12 } })
    const unknown = resolveCustomValues(defs, { Region: 'West' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.error).toContain('Fields: Tier, Seats')
  })

  it('merges a patch: null removes the key, the rest stays', () => {
    expect(mergeCustomFields({ a: 1, b: 'x' }, { a: null, c: 'y' })).toEqual({ b: 'x', c: 'y' })
    expect(mergeCustomFields(null, { a: 2 })).toEqual({ a: 2 })
  })

  it('cleans options and describes values in definition order', () => {
    expect(cleanOptions([' Gold ', 'gold', '', 'Silver'])).toEqual(['Gold', 'Silver'])
    const defs = [def({ key: 'a', label: 'A' }), def({ key: 'b', label: 'B', field_type: 'number' })]
    expect(describeCustomFields(defs, { b: 3 })).toEqual([
      { key: 'a', label: 'A', field_type: 'text', value: null },
      { key: 'b', label: 'B', field_type: 'number', value: 3 },
    ])
  })
})
