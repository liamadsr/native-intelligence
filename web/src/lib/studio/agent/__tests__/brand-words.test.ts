/**
 * Where a Studio project's words live (brand-words.ts): pointers to the canon documents (product first, then the
 * person's voice, then their briefs), keys and titles only, and the two that matter named when missing.
 */
import { describe, expect, it } from 'vitest'
import { brandWordsFrom } from '../brand-words'

describe('the brand’s words', () => {
  it('points at product, the voice and the briefs, in that order, with the call that reads each', () => {
    const words = brandWordsFrom([
      { key: 'team-playbook', title: 'How we work', owner: 'admins', updatedAt: null },
      { key: 'content-brief:linkedin', title: 'LinkedIn brief', owner: 'you', updatedAt: null },
      { key: 'person:voice', title: 'My voice', owner: 'you', updatedAt: null },
      { key: 'product', title: 'Fernhill product', owner: 'admins', updatedAt: null },
    ])
    expect(words.canon.map((c) => c.key)).toEqual(['product', 'person:voice', 'content-brief:linkedin'])
    expect(words.canon[0]).toEqual({ key: 'product', title: 'Fernhill product', holds: "the product's positioning, messaging and voice", read: 'read_canon(key: "product")' })
    expect(words.canon[2]!.holds).toBe('the brief for linkedin')
    expect(words.missing).toEqual([])
    // Pointers only: no document text anywhere in the answer.
    expect(JSON.stringify(words)).not.toMatch(/content"|"text"/)
  })

  it('names what is not written yet, and asks for no invention', () => {
    const words = brandWordsFrom([])
    expect(words.canon).toEqual([])
    expect(words.missing).toEqual(['product', 'person:voice'])
    expect(words.note).toContain('Not written yet: product, person:voice')
  })
})
