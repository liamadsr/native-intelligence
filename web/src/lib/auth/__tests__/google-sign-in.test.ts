import { createHash, randomBytes } from 'node:crypto'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  createGoogleTransaction,
  googleSignInClient,
  googleStateMatches,
  hashedNonce,
  openGoogleTransaction,
  sealGoogleTransaction,
} from '../google-sign-in'

const REDIRECT = 'https://dial8.ai/auth/google/callback'

beforeAll(() => {
  vi.stubEnv('CREDENTIAL_ENCRYPTION_KEY', randomBytes(32).toString('base64'))
})

describe('google sign-in transaction', () => {
  it('round-trips through the sealed cookie and expires', () => {
    const tx = createGoogleTransaction({ mode: 'web', bind: null, redirectUri: REDIRECT }, 1_000)
    const sealed = sealGoogleTransaction(tx)
    expect(sealed).not.toContain(tx.verifier)
    expect(sealed).not.toContain(tx.nonce)
    expect(openGoogleTransaction(sealed, 2_000)).toEqual(tx)
    expect(openGoogleTransaction(sealed, tx.expiresAt + 1)).toBeNull()
  })

  it('refuses a missing or tampered cookie', () => {
    const sealed = sealGoogleTransaction(createGoogleTransaction({ mode: 'web', bind: null, redirectUri: REDIRECT }))
    expect(openGoogleTransaction(undefined)).toBeNull()
    expect(openGoogleTransaction(`${sealed.slice(0, -4)}AAAA`)).toBeNull()
    expect(openGoogleTransaction('not-a-seal')).toBeNull()
  })

  it('keeps the bind for the desktop only', () => {
    expect(createGoogleTransaction({ mode: 'desktop', bind: 'b', redirectUri: REDIRECT }).bind).toBe('b')
    expect(createGoogleTransaction({ mode: 'web', bind: 'b', redirectUri: REDIRECT }).bind).toBeNull()
    expect(createGoogleTransaction({ mode: 'admin', bind: 'b', redirectUri: REDIRECT }).bind).toBeNull()
  })

  it('matches the state exactly', () => {
    const tx = createGoogleTransaction({ mode: 'web', bind: null, redirectUri: REDIRECT })
    expect(googleStateMatches(tx, tx.state)).toBe(true)
    expect(googleStateMatches(tx, `${tx.state}x`)).toBe(false)
    expect(googleStateMatches(tx, null)).toBe(false)
  })
})

describe('google sign-in config', () => {
  it('is on only with both the client id and its secret', () => {
    vi.stubEnv('GOOGLE_SIGN_IN_CLIENT_ID', 'id')
    vi.stubEnv('GOOGLE_SIGN_IN_CLIENT_SECRET', '')
    expect(googleSignInClient()).toBeNull()
    vi.stubEnv('GOOGLE_SIGN_IN_CLIENT_SECRET', ' secret ')
    expect(googleSignInClient()).toEqual({ clientId: 'id', clientSecret: 'secret' })
  })

  it('hashes the nonce the way Supabase checks it (SHA-256, lowercase hex)', () => {
    expect(hashedNonce('raw')).toBe(createHash('sha256').update('raw').digest('hex'))
  })
})
