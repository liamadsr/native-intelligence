import { describe, expect, it } from 'vitest'
import {
  IDENTIFIER_QUERY,
  isMenuSearchKind,
  menuRowId,
  normalizeQuery,
  scoreIdentifier,
  scoreText,
  toMentionCompany,
  toMentionContact,
} from '../menu-search'

describe('scoreText', () => {
  it('ranks the whole name over its start, a word start, anywhere, and scattered words', () => {
    const exact = scoreText('Pricing', 'pricing')
    const start = scoreText('Pricing page copy', 'pricing')
    const word = scoreText('Pricing page copy', 'page')
    const inside = scoreText('Repricing', 'pric')
    const scattered = scoreText('Send pricing to Acme', 'pricing acme')
    expect(exact).toBe(1)
    expect(start).toBeGreaterThan(word)
    expect(word).toBeGreaterThan(inside)
    expect(inside).toBeGreaterThan(scattered)
    expect(scattered).toBeGreaterThan(0)
  })

  it('ignores case and extra spaces, and scores no match (or nothing typed) 0', () => {
    expect(scoreText('  Maya   Chen ', 'maya chen')).toBe(1)
    expect(scoreText('Maya Chen', 'zed')).toBe(0)
    expect(scoreText('Maya Chen', '   ')).toBe(0)
    expect(scoreText(null, 'maya')).toBe(0)
  })

  it('takes regex characters literally', () => {
    expect(scoreText('C++ (draft)', 'c++')).toBe(0.85)
    expect(scoreText('Q3 plan (v2)', '(v2')).toBe(0.7)
  })
})

describe('scoreIdentifier', () => {
  it('puts an exact identifier above any title match, and a prefix just under an exact title', () => {
    expect(scoreIdentifier('GEN-42', 'gen-42')).toBeGreaterThan(scoreText('gen-42', 'gen-42'))
    expect(scoreIdentifier('GEN-42', 'GEN-4')).toBe(0.9)
    expect(scoreIdentifier('GEN-42', 'GEN-')).toBe(0.9)
    expect(scoreIdentifier('GEN-42', 'ENG-4')).toBe(0)
  })

  it('reads only identifier-shaped queries', () => {
    expect(IDENTIFIER_QUERY.test('gen-42')).toBe(true)
    expect(IDENTIFIER_QUERY.test('gen')).toBe(false)
    expect(scoreIdentifier('GEN-42', 'gen')).toBe(0)
  })
})

describe('rows', () => {
  it('maps contact and company rows to what the composer attaches', () => {
    expect(
      toMentionContact({ id: 'c1', full_name: 'Maya', email: null, job_title: 'Ops', member_id: 'm1', company: { id: 'co', name: 'Acme' } }),
    ).toEqual({ id: 'c1', full_name: 'Maya', email: null, job_title: 'Ops', company_name: 'Acme', is_member: true })
    expect(toMentionCompany({ id: 'co', name: null, domain: 'acme.com', logo_url: null, industry: null, contact_count: '3' })).toEqual({
      id: 'co',
      name: 'acme.com',
      domain: 'acme.com',
      industry: null,
      logo_url: null,
      contact_count: 3,
    })
  })

  it('reads a row id whatever its kind', () => {
    expect(menuRowId({ kind: 'action', id: 'a1', title: 'x', identifier: null, status: null, score: 0 })).toBe('a1')
    expect(menuRowId({ kind: 'contact', contact: toMentionContact({ id: 'c1', full_name: null, email: null, job_title: null, member_id: null, company: null }), score: 0 })).toBe('c1')
  })

  it('knows its kinds', () => {
    expect(isMenuSearchKind('initiative')).toBe(true)
    expect(isMenuSearchKind('claim')).toBe(false)
    expect(normalizeQuery('  A   b ')).toBe('a b')
  })
})
