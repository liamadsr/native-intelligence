/**
 * Signed agent-run token tests (Phase 3 eve coding runtime).
 *
 * The token is the whole cross-instance mechanism: it must round-trip, reject
 * tampering, reject expiry, and reject a wrong/absent secret. The split-secret
 * behavior (AGENT_RUN_INTERNAL_SECRET preferred, RUN_SKILL_INTERNAL_SECRET
 * fallback) is unique to this module and is pinned here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AGENT_RUN_TOKEN_HEADER,
  extractAgentRunToken,
  mintAgentRunToken,
  verifyAgentRunToken,
  verifyInternalSecret,
  internalSecret,
  type AgentRunTokenClaims,
} from '../agent-run-token'

const SECRET = 'test-agent-run-secret-1234567890'
const SKILL_SECRET = 'test-skill-run-secret-0987654321'

const CLAIMS: Omit<AgentRunTokenClaims, 'exp'> = {
  agentRunId: 'run-1',
  workspaceId: 'ws-1',
  userId: 'user-1',
}

function clearEnv() {
  delete process.env.AGENT_RUN_INTERNAL_SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
}

describe('agent-run token sign/verify', () => {
  beforeEach(() => {
    process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  })
  afterEach(clearEnv)

  it('round-trips the claims', () => {
    const token = mintAgentRunToken(CLAIMS)
    const verified = verifyAgentRunToken(token)
    expect(verified).not.toBeNull()
    expect(verified!.agentRunId).toBe('run-1')
    expect(verified!.workspaceId).toBe('ws-1')
    expect(verified!.userId).toBe('user-1')
    expect(typeof verified!.exp).toBe('number')
  })

  it('carries a chat or resume claim only as a literal true (bots v3 Phase 5: later turns re-resolve their tools)', () => {
    expect(verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, chat: true }))!.chat).toBe(true)
    expect(verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, resume: true }))!.resume).toBe(true)
    const plain = verifyAgentRunToken(mintAgentRunToken(CLAIMS))!
    expect(plain.chat).toBeUndefined()
    expect(plain.resume).toBeUndefined()
    // Anything else we minted is dropped, never read as a chat token.
    const odd = verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, chat: 'yes' as unknown as true }))!
    expect(odd.chat).toBeUndefined()
    expect(odd.agentRunId).toBe('run-1')
  })

  it('carries a picked skill only on a chat turn’s token, and only as a skill id (bots v4)', () => {
    expect(verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, chat: true, skillId: 'skill-1' }))!.skillId).toBe('skill-1')
    // Any other token never reads as having one.
    expect(verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, skillId: 'skill-1' }))!.skillId).toBeUndefined()
    expect(verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, resume: true, skillId: 'skill-1' }))!.skillId).toBeUndefined()
    expect(verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, chat: true, skillId: 'not a skill id' }))!.skillId).toBeUndefined()
    expect(verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, chat: true, skillId: 7 as unknown as string }))!.skillId).toBeUndefined()
  })

  it('carries a relay mark only on a chat turn’s token, only as a literal true (trust layer P2: a relayed turn is unattended)', () => {
    expect(verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, chat: true, relay: true }))!.relay).toBe(true)
    expect(verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, relay: true }))!.relay).toBeUndefined()
    expect(verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, chat: true }))!.relay).toBeUndefined()
    expect(verifyAgentRunToken(mintAgentRunToken({ ...CLAIMS, chat: true, relay: 'yes' as unknown as true }))!.relay).toBeUndefined()
  })

  it('rejects a TAMPERED payload (signature mismatch)', () => {
    const token = mintAgentRunToken(CLAIMS)
    const [payload, sig] = token.split('.')
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...CLAIMS, workspaceId: 'ws-ATTACKER', exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url')
    expect(verifyAgentRunToken(`${tamperedPayload}.${sig}`)).toBeNull()
    // Also a flipped signature.
    expect(verifyAgentRunToken(`${payload}.${sig.slice(0, -2)}xy`)).toBeNull()
  })

  it('rejects an EXPIRED token', () => {
    const { createHmac } = require('node:crypto')
    const expiredPayload = Buffer.from(
      JSON.stringify({ ...CLAIMS, exp: Date.now() - 1000 }),
      'utf8',
    ).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(expiredPayload).digest('base64url')
    expect(verifyAgentRunToken(`${expiredPayload}.${sig}`)).toBeNull()
  })

  it('rejects when the secret is UNSET (fail closed)', () => {
    const token = mintAgentRunToken(CLAIMS)
    clearEnv()
    expect(verifyAgentRunToken(token)).toBeNull()
  })

  it('rejects a token signed with a DIFFERENT secret', () => {
    const token = mintAgentRunToken(CLAIMS)
    process.env.AGENT_RUN_INTERNAL_SECRET = 'a-completely-different-secret'
    expect(verifyAgentRunToken(token)).toBeNull()
  })

  it('rejects malformed input', () => {
    expect(verifyAgentRunToken('')).toBeNull()
    expect(verifyAgentRunToken(null)).toBeNull()
    expect(verifyAgentRunToken('no-dot')).toBeNull()
    expect(verifyAgentRunToken('.onlysig')).toBeNull()
    expect(verifyAgentRunToken('onlypayload.')).toBeNull()
  })

  it('rejects a token missing a required claim (defensive shape guard)', () => {
    const { createHmac } = require('node:crypto')
    // A validly-signed payload that omits userId — the HMAC is real, so only the
    // shape guard can reject it.
    const payload = Buffer.from(
      JSON.stringify({ agentRunId: 'run-1', workspaceId: 'ws-1', exp: Date.now() + 60_000 }),
      'utf8',
    ).toString('base64url')
    const sig = createHmac('sha256', SECRET).update(payload).digest('base64url')
    expect(verifyAgentRunToken(`${payload}.${sig}`)).toBeNull()
  })

  it('mint throws when the secret is unset', () => {
    clearEnv()
    expect(() => mintAgentRunToken(CLAIMS)).toThrow(/AGENT_RUN_INTERNAL_SECRET/)
  })
})

describe('split-secret behavior (own var preferred, skill-run var fallback)', () => {
  afterEach(clearEnv)

  it('falls back to RUN_SKILL_INTERNAL_SECRET when AGENT_RUN_INTERNAL_SECRET is unset', () => {
    process.env.RUN_SKILL_INTERNAL_SECRET = SKILL_SECRET
    expect(internalSecret()).toBe(SKILL_SECRET)
    const token = mintAgentRunToken(CLAIMS)
    expect(verifyAgentRunToken(token)).not.toBeNull()
  })

  it('prefers AGENT_RUN_INTERNAL_SECRET over the fallback when both are set', () => {
    process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = SKILL_SECRET
    expect(internalSecret()).toBe(SECRET)
    // A token minted under the own-var secret does NOT verify under the fallback
    // alone (proves the own var is authoritative, not the fallback).
    const token = mintAgentRunToken(CLAIMS)
    delete process.env.AGENT_RUN_INTERNAL_SECRET
    // Now only the (different) fallback remains → the own-var-signed token fails.
    expect(verifyAgentRunToken(token)).toBeNull()
  })
})

describe('verifyInternalSecret (constant-time shared secret)', () => {
  beforeEach(() => {
    process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  })
  afterEach(clearEnv)

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
    clearEnv()
    expect(verifyInternalSecret(SECRET)).toBe(false)
    expect(internalSecret()).toBeNull()
  })
})

describe('extractAgentRunToken', () => {
  it('reads the token from its header ONLY (never ?token=, which lands in logs)', () => {
    const withHeader = new Request('https://app.test/x?token=from-query', { headers: { [AGENT_RUN_TOKEN_HEADER]: 'from-header' } })
    expect(extractAgentRunToken(withHeader)).toBe('from-header')
    expect(extractAgentRunToken(new Request('https://app.test/x?token=from-query'))).toBeNull()
  })
})
