import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import {
  LIVE_AGENT_SECRET_HEADER,
  LIVE_AGENT_TOKEN_HEADER,
  LIVE_AGENT_TOKEN_TTL_MS,
  extractInternalSecret,
  extractLiveAgentRunToken,
  internalSecret,
  liveAgentRunTokenKey,
  liveRecentTail,
  LIVE_RECENT_TAIL_MAX,
  liveTurnStartedAt,
  liveWindowStartedAt,
  mintLiveAgentRunToken,
  verifyInternalSecret,
  verifyLiveAgentRunToken,
  type LiveAgentTokenClaims,
} from '../live-agent-run-token'

/**
 * The live-agent run token is the eve mount's ONLY source of tenancy and turn
 * type. These pin: the round trip, tamper/expiry/shape rejection, the
 * LIVE_AGENT_INTERNAL_SECRET → RUN_SKILL_INTERNAL_SECRET fallback chain, and
 * header-only extraction.
 */

const CLAIMS: Omit<LiveAgentTokenClaims, 'exp'> = {
  captureId: 'cap-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
  currentMemberId: 'mem-1',
  turnType: 'notes',
  recipeId: 'recipe-1',
  model: 'deepseek-v4-flash',
  isEvalCapture: true,
  allowAutoArchive: false,
}

function resign(payload: object, secret: string): string {
  // Re-sign a crafted payload with the REAL secret, to prove the shape guard
  // (not just the HMAC) rejects it.
  const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${b64}.${createHmac('sha256', secret).update(b64).digest('base64url')}`
}

beforeEach(() => {
  delete process.env.LIVE_AGENT_INTERNAL_SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})
afterEach(() => {
  vi.useRealTimers()
  delete process.env.LIVE_AGENT_INTERNAL_SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})

describe('secret chain', () => {
  it('prefers LIVE_AGENT_INTERNAL_SECRET', () => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'live-secret'
    process.env.RUN_SKILL_INTERNAL_SECRET = 'root-secret'
    expect(internalSecret()).toBe('live-secret')
  })

  it('falls back to RUN_SKILL_INTERNAL_SECRET (the chain root)', () => {
    process.env.RUN_SKILL_INTERNAL_SECRET = 'root-secret'
    expect(internalSecret()).toBe('root-secret')
  })

  it('is null with neither — mint throws, verify fails closed', () => {
    expect(internalSecret()).toBeNull()
    expect(() => mintLiveAgentRunToken(CLAIMS)).toThrow(/not set/)
    expect(verifyLiveAgentRunToken('a.b')).toBeNull()
    expect(verifyInternalSecret('anything')).toBe(false)
  })
})

describe('mint / verify', () => {
  beforeEach(() => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'live-secret'
  })

  it('round-trips every claim and stamps a 15-minute expiry', () => {
    const before = Date.now()
    const claims = verifyLiveAgentRunToken(mintLiveAgentRunToken(CLAIMS))
    expect(claims).toMatchObject(CLAIMS)
    expect(claims!.exp).toBeGreaterThanOrEqual(before + LIVE_AGENT_TOKEN_TTL_MS)
    expect(LIVE_AGENT_TOKEN_TTL_MS).toBe(15 * 60 * 1000)
  })

  it('accepts a null currentMemberId and an absent recipeId', () => {
    const { recipeId: _drop, ...rest } = CLAIMS
    void _drop
    const claims = verifyLiveAgentRunToken(mintLiveAgentRunToken({ ...rest, currentMemberId: null }))
    expect(claims?.currentMemberId).toBeNull()
    expect(claims).not.toHaveProperty('recipeId')
  })

  it('rejects a tampered payload (e.g. flipping isEvalCapture off)', () => {
    const token = mintLiveAgentRunToken(CLAIMS)
    const [, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...CLAIMS, isEvalCapture: false, exp: Date.now() + 1e6 })).toString('base64url')
    expect(verifyLiveAgentRunToken(`${forged}.${sig}`)).toBeNull()
  })

  it('rejects a token signed with a different secret', () => {
    const token = mintLiveAgentRunToken(CLAIMS)
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'rotated'
    expect(verifyLiveAgentRunToken(token)).toBeNull()
  })

  it('rejects an expired token', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'))
    const token = mintLiveAgentRunToken(CLAIMS)
    vi.setSystemTime(new Date(Date.parse('2026-09-24T12:00:00Z') + LIVE_AGENT_TOKEN_TTL_MS + 1))
    expect(verifyLiveAgentRunToken(token)).toBeNull()
  })

  it('rejects malformed input', () => {
    for (const bad of [null, undefined, '', 'nodot', '.sig', 'payload.', 'a.b.c']) {
      expect(verifyLiveAgentRunToken(bad as string)).toBeNull()
    }
  })

  it('the shape guard rejects a validly-signed token with a bad turnType or missing booleans', () => {
    const exp = Date.now() + 60_000
    expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, turnType: 'admin' }, 'live-secret'))).toBeNull()
    expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, isEvalCapture: 'no' }, 'live-secret'))).toBeNull()
    const { allowAutoArchive: _a, ...noArchive } = CLAIMS
    void _a
    expect(verifyLiveAgentRunToken(resign({ ...noArchive, exp }, 'live-secret'))).toBeNull()
    expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, currentMemberId: 7 }, 'live-secret'))).toBeNull()
    // The model the turn runs and is billed under is a required, signed fact.
    const { model: _m, ...noModel } = CLAIMS
    void _m
    expect(verifyLiveAgentRunToken(resign({ ...noModel, exp }, 'live-secret'))).toBeNull()
    expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, model: '' }, 'live-secret'))).toBeNull()
    expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, model: 42 }, 'live-secret'))).toBeNull()
    // …and the same payload with valid fields verifies, so the guard is the cause.
    expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp }, 'live-secret'))).not.toBeNull()
  })
})

describe('the optional timing claims (the tool route’s time guard)', () => {
  beforeEach(() => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'live-secret'
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'))
  })
  const NOW = Date.parse('2026-10-18T12:00:00Z')

  it('round-trips turnKind + windowFlushedAt; the window clock starts at the flush', () => {
    const claims = verifyLiveAgentRunToken(mintLiveAgentRunToken({ ...CLAIMS, turnKind: 'tick', windowFlushedAt: NOW - 4_000 }))
    expect(claims).toMatchObject({ turnKind: 'tick', windowFlushedAt: NOW - 4_000 })
    expect(liveTurnStartedAt(claims!)).toBe(NOW)
    expect(liveWindowStartedAt(claims!)).toBe(NOW - 4_000)
  })

  it('a token without them still verifies, and the window clock falls back to the turn start (exp - TTL)', () => {
    const claims = verifyLiveAgentRunToken(mintLiveAgentRunToken(CLAIMS))
    expect(claims).not.toBeNull()
    expect(claims).not.toHaveProperty('turnKind')
    expect(claims).not.toHaveProperty('windowFlushedAt')
    expect(liveWindowStartedAt(claims!)).toBe(NOW)
  })

  it('the shape guard rejects a bad turnKind or a non-numeric flush time', () => {
    const exp = NOW + 60_000
    expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, turnKind: 'admin' }, 'live-secret'))).toBeNull()
    expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, windowFlushedAt: 'soon' }, 'live-secret'))).toBeNull()
    expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, windowFlushedAt: null }, 'live-secret'))).toBeNull()
    expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, turnKind: 'record', windowFlushedAt: NOW }, 'live-secret'))).not.toBeNull()
  })
})

describe('the optional mcpLookups claim (connected-app lookups)', () => {
  beforeEach(() => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'live-secret'
  })

  it('round-trips true; absent means none', () => {
    expect(verifyLiveAgentRunToken(mintLiveAgentRunToken({ ...CLAIMS, mcpLookups: true }))).toMatchObject({ mcpLookups: true })
    expect(verifyLiveAgentRunToken(mintLiveAgentRunToken(CLAIMS))).not.toHaveProperty('mcpLookups')
  })

  it('the shape guard rejects anything but true', () => {
    const exp = Date.now() + 60_000
    for (const bad of [false, 'yes', 1, ['mcp__x__get_y'], null]) {
      expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, mcpLookups: bad }, 'live-secret')), String(bad)).toBeNull()
    }
  })

  it('liveAgentRunTokenKey is the signature, unique per mint', () => {
    const a = mintLiveAgentRunToken(CLAIMS)
    expect(liveAgentRunTokenKey(a)).toBe(a.split('.')[1])
    expect(liveAgentRunTokenKey('nodot')).toBeNull()
    expect(liveAgentRunTokenKey('a.')).toBeNull()
    expect(liveAgentRunTokenKey(null)).toBeNull()
  })
})

describe('the optional recentTail claim (the shadow nudge.worth check)', () => {
  beforeEach(() => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'live-secret'
  })

  it('liveRecentTail joins the chunks, flattens whitespace and keeps the newest 600 characters', () => {
    expect(liveRecentTail(['Dana: hi', '  Ben:\n ok  '])).toBe('Dana: hi Ben: ok')
    const tail = liveRecentTail([`${'a'.repeat(1000)}`, 'END'])!
    expect(tail).toHaveLength(LIVE_RECENT_TAIL_MAX)
    expect(tail.endsWith('a END')).toBe(true)
    expect(liveRecentTail([])).toBeUndefined()
    expect(liveRecentTail(['  ', 7])).toBeUndefined()
    expect(liveRecentTail(undefined)).toBeUndefined()
  })

  it('round-trips; absent means none; a 600-character tail keeps the token small', () => {
    const recentTail = liveRecentTail(['x'.repeat(5000)])!
    const token = mintLiveAgentRunToken({ ...CLAIMS, recentTail })
    expect(verifyLiveAgentRunToken(token)).toMatchObject({ recentTail })
    expect(verifyLiveAgentRunToken(mintLiveAgentRunToken(CLAIMS))).not.toHaveProperty('recentTail')
    expect(token.length).toBeLessThan(2000)
  })

  it('the shape guard rejects a non-string or an over-long tail', () => {
    const exp = Date.now() + 60_000
    for (const bad of [42, null, ['a'], 'x'.repeat(LIVE_RECENT_TAIL_MAX + 1)]) {
      expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, recentTail: bad }, 'live-secret')), String(bad).slice(0, 20)).toBeNull()
    }
    expect(verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, recentTail: 'ok' }, 'live-secret'))).not.toBeNull()
  })
})

describe('the optional omit claim (prompt riders, riders.ts)', () => {
  beforeEach(() => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'live-secret'
  })

  it('round-trips the registered ids, in registry order, once each', () => {
    const token = mintLiveAgentRunToken({ ...CLAIMS, omit: ['talk', 'packages', 'talk'] })
    expect(verifyLiveAgentRunToken(token)?.omit).toEqual(['packages', 'talk'])
    expect(verifyLiveAgentRunToken(mintLiveAgentRunToken({ ...CLAIMS, omit: ['mcp-propose'] }))?.omit).toEqual(['mcp-propose'])
  })

  it('is minted only when non-empty: an empty or all-unknown list leaves no claim', () => {
    expect(verifyLiveAgentRunToken(mintLiveAgentRunToken(CLAIMS))).not.toHaveProperty('omit')
    expect(verifyLiveAgentRunToken(mintLiveAgentRunToken({ ...CLAIMS, omit: [] }))).not.toHaveProperty('omit')
    const unknown = mintLiveAgentRunToken({ ...CLAIMS, omit: ['ownership' as never] })
    expect(JSON.parse(Buffer.from(unknown.split('.')[0], 'base64url').toString('utf8'))).not.toHaveProperty('omit')
  })

  it('verify drops unknown values and fails open on a malformed list (the full prompt, never a refused turn)', () => {
    const exp = Date.now() + 60_000
    const verify = (omit: unknown) => verifyLiveAgentRunToken(resign({ ...CLAIMS, exp, omit }, 'live-secret'))
    expect(verify(['talk', 'voice-id', 7, null])?.omit).toEqual(['talk'])
    for (const bad of ['talk', 42, null, {}, [], ['ownership']]) {
      const claims = verify(bad)
      expect(claims, JSON.stringify(bad)).not.toBeNull()
      expect(claims, JSON.stringify(bad)).not.toHaveProperty('omit')
    }
  })
})

describe('internal secret + extraction', () => {
  it('verifies the shared secret in constant time and rejects a wrong/empty one', () => {
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'live-secret'
    expect(verifyInternalSecret('live-secret')).toBe(true)
    expect(verifyInternalSecret('live-secreT')).toBe(false)
    expect(verifyInternalSecret('')).toBe(false)
    expect(verifyInternalSecret(null)).toBe(false)
  })

  it('reads the token from its header ONLY (never ?token=, which lands in logs)', () => {
    const withHeader = new Request('https://app.test/x?token=from-query', {
      headers: { [LIVE_AGENT_TOKEN_HEADER]: 'from-header', [LIVE_AGENT_SECRET_HEADER]: 's' },
    })
    expect(extractLiveAgentRunToken(withHeader)).toBe('from-header')
    expect(extractInternalSecret(withHeader)).toBe('s')
    expect(extractLiveAgentRunToken(new Request('https://app.test/x?token=from-query'))).toBeNull()
  })
})
