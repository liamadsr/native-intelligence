/**
 * The draft-rewrite score (similarity.ts): word level, order-aware, additions
 * count, and fast on a long email. Pins the heavy-rewrite rule against
 * DRAFT_REWRITE_SIMILARITY_MAX and DRAFT_REWRITE_MIN_WORDS.
 */
import { describe, it, expect } from 'vitest'
import { isHeavyRewrite, measureRewrite, wordSimilarity, wordsOf, SIMILARITY_MAX_WORDS } from '../similarity'
import { DRAFT_REWRITE_MIN_WORDS, DRAFT_REWRITE_SIMILARITY_MAX } from '../types'

const DRAFT =
  'Hi Dana, thanks for the call today. As promised, I am sending over the pricing sheet and the onboarding plan. ' +
  'Let me know if Thursday still works for the follow up with your team.'

describe('wordsOf', () => {
  it('lowercases and keeps letters and digits only, Unicode-aware', () => {
    expect(wordsOf('Hi Dana, it’s 3pm — Åkerlund!')).toEqual(['hi', 'dana', 'it', 's', '3pm', 'åkerlund'])
    expect(wordsOf('')).toEqual([])
    expect(wordsOf(null)).toEqual([])
  })
})

describe('wordSimilarity', () => {
  it('is 1 for the same words, whatever the punctuation, case or spacing', () => {
    expect(wordSimilarity(DRAFT, DRAFT.toUpperCase().replace(/,/g, ' ;  '))).toBe(1)
    expect(wordSimilarity('', '')).toBe(1)
  })

  it('is 0 when nothing is shared, or one side is empty', () => {
    expect(wordSimilarity('alpha beta gamma', 'delta epsilon')).toBe(0)
    expect(wordSimilarity(DRAFT, '')).toBe(0)
  })

  it('keeps word order: the same words reshuffled score lower than the original', () => {
    const shuffled = wordsOf(DRAFT).reverse().join(' ')
    expect(wordSimilarity(DRAFT, shuffled)).toBeLessThan(0.3)
  })

  it('counts additions: keeping the draft but writing three times as much again is a low score', () => {
    const padded = `${DRAFT} ${'Something else entirely new here. '.repeat(30)}`
    expect(wordSimilarity(DRAFT, padded)).toBeLessThan(DRAFT_REWRITE_SIMILARITY_MAX)
  })

  it('a light edit keeps a high score', () => {
    const edited = DRAFT.replace('Thursday', 'Friday').replace('As promised, ', '')
    expect(wordSimilarity(DRAFT, edited)).toBeGreaterThan(0.9)
  })

  it('handles ~2K words a side quickly', () => {
    const big = Array.from({ length: 2500 }, (_, i) => `w${i % 300}`).join(' ')
    const other = Array.from({ length: 2500 }, (_, i) => `w${(i * 7) % 300}`).join(' ')
    const t0 = performance.now()
    const s = wordSimilarity(big, other)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(1)
    expect(SIMILARITY_MAX_WORDS).toBe(2000)
  })
})

describe('measureRewrite / isHeavyRewrite', () => {
  it('a heavy rewrite of a long enough draft', () => {
    const sent = 'Dana — we need to push the follow up to next month; budget is frozen until the board meets. Sorry for the delay.'
    const m = measureRewrite(DRAFT, sent)
    expect(m.wordsBefore).toBe(wordsOf(DRAFT).length)
    expect(m.wordsAfter).toBe(wordsOf(sent).length)
    expect(m.similarity).toBeLessThan(DRAFT_REWRITE_SIMILARITY_MAX)
    expect(m.heavy).toBe(true)
    expect(isHeavyRewrite(DRAFT, sent)).toBe(true)
  })

  it('a light edit is not heavy', () => {
    expect(isHeavyRewrite(DRAFT, DRAFT.replace('Thursday', 'Friday'))).toBe(false)
  })

  it('a short draft is never heavy, however rewritten', () => {
    const short = 'Sounds good, see you then.'
    expect(wordsOf(short).length).toBeLessThan(DRAFT_REWRITE_MIN_WORDS)
    expect(isHeavyRewrite(short, 'Actually I cannot make it, can we move to next week instead please')).toBe(false)
  })

  it('rounds the score to three places', () => {
    const m = measureRewrite('a b c', 'a b d')
    expect(m.similarity).toBe(0.667)
  })
})
