/**
 * Predicate coverage for Postgres text[] columns in the views pipeline.
 *
 * An array column reaches `applyArrayColumnFilter`, whose switch used to
 * implement only the TAG operators (includes/excludes/is_empty/is_not_empty).
 * `eval_case.modes` is the first array field declared as `type: 'enum'`, and
 * the filter UI derives its operator dropdown from OPERATORS_BY_TYPE[type]
 * alone — so it can only ever emit is / is_not / is_any_of / is_none_of, none
 * of which the switch had a case for. Every such filter fell off the end and
 * emitted NO predicate: the chip rendered as an active filter while the list
 * stayed completely unfiltered.
 *
 * These tests pin the two halves of the fix: the per-operator predicates, and
 * the general invariant that EVERY operator the UI offers for a declared array
 * field emits at least one query call.
 */
import { describe, it, expect } from 'vitest'
import { applyFilters } from '@/lib/views/query-engine'
import {
  FILTERABLE_FIELDS,
  OPERATORS_BY_TYPE,
  type FilterFieldDefinition,
  type FilterOperator,
  type ViewEntityType,
  type ViewFilter,
} from '@/lib/views/types'

/** A query spy that records every builder method call and returns itself. */
function makeQuerySpy() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (...args: unknown[]) => {
          calls.push({ method: prop, args })
          return proxy
        }
      },
    },
  )
  return { query: proxy, calls }
}

/** A ViewFilter with the id the UI always stamps on. */
function filter(field: string, operator: FilterOperator, value: unknown): ViewFilter {
  return { id: `${field}-${operator}`, field, operator, value: value as ViewFilter['value'] }
}

async function run(entityType: ViewEntityType, f: ViewFilter) {
  const { query, calls } = makeQuerySpy()
  await applyFilters(query as never, entityType, [f])
  return calls
}

describe('array column filters (eval_case.modes)', () => {
  it('`is` asks whether the row HOLDS the value, not whether it equals it', async () => {
    // A case that runs batch+live must still match a "Live" filter, so this is
    // a contains, never an eq.
    const calls = await run('eval_case', filter('modes', 'is', 'live'))
    expect(calls).toEqual([{ method: 'contains', args: ['modes', ['live']] }])
  })

  it('`is_not` negates the contains', async () => {
    const calls = await run('eval_case', filter('modes', 'is_not', 'live'))
    expect(calls).toEqual([{ method: 'not', args: ['modes', 'cs', '{live}'] }])
  })

  it('`is_any_of` overlaps — ANY of the picked modes, not all of them', async () => {
    // `contains` here would demand the row hold BOTH, hiding every batch-only
    // case from a "batch or live" filter.
    const calls = await run('eval_case', filter('modes', 'is_any_of', ['live', 'batch']))
    expect(calls).toEqual([
      { method: 'overlaps', args: ['modes', ['live', 'batch']] },
    ])
  })

  it('`is_none_of` negates the overlap', async () => {
    const calls = await run('eval_case', filter('modes', 'is_none_of', ['live', 'batch']))
    expect(calls).toEqual([
      { method: 'not', args: ['modes', 'ov', '{live,batch}'] },
    ])
  })

  it('still handles the tag-shaped operators', async () => {
    expect(await run('eval_case', filter('modes', 'includes', ['live']))).toEqual([
      { method: 'contains', args: ['modes', ['live']] },
    ])
    expect(await run('eval_case', filter('modes', 'excludes', ['live']))).toEqual([
      { method: 'not', args: ['modes', 'cs', '{live}'] },
    ])
  })

  /**
   * AN ARRAY COLUMN IS EMPTY WHEN IT IS `{}`, NOT WHEN IT IS NULL.
   *
   * These two used to emit the scalar NULL test (`is(field, null)` /
   * `not(field,'is',null)`), and this file asserted it. But every array column
   * in the schema is `NOT NULL DEFAULT '{}'` — `eval_case.modes` (252),
   * `contact.prospect_list_ids` / `company.prospect_list_ids` (259),
   * `claim.project_ids` (276) — so the column is never null and the predicate
   * matched nothing at all: "is empty" returned zero rows, "is not empty"
   * returned every row, both without an error.
   *
   * It surfaced on claims, where the knowledge map answers the same saved view
   * from its own mask and "linked to no project" is a real, correctly-computed
   * state: one view drew a canvas full of un-projected claims beside a list
   * that said "No claims".
   */
  it('tests the EMPTY ARRAY, not NULL — the column is NOT NULL DEFAULT {}', async () => {
    expect(await run('eval_case', filter('modes', 'is_empty', null))).toEqual([
      { method: 'eq', args: ['modes', '{}'] },
    ])
    expect(await run('eval_case', filter('modes', 'is_not_empty', null))).toEqual([
      { method: 'neq', args: ['modes', '{}'] },
    ])
  })
})

describe('every operator the UI offers for an array field emits a predicate', () => {
  /** Operators that carry no value are passed one anyway; the rest get a value
   *  of the shape buildFilter would produce for that operator. */
  function valueFor(operator: FilterOperator, options: string[]): unknown {
    if (operator === 'is_empty' || operator === 'is_not_empty') return null
    if (operator === 'is_any_of' || operator === 'is_none_of' || operator === 'includes' || operator === 'excludes') {
      return options.slice(0, 2)
    }
    return options[0]
  }

  const arrayFields = (
    Object.entries(FILTERABLE_FIELDS) as Array<[ViewEntityType, FilterFieldDefinition[]]>
  ).flatMap(([entityType, fields]) =>
    fields.filter((f) => f.isArray).map((f) => ({ entityType, field: f })),
  )

  it('there is at least one declared array field to cover', () => {
    expect(arrayFields.length).toBeGreaterThan(0)
  })

  it.each(arrayFields)('$entityType.$field.field covers every offered operator', async ({ entityType, field }) => {
    const options = Array.isArray(field.options) ? field.options : ['a', 'b']
    for (const operator of OPERATORS_BY_TYPE[field.type]) {
      const calls = await run(entityType, filter(field.field, operator, valueFor(operator, options)))
      expect(calls.length, `${field.field} ${operator} emitted no predicate`).toBeGreaterThan(0)
    }
  })
})
