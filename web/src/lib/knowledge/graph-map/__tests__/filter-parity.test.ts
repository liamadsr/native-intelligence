/**
 * THE INVARIANT THIS WHOLE FEATURE RESTS ON.
 *
 * A saved claim view can be drawn as the knowledge map, as a list, or as a
 * board. The list and board answer it with SQL; the map answers it with a
 * bitmask over typed arrays. If the two vocabularies ever drift — one field the
 * filter picker offers that the mask cannot answer, one operator the picker
 * allows that the mask does not implement — then flipping the layout toggle
 * silently changes which claims you are looking at, with identical chrome and
 * no error.
 *
 * So the picker's vocabulary is not allowed to be a superset. Every field in
 * `FILTERABLE_FIELDS.claim` must exist in `MAP_FILTER_FIELDS`, and every
 * operator `OPERATORS_BY_TYPE` offers for that field's type must be one the
 * mask implements for its kind. Adding a field to one side without the other
 * fails here, at the registration, rather than in a user's workspace.
 */

import { describe, expect, it } from 'vitest'

import { FILTERABLE_FIELDS, OPERATORS_BY_TYPE, type ViewFilter } from '@/lib/views/types'
import {
  MAP_FILTER_FIELDS,
  MAX_PREDICATES,
  filtersKey,
  isMapFilterField,
  normalisePredicate,
  toMapFilters,
} from '@/lib/knowledge/graph-map/filter-model'

const CLAIM_FIELDS = FILTERABLE_FIELDS.claim

describe('claim filter vocabulary parity', () => {
  it('registers a non-trivial claim vocabulary (guards an empty-array pass)', () => {
    expect(CLAIM_FIELDS.length).toBeGreaterThan(5)
  })

  it.each(CLAIM_FIELDS.map((f) => [f.field, f] as const))(
    '%s is a field the map can mask',
    (field) => {
      expect(isMapFilterField(field), `${field} is offered by the filter picker but MAP_FILTER_FIELDS has no entry for it, so the graph layout would ignore it`).toBe(true)
    },
  )

  it('offers every operator the picker allows, for every claim field', () => {
    const gaps: string[] = []
    for (const def of CLAIM_FIELDS) {
      if (!isMapFilterField(def.field)) continue
      for (const op of OPERATORS_BY_TYPE[def.type]) {
        // A probe value that is valid for the field, so a rejection can only
        // ever mean "this operator is not implemented".
        const probe = probeFilter(def.field, op)
        const result = normalisePredicate(probe)
        if (typeof result === 'string' && /cannot be applied/.test(result)) {
          gaps.push(`${def.field} × ${op}`)
        }
      }
    }
    expect(gaps, 'the filter picker offers these combinations but the map mask does not implement them').toEqual([])
  })

  it('has no map field the picker cannot reach — dead mask code is a drift signal too', () => {
    const offered = new Set(CLAIM_FIELDS.map((f) => f.field))
    const orphans = Object.keys(MAP_FILTER_FIELDS).filter((f) => !offered.has(f))
    expect(orphans).toEqual([])
  })
})

/** A filter whose VALUE is valid for the field, so only the operator is on trial. */
function probeFilter(field: string, operator: ViewFilter['operator']): ViewFilter {
  const value = (() => {
    if (operator === 'is_empty' || operator === 'is_not_empty') return ''
    if (operator === 'is_relative') return { unit: 'day', direction: 'past', count: 30 }
    switch (field) {
      case 'type': return operator === 'is' || operator === 'is_not' ? 'fact' : ['fact']
      case 'confirmation': return operator === 'is' || operator === 'is_not' ? 'confirmed' : ['confirmed']
      case 'scope': return operator === 'is' || operator === 'is_not' ? 'personal' : ['personal']
      case 'confidence': return operator === 'between' ? { from: 0.5, to: 0.9 } : 0.7
      case 'auto_accepted': return true
      case 'created_by':
      case 'project_ids': return '11111111-1111-4111-8111-111111111111'
      case 'text': return 'revenue'
      default:
        return operator === 'between'
          ? { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' }
          : '2026-01-01T00:00:00Z'
    }
  })()
  return { id: 'probe', field, operator, value: value as ViewFilter['value'] }
}

describe('rejection is loud, never silent', () => {
  it('reports an unknown field instead of dropping it', () => {
    const { filters, rejected } = toMapFilters([
      { id: 'a', field: 'status', operator: 'is', value: 'archived' },
    ])
    expect(filters.where).toBeUndefined()
    expect(rejected).toHaveLength(1)
    expect(rejected[0].reason).toMatch(/not a knowledge field/)
  })

  it('reports a value that means nothing for its field', () => {
    const { rejected } = toMapFilters([
      { id: 'a', field: 'type', operator: 'is', value: 'nonsense' },
    ])
    expect(rejected).toHaveLength(1)
  })

  it('refuses a viewer-relative sentinel — @me must be resolved before the wire', () => {
    const { filters, rejected } = toMapFilters([
      { id: 'a', field: 'created_by', operator: 'is', value: '@me' },
    ])
    expect(filters.where).toBeUndefined()
    expect(rejected).toHaveLength(1)
  })

  it('caps the number of predicates rather than rebuilding the map per chip', () => {
    const many: ViewFilter[] = Array.from({ length: MAX_PREDICATES + 5 }, (_, i) => ({
      id: `f${i}`,
      field: 'text',
      operator: 'contains',
      value: `term${i}`,
    }))
    const { filters, rejected } = toMapFilters(many)
    expect(filters.where).toHaveLength(MAX_PREDICATES)
    expect(rejected).toHaveLength(5)
  })
})

describe('cache key', () => {
  const projectA = '11111111-1111-4111-8111-111111111111'
  const projectB = '22222222-2222-4222-8222-222222222222'

  it('is empty for no filters, so an unfiltered map is one cache entry', () => {
    expect(filtersKey(toMapFilters([]).filters)).toBe('')
  })

  it('does not depend on chip order', () => {
    const a = toMapFilters([
      { id: '1', field: 'type', operator: 'is_any_of', value: ['fact'] },
      { id: '2', field: 'confidence', operator: 'gte', value: 0.7 },
    ]).filters
    const b = toMapFilters([
      { id: '2', field: 'confidence', operator: 'gte', value: 0.7 },
      { id: '1', field: 'type', operator: 'is_any_of', value: ['fact'] },
    ]).filters
    expect(filtersKey(a)).toBe(filtersKey(b))
  })

  it('does not depend on the order values were clicked in', () => {
    const a = toMapFilters([{ id: '1', field: 'project_ids', operator: 'is_any_of', value: [projectA, projectB] }]).filters
    const b = toMapFilters([{ id: '1', field: 'project_ids', operator: 'is_any_of', value: [projectB, projectA] }]).filters
    expect(filtersKey(a)).toBe(filtersKey(b))
  })

  it('distinguishes filter sets that select different claims', () => {
    const gte = toMapFilters([{ id: '1', field: 'confidence', operator: 'gte', value: 0.7 }]).filters
    const lte = toMapFilters([{ id: '1', field: 'confidence', operator: 'lte', value: 0.7 }]).filters
    expect(filtersKey(gte)).not.toBe(filtersKey(lte))
  })

  it('cannot be forged by a value that contains the separator', () => {
    // The old key joined `key=value` with a delimiter, so a crafted value could
    // synthesize another filter set's key and be served its map.
    const forged = toMapFilters([
      { id: '1', field: 'text', operator: 'contains', value: '","confidence","gte",0.9]]' },
    ]).filters
    const real = toMapFilters([{ id: '1', field: 'confidence', operator: 'gte', value: 0.9 }]).filters
    expect(filtersKey(forged)).not.toBe(filtersKey(real))
  })

  it('keeps a relative window UNRESOLVED, so the key does not churn per request', () => {
    const { filters } = toMapFilters([
      { id: '1', field: 'created_at', operator: 'is_relative', value: { unit: 'day', direction: 'past', count: 30 } },
    ])
    expect(filtersKey(filters)).toContain('is_relative')
    expect(filtersKey(filters)).not.toMatch(/20\d\d-\d\d-\d\dT/)
  })
})
