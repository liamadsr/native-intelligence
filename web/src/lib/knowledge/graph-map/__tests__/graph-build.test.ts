/**
 * Graph build helpers — hashing, labels, and the unfiled-hub naming.
 */

import { describe, expect, it } from 'vitest'

import {
  shortLabel,
  unfiledFirstSeen,
  unfiledKeyFor,
  unfiledLabel,
} from '../graph-build'
import { hash01, hash32 } from '../hash'

describe('hash', () => {
  it('is deterministic', () => {
    expect(hash32('claim:abc')).toBe(hash32('claim:abc'))
    expect(hash01('claim:abc')).toBe(hash01('claim:abc'))
  })

  it('stays inside [0, 1)', () => {
    for (let i = 0; i < 2000; i++) {
      const h = hash01(`claim:${i}`)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
    }
  })

  it('separates keys that share a long prefix', () => {
    // Sequential uuids differ only in their last characters; without the final
    // avalanche their jitter would be nearly identical.
    const a = hash01('claim:0194b2c1-0000-7000-8000-000000000001')
    const b = hash01('claim:0194b2c1-0000-7000-8000-000000000002')
    expect(Math.abs(a - b)).toBeGreaterThan(0.01)
  })

  it('spreads roughly uniformly across the unit interval', () => {
    const buckets = new Array(10).fill(0)
    for (let i = 0; i < 10_000; i++) buckets[Math.floor(hash01(`k${i}`) * 10)]++
    for (const n of buckets) {
      expect(n).toBeGreaterThan(700)
      expect(n).toBeLessThan(1300)
    }
  })

  it('respects the seed', () => {
    expect(hash01('x', 1)).not.toBe(hash01('x', 2))
  })
})

describe('shortLabel', () => {
  it('collapses whitespace', () => {
    expect(shortLabel('  a \n b\t c  ')).toBe('a b c')
  })

  it('truncates to 80 chars with an ellipsis', () => {
    const label = shortLabel('x'.repeat(200))
    expect(label.length).toBe(80)
    expect(label.endsWith('…')).toBe(true)
  })

  it('leaves an 80-char label untouched', () => {
    const exact = 'y'.repeat(80)
    expect(shortLabel(exact)).toBe(exact)
  })

  it('handles null and empty input', () => {
    expect(shortLabel(null)).toBe('')
    expect(shortLabel('')).toBe('')
    expect(shortLabel('   ')).toBe('')
  })
})

describe('unfiled hubs', () => {
  it('keys by the claim\'s UTC month', () => {
    expect(unfiledKeyFor('2026-09-15T12:00:00Z')).toBe('unfiled:2026-09')
    // An instant that is still August in UTC but September locally.
    expect(unfiledKeyFor('2026-08-31T23:30:00Z')).toBe('unfiled:2026-08')
  })

  it('labels the month for humans', () => {
    expect(unfiledLabel('unfiled:2026-09')).toBe('Unfiled · Sep 2026')
    expect(unfiledLabel('unfiled:2026-01')).toBe('Unfiled · Jan 2026')
  })

  it('dates firstSeen to the first instant of the month', () => {
    expect(unfiledFirstSeen('unfiled:2026-09')).toBe(Date.UTC(2026, 8, 1))
  })

  it('degrades gracefully on a malformed key', () => {
    expect(unfiledLabel('unfiled:garbage')).toBe('Unfiled')
    expect(unfiledFirstSeen('unfiled:garbage')).toBe(0)
  })
})
