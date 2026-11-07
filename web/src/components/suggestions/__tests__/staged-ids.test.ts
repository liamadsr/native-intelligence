import { describe, it, expect } from 'vitest'
import { stagedSuggestionIds } from '../staged-ids'

describe('stagedSuggestionIds', () => {
  it('keeps staged and existing, drops refused', () => {
    expect(
      stagedSuggestionIds({
        suggestions: [
          { id: 'a', result: 'staged' },
          { id: 'b', result: 'existing' },
          { result: 'refused', refusal: 'target_not_found' },
        ],
      }),
    ).toEqual(['a', 'b'])
  })
  it('scrapes ids from a truncated string output', () => {
    const id = '3f9a12c4-0000-4000-8000-000000000001'
    expect(stagedSuggestionIds(`{"suggestions":[{"marker":"<!-- proposal:${id} -->" … [truncated] … proposal:${id}`)).toEqual([id])
  })
  it('anything else is none', () => {
    expect(stagedSuggestionIds(null)).toEqual([])
    expect(stagedSuggestionIds({ success: false })).toEqual([])
  })
})
