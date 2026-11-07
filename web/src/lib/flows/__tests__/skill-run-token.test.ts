/**
 * Signed run-token tests (the eve server runtime for run_skill).
 *
 * The token is the whole cross-instance mechanism: it must round-trip, reject
 * tampering, reject expiry, and reject a wrong/absent secret. There is no
 * runtime flag any more — eve is the only server runtime; an unset
 * RUN_SKILL_INTERNAL_SECRET makes minting throw (the run fails closed).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  RUN_SKILL_TOKEN_HEADER,
  extractRunToken,
  mintRunToken,
  verifyRunToken,
  verifyInternalSecret,
  internalSecret,
  type RunTokenClaims,
} from '../skill-run-token'

const SECRET = 'test-internal-secret-1234567890'

const CLAIMS: Omit<RunTokenClaims, 'exp'> = {
  workspaceId: 'ws-1',
  runAsUserId: 'user-1',
  skillId: 'skill-1',
  mode: 'report',
  hasCapture: false,
  outputContract: 'prose',
  model: 'claude-haiku-4-5-20251001',
}

describe('run token sign/verify', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('round-trips the claims', () => {
    const token = mintRunToken(CLAIMS)
    const verified = verifyRunToken(token)
    expect(verified).not.toBeNull()
    expect(verified!.workspaceId).toBe('ws-1')
    expect(verified!.runAsUserId).toBe('user-1')
    expect(verified!.skillId).toBe('skill-1')
    expect(verified!.mode).toBe('report')
    expect(verified!.hasCapture).toBe(false)
    expect(verified!.outputContract).toBe('prose')
    expect(verified!.model).toBe('claude-haiku-4-5-20251001')
    expect(typeof verified!.exp).toBe('number')
  })

  it('carries the automation depth (loop guard) when minted with one, and none when not', () => {
    const withDepth = verifyRunToken(mintRunToken({ ...CLAIMS, originDepth: 2 }))
    expect(withDepth!.originDepth).toBe(2)
    const without = verifyRunToken(mintRunToken(CLAIMS))
    expect(without!.originDepth).toBeUndefined()
  })

  it('carries the dry-run claim (F1 test_flow) only as exactly true', () => {
    expect(verifyRunToken(mintRunToken({ ...CLAIMS, dryRun: true }))!.dryRun).toBe(true)
    expect(verifyRunToken(mintRunToken(CLAIMS))!.dryRun).toBeUndefined()
    expect(verifyRunToken(mintRunToken({ ...CLAIMS, dryRun: 'yes' as never }))).toBeNull()
  })

  it('rejects a TAMPERED payload (signature mismatch)', () => {
    const token = mintRunToken(CLAIMS)
    const [payload, sig] = token.split('.')
    // Flip a byte in the payload → HMAC no longer matches.
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...CLAIMS, workspaceId: 'ws-ATTACKER', exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url')
    expect(verifyRunToken(`${tamperedPayload}.${sig}`)).toBeNull()
    // Also a flipped signature.
    expect(verifyRunToken(`${payload}.${sig.slice(0, -2)}xy`)).toBeNull()
  })

  it('rejects an EXPIRED token', () => {
    const token = mintRunToken(CLAIMS)
    const [payload] = token.split('.')
    // Re-sign an expired payload with the REAL secret (so only exp fails).
    const { createHmac } = require('node:crypto')
    const expiredPayload = Buffer.from(
      JSON.stringify({ ...CLAIMS, exp: Date.now() - 1000 }),
      'utf8',
    ).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(expiredPayload).digest('base64url')
    expect(verifyRunToken(`${expiredPayload}.${sig}`)).toBeNull()
    expect(payload).toBeTruthy() // (sanity: token had a payload segment)
  })

  it('rejects when the secret is UNSET (fail closed)', () => {
    const token = mintRunToken(CLAIMS)
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    expect(verifyRunToken(token)).toBeNull()
  })

  it('rejects a token signed with a DIFFERENT secret', () => {
    const token = mintRunToken(CLAIMS)
    process.env.RUN_SKILL_INTERNAL_SECRET = 'a-completely-different-secret'
    expect(verifyRunToken(token)).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(verifyRunToken('')).toBeNull()
    expect(verifyRunToken(null)).toBeNull()
    expect(verifyRunToken('no-dot')).toBeNull()
    expect(verifyRunToken('.onlysig')).toBeNull()
    expect(verifyRunToken('onlypayload.')).toBeNull()
  })

  it('ttlMs shortens the lifetime: the token dies at its run wall + margin, not 10 min later', () => {
    const now = 1_800_000_000_000
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const token = mintRunToken(CLAIMS, { ttlMs: 180_000 })
      expect(verifyRunToken(token)?.exp).toBe(now + 180_000)
      spy.mockReturnValue(now + 179_999)
      expect(verifyRunToken(token)).not.toBeNull()
      spy.mockReturnValue(now + 180_000)
      expect(verifyRunToken(token)).toBeNull()
    } finally {
      spy.mockRestore()
    }
  })

  it('ttlMs can never LENGTHEN the lifetime past the 10-minute maximum; junk falls back to it', () => {
    const now = 1_800_000_000_000
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now)
    try {
      const max = now + 10 * 60 * 1000
      expect(verifyRunToken(mintRunToken(CLAIMS, { ttlMs: 60 * 60 * 1000 }))?.exp).toBe(max)
      expect(verifyRunToken(mintRunToken(CLAIMS, { ttlMs: 0 }))?.exp).toBe(max)
      expect(verifyRunToken(mintRunToken(CLAIMS, { ttlMs: Number.NaN }))?.exp).toBe(max)
      expect(verifyRunToken(mintRunToken(CLAIMS))?.exp).toBe(max)
    } finally {
      spy.mockRestore()
    }
  })

  it('mint throws when the secret is unset', () => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    expect(() => mintRunToken(CLAIMS)).toThrow(/RUN_SKILL_INTERNAL_SECRET/)
  })
})

describe('verifyInternalSecret (constant-time shared secret)', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('accepts the exact secret', () => {
    expect(verifyInternalSecret(SECRET)).toBe(true)
  })
  it('rejects a wrong secret, empty, null, and length mismatch', () => {
    expect(verifyInternalSecret('wrong')).toBe(false)
    expect(verifyInternalSecret('')).toBe(false)
    expect(verifyInternalSecret(null)).toBe(false)
    expect(verifyInternalSecret(SECRET + 'x')).toBe(false)
  })
  it('rejects everything when the env secret is unset', () => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    expect(verifyInternalSecret(SECRET)).toBe(false)
    expect(internalSecret()).toBeNull()
  })
})

describe('the chat claim\u2019s relay mark (A5)', () => {
  beforeEach(() => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SECRET
  })
  afterEach(() => {
    delete process.env.RUN_SKILL_INTERNAL_SECRET
  })

  it('round-trips a relayed turn\u2019s mark, and refuses anything but true', () => {
    expect(verifyRunToken(mintRunToken({ ...CLAIMS, chat: { teammateId: 'bot-1', relay: true } }))?.chat).toEqual({ teammateId: 'bot-1', relay: true })
    expect(verifyRunToken(mintRunToken({ ...CLAIMS, chat: { teammateId: 'bot-1' } }))?.chat).toEqual({ teammateId: 'bot-1' })
    expect(verifyRunToken(mintRunToken({ ...CLAIMS, chat: { teammateId: 'bot-1', relay: 'yes' as unknown as true } }))).toBeNull()
  })
})

describe('extractRunToken', () => {
  it('reads the token from its header ONLY (never ?token=, which lands in logs)', () => {
    const withHeader = new Request('https://app.test/x?token=from-query', { headers: { [RUN_SKILL_TOKEN_HEADER]: 'from-header' } })
    expect(extractRunToken(withHeader)).toBe('from-header')
    expect(extractRunToken(new Request('https://app.test/x?token=from-query'))).toBeNull()
  })
})
