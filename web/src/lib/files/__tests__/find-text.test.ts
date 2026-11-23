import { describe, expect, it } from 'vitest'
import { findInPages, foldForFind, matchSpans, pageTextOf } from '../find-text'

describe('foldForFind', () => {
  it('folds case and accents without moving offsets', () => {
    const text = 'Café RÉSUMÉ'
    const folded = foldForFind(text)
    expect(folded).toBe('cafe resume')
    expect(folded.length).toBe(text.length)
  })
})

describe('findInPages', () => {
  it('finds every match on every page, with its page and place', () => {
    const matches = findInPages(['Budget for Q3. The budget grows.', 'No match here', 'BUDGET'], 'budget')
    expect(matches.map((m) => [m.page, m.index, m.offset])).toEqual([
      [1, 0, 0],
      [1, 1, 19],
      [3, 0, 0],
    ])
    expect(matches[1].excerpt).toContain('budget grows')
  })

  it('matches across accents, and a query with runs of spaces', () => {
    expect(findInPages(['Le café du coin'], 'CAFE  du')).toHaveLength(1)
  })

  it('finds nothing for an empty query, and stops at the cap', () => {
    expect(findInPages(['aaaa'], '   ')).toEqual([])
    expect(findInPages(['a a a a a'], 'a', 3)).toHaveLength(3)
  })
})

describe('pageTextOf and matchSpans', () => {
  it('joins a page’s items, a space after a line end, and keeps where each starts', () => {
    const { text, starts } = pageTextOf([
      { str: 'Quarterly', hasEOL: true },
      { str: 'plan  for', hasEOL: false },
      { str: ' growth', hasEOL: false },
    ])
    expect(text).toBe('Quarterly plan for growth')
    expect(starts).toEqual([0, 10, 18])
  })

  it('maps a match back to the items it covers', () => {
    const items = [
      { str: 'Quarterly', hasEOL: true },
      { str: 'plan', hasEOL: false },
    ]
    const { text, starts } = pageTextOf(items)
    const [m] = findInPages([text], 'terly pl')
    expect(matchSpans(starts, items.map((i) => i.str), m.offset, m.length)).toEqual([
      { item: 0, from: 4, to: 9 },
      { item: 1, from: 0, to: 2 },
    ])
  })
})
