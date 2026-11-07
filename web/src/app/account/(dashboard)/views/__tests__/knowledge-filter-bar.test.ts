/**
 * The filter bar's pure pieces.
 *
 * `toMapFilters` is the seam where the shared UI state becomes the server's
 * wire contract, and it is the one place a sentinel (`'all'` / `'any'`) could
 * leak through as a real constraint. It also feeds `filtersKey`, which is the
 * tiling cache key AND the data source's React identity — so a mapping that
 * emits a present-but-empty key would silently reload the map on every render
 * and give the server a different cache key for the same map.
 */
import { describe, it, expect } from 'vitest'
import { filtersKey } from '@/lib/knowledge/graph-map/filters'
import type { ClaimType } from '@/lib/knowledge/graph-map/types'
import {
  EMPTY_FILTER_STATE,
  countBadgeText,
  filterStateActive,
  type KnowledgeFilterState,
} from '../knowledge-filter-bar'

function state(over: Partial<KnowledgeFilterState> = {}): KnowledgeFilterState {
  return { ...EMPTY_FILTER_STATE, types: new Set(), ...over }
}

describe('filterStateActive', () => {
  it('is false for the untouched bar', () => {
    expect(filterStateActive(state())).toBe(false)
  })

  it.each([
    ['project', state({ project: 'p1' })],
    ['types', state({ types: new Set<ClaimType>(['fact']) })],
    ['confirmation', state({ confirmation: 'confirmed' })],
    ['confidence', state({ confidence: '0.5' })],
    ['since', state({ since: '30' })],
  ])('is true when %s alone is set', (_name, s) => {
    expect(filterStateActive(s)).toBe(true)
  })
})

describe('countBadgeText', () => {
  it('reads "N nodes · M links" unfiltered', () => {
    expect(countBadgeText(12, 7, false)).toBe('12 nodes · 7 links')
  })

  it('appends " · filtered" when filters are active', () => {
    expect(countBadgeText(3, 1, true)).toBe('3 nodes · 1 links · filtered')
  })

  it('groups thousands', () => {
    expect(countBadgeText(12345, 60000, false)).toBe('12,345 nodes · 60,000 links')
  })

  it('shows a genuine zero rather than hiding the badge', () => {
    // The filtered-to-empty case: the badge and the "no matches" overlay must
    // agree, which they can only do if 0 is rendered.
    expect(countBadgeText(0, 0, true)).toBe('0 nodes · 0 links · filtered')
  })
})
