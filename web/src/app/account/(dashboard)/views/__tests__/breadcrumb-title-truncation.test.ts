/**
 * Breadcrumb titles are shortened to a few words.
 *
 * The breadcrumb is a positional marker — the full title is already the panel
 * heading right below it — so a long title there only pushed the header wide
 * and drowned out the parent-view crumb.
 *
 * The word cap alone isn't enough: four long words are still very wide, which
 * is why a character budget rides alongside it. Both bounds are pinned here,
 * along with the case that matters most for polish — a title short enough to
 * fit must come back untouched, with no ellipsis where nothing was cut.
 */
import { describe, it, expect } from 'vitest'

import { truncateBreadcrumbTitle } from '../detail-breadcrumb-header'

const MAX_CHARS = 32

describe('truncateBreadcrumbTitle', () => {
  it('keeps the first few words of a long title', () => {
    expect(truncateBreadcrumbTitle('Connect your calendar so planning meetings get captured')).toBe(
      'Connect your calendar so…',
    )
  })

  it('leaves a short title completely alone', () => {
    // No ellipsis should appear when nothing was actually elided.
    expect(truncateBreadcrumbTitle('Fix login bug')).toBe('Fix login bug')
    expect(truncateBreadcrumbTitle('Q4 planning')).toBe('Q4 planning')
  })

  it('does not elide a title that is exactly at the word cap', () => {
    expect(truncateBreadcrumbTitle('One two three four')).toBe('One two three four')
  })

  it('elides as soon as the title exceeds the word cap', () => {
    expect(truncateBreadcrumbTitle('One two three four five')).toBe('One two three four…')
  })

  it('also bounds width when the words are long', () => {
    // Under the 4-word cap, so only the character budget can catch this.
    const result = truncateBreadcrumbTitle(
      'Infrastructure modernization implementation retrospective',
    )
    expect(result).toBe('Infrastructure modernization…')
    expect(result.length).toBeLessThanOrEqual(MAX_CHARS)
  })

  it('cuts mid-word only when a single word blows the budget', () => {
    const result = truncateBreadcrumbTitle('Supercalifragilisticexpialidociousandthensomemoretext')
    // Nothing to break on, so the cut has to land inside the word — but the
    // rendered string, ellipsis included, still has to fit.
    expect(result.length).toBeLessThanOrEqual(MAX_CHARS)
    expect(result.endsWith('…')).toBe(true)
  })

  it('normalizes surrounding and repeated whitespace', () => {
    expect(truncateBreadcrumbTitle('   Padded   title   here   ')).toBe('Padded title here')
  })

  it('handles an empty or whitespace-only title without adding an ellipsis', () => {
    expect(truncateBreadcrumbTitle('')).toBe('')
    expect(truncateBreadcrumbTitle('   ')).toBe('')
  })

  it('honours caller-supplied limits', () => {
    expect(truncateBreadcrumbTitle('one two three four five', 2)).toBe('one two…')
  })

  it('passes ticket identifiers through untouched', () => {
    // Actions render their ID here rather than their title. An elided ID would
    // be worse than useless — it has to survive whatever the limits become.
    for (const id of ['GEN-39', 'GEN-1234', 'ENGINEERING-9999', 'PROJ-1']) {
      expect(truncateBreadcrumbTitle(id)).toBe(id)
    }
  })
})
