/**
 * The OAuth state module (security review 2026-10-31, P0-2): which key signs
 * the state (a dedicated secret, else one derived from CRON_SECRET; never a
 * guessable string in production), the sealed desktop code, and expiry.
 */
import crypto from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLAIM_GRACE_MS, oauthStateSecret, openDesktopCode, sealDesktopCode, verifyOAuthState } from '../state'

afterEach(() => vi.unstubAllEnvs())

function sign(payload: Record<string, unknown>) {
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${b64}.${crypto.createHmac('sha256', oauthStateSecret()).update(b64).digest('base64url')}`
}

describe('oauthStateSecret', () => {
  it('prefers the dedicated OAUTH_STATE_SECRET', () => {
    vi.stubEnv('OAUTH_STATE_SECRET', 'dedicated')
    vi.stubEnv('CRON_SECRET', 'cron')
    expect(oauthStateSecret()).toBe('dedicated')
  })

  it('without it, a key DERIVED from CRON_SECRET — never CRON_SECRET itself', () => {
    vi.stubEnv('OAUTH_STATE_SECRET', '')
    vi.stubEnv('CRON_SECRET', 'cron')
    const key = oauthStateSecret()
    expect(key).not.toBe('cron')
    expect(key).toBe(crypto.createHmac('sha256', 'cron').update('dial8-oauth-state-key-v1').digest('base64url'))
  })

  it('in production with neither, it refuses rather than sign with a guessable key', () => {
    vi.stubEnv('OAUTH_STATE_SECRET', '')
    vi.stubEnv('CRON_SECRET', '')
    vi.stubEnv('NODE_ENV', 'production')
    expect(() => oauthStateSecret()).toThrow(/required in production/)
    // …and a state can't be verified then: the routes answer server_misconfigured, not a 500.
    expect(verifyOAuthState('a.b')).toEqual({ ok: false, error: 'server_misconfigured' })
  })

  it('outside production with neither, a fixed dev key (local dev needs no setup)', () => {
    vi.stubEnv('OAUTH_STATE_SECRET', '')
    vi.stubEnv('CRON_SECRET', '')
    vi.stubEnv('NODE_ENV', 'test')
    expect(oauthStateSecret()).toBe('dev-fallback')
  })
})

describe('sealDesktopCode / openDesktopCode', () => {
  it('round-trips for the same nonce, and never contains the code in the clear', () => {
    vi.stubEnv('OAUTH_STATE_SECRET', 'secret')
    const sealed = sealDesktopCode('provider-code-123', 'nonce-a')
    expect(sealed).not.toContain('provider-code-123')
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain('provider-code-123')
    expect(openDesktopCode(sealed, 'nonce-a')).toBe('provider-code-123')
  })

  it('another nonce, another secret, a tampered blob or junk opens nothing', () => {
    vi.stubEnv('OAUTH_STATE_SECRET', 'secret')
    const sealed = sealDesktopCode('provider-code-123', 'nonce-a')
    expect(openDesktopCode(sealed, 'nonce-b')).toBeNull()
    const flipped = Buffer.from(sealed, 'base64url')
    flipped[flipped.length - 1] ^= 1
    expect(openDesktopCode(flipped.toString('base64url'), 'nonce-a')).toBeNull()
    for (const junk of ['', 'short', 'provider-code-123', 42, null]) expect(openDesktopCode(junk, 'nonce-a')).toBeNull()
    vi.stubEnv('OAUTH_STATE_SECRET', 'rotated')
    expect(openDesktopCode(sealed, 'nonce-a')).toBeNull()
  })

  it('each seal is fresh (random IV): the same code twice never looks the same', () => {
    vi.stubEnv('OAUTH_STATE_SECRET', 'secret')
    expect(sealDesktopCode('c', 'n')).not.toBe(sealDesktopCode('c', 'n'))
  })
})

describe('verifyOAuthState expiry', () => {
  it('a live state verifies; past exp it is expired, unless the caller allows a grace', () => {
    vi.stubEnv('OAUTH_STATE_SECRET', 'secret')
    const live = sign({ nonce: 'n', user_id: 'u', capability: 'email', source: 'desktop', exp: Date.now() + 60_000 })
    expect(verifyOAuthState(live)).toMatchObject({ ok: true, data: { source: 'desktop', userId: 'u', nonce: 'n' } })
    const justExpired = sign({ nonce: 'n', user_id: 'u', capability: 'email', source: 'desktop', exp: Date.now() - 1_000 })
    expect(verifyOAuthState(justExpired)).toEqual({ ok: false, error: 'state_expired' })
    expect(verifyOAuthState(justExpired, { graceMs: CLAIM_GRACE_MS })).toMatchObject({ ok: true })
    const longExpired = sign({ nonce: 'n', exp: Date.now() - CLAIM_GRACE_MS - 1_000 })
    expect(verifyOAuthState(longExpired, { graceMs: CLAIM_GRACE_MS })).toEqual({ ok: false, error: 'state_expired' })
  })

  it("any source but exactly 'desktop' reads as web (the enforced binding)", () => {
    vi.stubEnv('OAUTH_STATE_SECRET', 'secret')
    for (const source of ['app', 'Desktop', '', undefined, 1]) {
      const s = sign({ nonce: 'n', source, exp: Date.now() + 60_000 })
      expect(verifyOAuthState(s)).toMatchObject({ ok: true, data: { source: 'web' } })
    }
  })
})
