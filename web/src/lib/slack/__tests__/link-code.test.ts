import { describe, expect, it } from 'vitest'
import { linkCodeHash, linkCodeInMessage, newLinkCode, normalizeLinkCode } from '../link-code'

describe('slack link codes', () => {
  it('makes 8 unambiguous characters shown as XXXX-XXXX', () => {
    for (let i = 0; i < 50; i++) {
      const code = newLinkCode()
      expect(code).toMatch(/^[ACDEFGHJKMNPQRTUVWXY34679]{4}-[ACDEFGHJKMNPQRTUVWXY34679]{4}$/)
      expect(normalizeLinkCode(code)).toBe(code.replace('-', ''))
    }
  })

  it('normalizes case, dashes and spaces, and refuses anything else', () => {
    expect(normalizeLinkCode('k7q4-m3px')).toBe('K7Q4M3PX')
    expect(normalizeLinkCode(' K7Q4 M3PX ')).toBe('K7Q4M3PX')
    expect(normalizeLinkCode('K7Q4M3P')).toBeNull()
    expect(normalizeLinkCode('K7Q4M3PXX')).toBeNull()
    // Ambiguous letters are not in the alphabet.
    expect(normalizeLinkCode('K7Q4-M3P0')).toBeNull()
    expect(normalizeLinkCode('K7Q4-M3PI')).toBeNull()
  })

  it('hashes the canonical code stably and never to the code itself', () => {
    const hash = linkCodeHash('K7Q4M3PX')
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
    expect(linkCodeHash('K7Q4M3PX')).toBe(hash)
    expect(linkCodeHash('K7Q4M3PY')).not.toBe(hash)
    expect(hash).not.toContain('K7Q4')
  })

  it('reads a DM as a code only when the whole message is one', () => {
    expect(linkCodeInMessage('K7Q4-M3PX')).toBe('K7Q4M3PX')
    expect(linkCodeInMessage('link k7q4-m3px')).toBe('K7Q4M3PX')
    expect(linkCodeInMessage('`K7Q4-M3PX`')).toBe('K7Q4M3PX')
    expect(linkCodeInMessage('*K7Q4M3PX*')).toBe('K7Q4M3PX')
    expect(linkCodeInMessage('can you check K7Q4-M3PX for me')).toBeNull()
    expect(linkCodeInMessage('what is on my calendar')).toBeNull()
    expect(linkCodeInMessage('')).toBeNull()
  })
})
