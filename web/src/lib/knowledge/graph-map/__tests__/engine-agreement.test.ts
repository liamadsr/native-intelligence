/**
 * Regressions for five ways the two filter engines drifted apart.
 *
 * Each of these shipped in the first cut of this feature and each produced the
 * same symptom, which is the reason they are gathered here rather than filed
 * beside the code they fix: ONE saved claim view, drawn as a canvas and as a
 * list, selecting DIFFERENT claims — with identical chrome, no error, and
 * nothing on screen to suggest the two disagree.
 *
 * They were found by adversarial review, not by the suite, which is exactly the
 * point: every one of them is invisible to a test that exercises one engine.
 */

import { describe, expect, it } from 'vitest'

import { isUnsetFilterValue, type ViewFilter } from '@/lib/views/types'
import { filtersKey, toMapFilters, UNSET, normalisePredicate } from '@/lib/knowledge/graph-map/filter-model'

const f = (field: string, operator: ViewFilter['operator'], value: ViewFilter['value']): ViewFilter => ({
  id: `${field}-${operator}`,
  field,
  operator,
  value,
})

describe('an unfilled chip is not a filter', () => {
  // THE BUG: a Confidence chip the user had not typed into yet carried
  // `value: ''`. The SQL engine skipped it; the map ran `Number('')` → 0 and
  // applied `confidence >= 0`, which excludes every UNSCORED claim. So the
  // canvas showed only scored claims and the list showed all of them.
  it('drops an empty confidence rather than reading it as zero', () => {
    const { filters, rejected } = toMapFilters([f('confidence', 'gte', '')])
    expect(filters.where).toBeUndefined()
    expect(rejected).toEqual([])
    expect(filtersKey(filters)).toBe('')
  })

  it('drops it silently — an unfilled chip is not a filter the map REFUSED', () => {
    // Pushing it into `rejected` would warn "text is not applied to the graph"
    // the instant a chip is added, before anything had been typed, and the
    // 300 ms commit buffer would keep that warning up through every pause.
    const { rejected } = toMapFilters([f('text', 'contains', '')])
    expect(rejected).toEqual([])
  })

  it.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['empty array', []],
  ])('agrees with the SQL engine about %s', (_label, value) => {
    expect(isUnsetFilterValue(value)).toBe(true)
    expect(normalisePredicate(f('confidence', 'gte', value as ViewFilter['value']))).toBe(UNSET)
  })

  it('still treats a real zero as a value', () => {
    // `confidence >= 0` typed DELIBERATELY is a meaningful filter — it excludes
    // the un-scored claims — and must survive.
    expect(isUnsetFilterValue(0)).toBe(false)
    const { filters } = toMapFilters([f('confidence', 'gte', 0)])
    expect(filters.where).toHaveLength(1)
  })
})

describe('text case sensitivity is per operator, as it is in SQL', () => {
  // THE BUG: `normalisePredicate` lower-cased and whitespace-collapsed every
  // text needle, and the mask compared against a folded haystack. But the SQL
  // engine runs `contains`/`starts_with`/`ends_with` through `ilike`
  // (case-insensitive) and `is`/`is_not` through `eq`/`neq` (case-SENSITIVE).
  // So `Text is "budget approved"` matched a claim reading "Budget approved"
  // on the canvas and not in the list.
  it('keeps the needle exactly as typed — no case folding on the wire', () => {
    const { filters } = toMapFilters([f('text', 'is', 'Budget Approved for Q3')])
    expect(filters.where?.[0].value).toBe('Budget Approved for Q3')
  })

  it('keeps internal whitespace — ilike does not collapse it either', () => {
    const { filters } = toMapFilters([f('text', 'contains', 'Q3  revenue')])
    expect(filters.where?.[0].value).toBe('Q3  revenue')
  })

  it('makes case a real distinction in the cache key for exact operators', () => {
    const upper = toMapFilters([f('text', 'is', 'Budget')]).filters
    const lower = toMapFilters([f('text', 'is', 'budget')]).filters
    expect(filtersKey(upper)).not.toBe(filtersKey(lower))
  })
})

describe('set operators fail closed', () => {
  // THE BUG: the enum/id/idSet compilers decided direction with
  // `op === 'is' || op === 'is_any_of'`, so an operator they did not recognise
  // read as a NEGATION — silently inverting the filter and drawing every claim
  // the user was excluding. The other compilers all returned "match nothing".
  it('refuses an operator the kind does not implement rather than inverting it', () => {
    const result = normalisePredicate(f('created_by', 'contains', 'anything'))
    expect(typeof result).toBe('string')
    expect(result).toMatch(/cannot be applied/)
  })

  it('refuses a text operator on an enum field', () => {
    expect(typeof normalisePredicate(f('type', 'starts_with', 'fa'))).toBe('string')
  })
})
