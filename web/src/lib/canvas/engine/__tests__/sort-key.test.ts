import { describe, expect, it } from 'vitest'
import { isSortKey, keyAfter, keyBetween, keysAfter, keysBetween } from '../sort-key'

describe('sort keys', () => {
  it('makes a key between any two', () => {
    const pairs: Array<[string | null, string | null]> = [
      [null, null],
      ['V', null],
      [null, 'V'],
      ['V', 'W'],
      ['V', 'V1'],
      ['Vz', 'W'],
      ['Vzz', 'W'],
      [null, '1'],
      [null, '01'],
      ['A', 'A0001'],
    ]
    for (const [a, b] of pairs) {
      const k = keyBetween(a, b)
      expect(isSortKey(k)).toBe(true)
      if (a) expect(k > a).toBe(true)
      if (b) expect(k < b).toBe(true)
    }
  })

  it('refuses a pair in the wrong order', () => {
    expect(() => keyBetween('b', 'a')).toThrow()
    expect(() => keyBetween('a', 'a')).toThrow()
  })

  it('keeps working after many inserts at the front, the back and one gap', () => {
    let front = keyBetween(null, null)
    let back = front
    for (let i = 0; i < 500; i++) {
      const f = keyBetween(null, front)
      expect(f < front).toBe(true)
      front = f
      const b = keyBetween(back, null)
      expect(b > back).toBe(true)
      back = b
    }
    let lo = 'V'
    const hi = 'W'
    for (let i = 0; i < 300; i++) {
      const k = keyBetween(lo, hi)
      expect(k > lo && k < hi).toBe(true)
      lo = k
    }
    expect(back.length).toBeLessThan(120)
  })

  it('counts up in front with short keys, from any key', () => {
    const keys = keysAfter(null, 20000)
    expect(keys[0]).toBe('a1')
    for (let i = 1; i < keys.length; i++) expect(keys[i] > keys[i - 1]).toBe(true)
    expect(keys.every(isSortKey)).toBe(true)
    expect(Math.max(...keys.map((k) => k.length))).toBe(4)
    for (const from of ['V', 'k', 'a', 'a0V', 'azV', 'bz', 'a5V', 'Zzzz', 'z', '0001']) {
      const next = keyAfter(from)
      expect(isSortKey(next)).toBe(true)
      expect(next > from).toBe(true)
      // And there is still room right behind it.
      const mid = keyBetween(from, next)
      expect(mid > from && mid < next).toBe(true)
    }
    expect(keyAfter('az')).toBe('b11')
    expect(keyAfter('a5V')).toBe('a6')
  })

  it('makes a sorted batch', () => {
    const keys = keysBetween('A', 'B', 2000)
    expect(keys).toHaveLength(2000)
    for (let i = 1; i < keys.length; i++) expect(keys[i] > keys[i - 1]).toBe(true)
    expect(keys[0] > 'A' && keys[keys.length - 1] < 'B').toBe(true)
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThan(12)
    expect(keysBetween(null, null, 0)).toEqual([])
  })
})
