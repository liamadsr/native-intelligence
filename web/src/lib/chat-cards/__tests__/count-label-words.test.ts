/**
 * A card's pill in the workspace's words (src/lib/editions/words.ts): "12
 * jobs" in a service business, the app's own "12 actions" everywhere else,
 * and the same words as before with no edition at all.
 */
import { describe, expect, it } from 'vitest'
import { getEdition } from '@/lib/editions/manifest'
import { countLabel, type CardSpec } from '../kinds'

const list = (entity_type: string): CardSpec => ({ kind: 'list', title: 'T', entity_type, filters: [] }) as unknown as CardSpec
const record = (type: string): CardSpec => ({ kind: 'record', title: 'T', record: { type, id: 'r1' } }) as unknown as CardSpec
const page = (kind: string): CardSpec => ({ kind, title: 'T' }) as unknown as CardSpec

describe('countLabel in an edition’s words', () => {
  const service = getEdition('service')
  const full = getEdition('full')

  it('a service business’s pills say jobs, calls and customers', () => {
    expect(countLabel(list('action'), 12, service)).toBe('12 jobs')
    expect(countLabel(list('action'), 1, service)).toBe('1 job')
    expect(countLabel(list('action'), null, service)).toBe('jobs')
    expect(countLabel(list('capture'), 3, service)).toBe('3 calls')
    expect(countLabel(list('contact'), 2, service)).toBe('2 customers')
    expect(countLabel(record('contact'), null, service)).toBe('customer')
    // A word it doesn't rename stays the app's.
    expect(countLabel(list('company'), 2, service)).toBe('2 companies')
  })

  it('is the app’s own words with no edition, and in an edition that says nothing', () => {
    for (const edition of [undefined, full]) {
      expect(countLabel(list('action'), 12, edition)).toBe('12 actions')
      expect(countLabel(list('document'), 1, edition)).toBe('1 doc')
      expect(countLabel(record('capture'), 4, edition)).toBe('capture')
      expect(countLabel(page('flows'), null, edition)).toBe('Flows')
      expect(countLabel(page('flows'), 3, edition)).toBe('Flows · 3')
    }
  })
})
