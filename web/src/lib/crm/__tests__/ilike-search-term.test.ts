import { describe, it, expect } from 'vitest'
import { toIlikeSearchTerm } from '../ilike-search-term'

describe('toIlikeSearchTerm', () => {
  it('passes ordinary names and emails through (dots kept)', () => {
    expect(toIlikeSearchTerm('Ana Guest')).toBe('Ana Guest')
    expect(toIlikeSearchTerm('  J. Smith ')).toBe('J. Smith')
    expect(toIlikeSearchTerm('ana@example.com')).toBe('ana@example.com')
  })

  it('strips the characters that would end the condition or open a new one', () => {
    // Would otherwise read as `full_name.ilike.%x%` OR `id.neq.0` — every row.
    expect(toIlikeSearchTerm('x%,id.neq.0')).toBe('xid.neq.0')
    expect(toIlikeSearchTerm('a),and(workspace_id.eq.other')).toBe('aandworkspace\\_id.eq.other')
    expect(toIlikeSearchTerm('"quoted\\"')).toBe('quoted')
  })

  it('strips ilike wildcards and escapes the single-character one', () => {
    expect(toIlikeSearchTerm('%')).toBe('')
    expect(toIlikeSearchTerm('***')).toBe('')
    expect(toIlikeSearchTerm('john_doe')).toBe('john\\_doe')
  })

  it('returns an empty string when nothing searchable is left', () => {
    expect(toIlikeSearchTerm(' , ( ) % ')).toBe('')
  })
})
