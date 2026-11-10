/**
 * The public-safe screen in code (F3 review S3).
 */
import { describe, it, expect } from 'vitest'
import { blockedPhrases, foldText, namedPhrase, isOwnWords, contentWords, publicSafeProblem } from '../public-safe'

describe('blockedPhrases + namedPhrase', () => {
  const phrases = blockedPhrases({
    people: [{ full: 'José Núñez' }, { full: 'Dana Whitfield', last: 'Whitfield' }, { full: 'Speaker 2' }, { full: 'Guest' }, { full: '[remote_1]' }],
    companies: ['The Browser Company', 'Acme Corp', 'Initech, Inc'],
  })

  it('full names, last names and full company names, folded; diarization labels are not names', () => {
    expect(phrases).toEqual(expect.arrayContaining(['jose nunez', 'nunez', 'dana whitfield', 'whitfield', 'browser company', 'acme', 'initech']))
    expect(phrases).not.toContain('speaker 2')
    expect(phrases).not.toContain('guest')
    expect(phrases.some((p) => p.includes('remote'))).toBe(false)
  })

  it('matches whole words after folding accents, never a short word split off a name', () => {
    expect(namedPhrase('Talked to Jose Nunez today', phrases)).toBe('jose nunez')
    expect(namedPhrase('The fix: ship the smallest thing first.', phrases)).toBeNull()
    expect(namedPhrase('We love the Browser Company approach', phrases)).toBe('browser company')
    expect(namedPhrase('Dana loved it', phrases)).toBeNull()
    expect(namedPhrase('Whitfieldian logic', phrases)).toBeNull()
    expect(foldText('Ñandú Café')).toBe('nandu cafe')
  })
})

describe('publicSafeProblem', () => {
  it('prices and deal sizes', () => {
    for (const t of ['a $50k deal', 'we charge €200 a seat', '500k ARR', 'a 2M contract', '10,000 dollars', 'USD 300']) {
      expect(publicSafeProblem(t, [], { links: true })?.reason, t).toBe('gives a price or a deal size')
    }
    expect(publicSafeProblem('activation doubled in 3 months', [], { links: true })).toBeNull()
  })

  it('links are fine in a post, not in a moment', () => {
    expect(publicSafeProblem('More: https://nativeintelligence.dev', [], { links: true })).toBeNull()
    expect(publicSafeProblem('More: https://nativeintelligence.dev', [], { links: false })?.reason).toBe('has an address or a link in it')
  })
})

describe('isOwnWords (review R3)', () => {
  const speech = {
    utterances: [
      contentWords('we shipped calendar sync and time zones were the hard part'),
      contentWords('pricing came up again'),
      contentWords('our customers converts slowly'),
      contentWords('better onboarding annually matters'),
    ],
  }
  it('matches within one of their utterances', () => {
    expect(isOwnWords('Shipped calendar sync; time zones were hard.', speech)).toBe(true)
  })

  it('words scattered across the call, with no phrasing of theirs, do not pass', () => {
    // Every word was said somewhere, but no utterance holds most of them and no pair lines up.
    expect(isOwnWords('Pricing converts better annually.', speech)).toBe(false)
  })

  it('their phrasing (most word pairs) passes; a too-short moment never does', () => {
    const long = { utterances: [contentWords('time zones were the hard part of calendar sync'), contentWords('shipping it took three tries')] }
    expect(isOwnWords('Calendar sync shipped; time zones hard part.', long)).toBe(true)
    expect(isOwnWords('Ok.', speech)).toBe(false)
  })
})
