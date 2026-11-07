/**
 * Text as Postgres sees it (bytes.ts): jsonbTextBytes measures what the
 * table's `octet_length(<col>::text)` checks measure, and a cut never leaves
 * a lone surrogate (which is not valid UTF-8, so Postgres refuses the row).
 */
import { describe, it, expect } from 'vitest'
import { jsonbTextBytes, sliceEnd, sliceStart } from '../bytes'

const hasLoneSurrogate = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)

describe('jsonbTextBytes', () => {
  it('measures as Postgres prints jsonb (a space after every : and ,), in UTF-8 bytes', () => {
    expect(jsonbTextBytes({ a: 1, b: [1, 2] })).toBe('{"a": 1, "b": [1, 2]}'.length)
    expect(jsonbTextBytes({ s: 'é' })).toBe(new TextEncoder().encode('{"s": "é"}').length)
    expect(jsonbTextBytes({ n: null, e: [], o: {} })).toBe('{"n": null, "e": [], "o": {}}'.length)
    // Undefined keys are left out, as JSON drops them.
    expect(jsonbTextBytes({ a: 1, b: undefined })).toBe('{"a": 1}'.length)
  })

  it('counts more than the compact JSON', () => {
    const value = { skill: 'triage', case: { request: 'x', loads: ['a', 'b'], tools: [] } }
    expect(jsonbTextBytes(value)).toBeGreaterThan(JSON.stringify(value).length)
  })
})

describe('sliceStart / sliceEnd', () => {
  const emoji = '😀' // two UTF-16 units

  it('back off one unit rather than split a surrogate pair', () => {
    const text = `ab${emoji}cd`
    // A cut at 3 lands between the emoji's halves.
    expect(sliceStart(text, 3)).toBe('ab')
    expect(sliceStart(text, 4)).toBe(`ab${emoji}`)
    expect(sliceEnd(text, 3)).toBe('cd')
    expect(sliceEnd(text, 4)).toBe(`${emoji}cd`)
    for (let n = 0; n <= text.length; n++) {
      expect(hasLoneSurrogate(sliceStart(text, n))).toBe(false)
      expect(hasLoneSurrogate(sliceEnd(text, n))).toBe(false)
    }
  })

  it('leave a short text whole, and an empty cut empty', () => {
    expect(sliceStart('abc', 10)).toBe('abc')
    expect(sliceEnd('abc', 10)).toBe('abc')
    expect(sliceStart('abc', 0)).toBe('')
    expect(sliceEnd('abc', 0)).toBe('')
  })
})
