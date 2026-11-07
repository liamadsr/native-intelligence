import { beforeAll, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'

beforeAll(() => {
  process.env.CREDENTIAL_ENCRYPTION_KEY = randomBytes(32).toString('base64')
})

describe('credential encryption', () => {
  it('round-trips a plaintext token', async () => {
    const { encryptCredential, decryptCredential } = await import('../credentials')
    const secret = 'sk_test_1234567890abcdef'
    const enc = encryptCredential(secret)
    expect(enc).not.toContain(secret)
    expect(decryptCredential(enc)).toBe(secret)
  })

  it('produces a different ciphertext for the same plaintext (random IV)', async () => {
    const { encryptCredential } = await import('../credentials')
    const secret = 'identical-secret'
    const a = encryptCredential(secret)
    const b = encryptCredential(secret)
    expect(a).not.toBe(b)
  })

  it('rejects tampered ciphertext (auth tag check)', async () => {
    const { encryptCredential, decryptCredential } = await import('../credentials')
    const enc = encryptCredential('hello')
    const parts = enc.split('.')
    const ct = Buffer.from(parts[3], 'base64')
    ct[0] ^= 0x01
    parts[3] = ct.toString('base64')
    expect(() => decryptCredential(parts.join('.'))).toThrow()
  })

  it('handles null/undefined gracefully', async () => {
    const { encryptCredentialOrNull, decryptCredentialOrNull } = await import('../credentials')
    expect(encryptCredentialOrNull(null)).toBeNull()
    expect(encryptCredentialOrNull(undefined)).toBeNull()
    expect(encryptCredentialOrNull('')).toBeNull()
    expect(decryptCredentialOrNull(null)).toBeNull()
    expect(decryptCredentialOrNull(undefined)).toBeNull()
  })
})
