import { randomBytes } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'

/**
 * Provider OAuth tokens at rest (token-crypto.ts): the round trip and legacy
 * plaintext reads.
 */

beforeAll(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

const {
  decryptOAuthToken,
  decryptOAuthTokenOrNull,
  encryptOAuthToken,
  encryptOAuthTokenOrNull,
  isEncryptedOAuthToken,
} = await import('../token-crypto')

// The shapes each provider's tokens come in (made up, right format), as legacy
// rows hold them today.
const LEGACY_TOKENS = {
  google: 'ya29.a0AfB_byC1dEfGhIjKlMnOpQrStUvWxYz0123456789-_abcdefg',
  github: 'gho_16C7e42F292c6912E7710c838347Ae178B4a',
  linear: 'lin_oauth_8f3a2b1c9d0e7f6a5b4c3d2e1f0a9b8c',
  jira: 'eyJraWQiOiJhYmMiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl',
  microsoft: 'EwBwA8l6BAAUbDba3x2OMJElkF7gJ4z/VbCPEz0AAQr+abc/def=',
  hubspot: 'CNbX9a2xMhIHAAEAQAAAARjK8u8LIKXhvAEo3pYFMhRZ',
  asana: '2/1201234567890/1209876543210:0a1b2c3d4e5f60718293a4b5c6d7e8f9',
  // A plaintext value that merely starts like the format is still plaintext.
  lookalike: 'v1.not.the.shape',
}

describe('encryptOAuthToken / decryptOAuthToken', () => {
  it('round-trips every provider token shape', () => {
    for (const plaintext of Object.values(LEGACY_TOKENS)) {
      const stored = encryptOAuthToken(plaintext)
      expect(stored).not.toContain(plaintext)
      expect(isEncryptedOAuthToken(stored)).toBe(true)
      expect(decryptOAuthToken(stored)).toBe(plaintext)
    }
  })

  it('encrypts the same token differently each time (fresh IV)', () => {
    expect(encryptOAuthToken('same')).not.toBe(encryptOAuthToken('same'))
  })

  it('reads a legacy plaintext token as is, and never mistakes one for a ciphertext', () => {
    for (const plaintext of Object.values(LEGACY_TOKENS)) {
      expect(isEncryptedOAuthToken(plaintext)).toBe(false)
      expect(decryptOAuthToken(plaintext)).toBe(plaintext)
    }
  })

  it('throws on a ciphertext that does not open, rather than sending it as a token', () => {
    const stored = encryptOAuthToken('gho_secret')
    const parts = stored.split('.')
    const ct = Buffer.from(parts[3], 'base64')
    ct[0] ^= 0x01
    parts[3] = ct.toString('base64')
    const tampered = parts.join('.')
    expect(isEncryptedOAuthToken(tampered)).toBe(true)
    expect(() => decryptOAuthToken(tampered)).toThrow()
  })

  it('treats empty values as no token', () => {
    expect(encryptOAuthTokenOrNull(null)).toBeNull()
    expect(encryptOAuthTokenOrNull(undefined)).toBeNull()
    expect(encryptOAuthTokenOrNull('')).toBeNull()
    expect(decryptOAuthTokenOrNull(null)).toBeNull()
    expect(decryptOAuthTokenOrNull(undefined)).toBeNull()
    expect(decryptOAuthTokenOrNull('')).toBeNull()
    expect(decryptOAuthTokenOrNull(encryptOAuthToken('tok'))).toBe('tok')
    expect(decryptOAuthTokenOrNull('legacy-tok')).toBe('legacy-tok')
  })
})
