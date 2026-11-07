/**
 * The utility token is the trust boundary between the Next app and the eve
 * utility agent. Pinned here:
 *   - sign/verify round-trips every claim, including null tenancy (briefs and
 *     unowned weaver workspaces have no user; chat titles may have no workspace);
 *   - a tampered payload, a forged signature, an expired token, a wrong
 *     audience, an unknown kind and a malformed params bag are all refused;
 *   - the secret chain: UTILITY_INTERNAL_SECRET, falling back to
 *     RUN_SKILL_INTERNAL_SECRET; no secret → mint throws, verify fails closed;
 *   - DOMAIN SEPARATION: with one secret shared through the fallback chain, a
 *     skill-run / agent-run / chat token never verifies as a utility token, and
 *     a utility token never verifies as any of those.
 */
import { createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  mintUtilityToken,
  verifyUtilityInternalSecret,
  verifyUtilityToken,
  UTILITY_KINDS,
} from '../utility-run-token'
import { mintRunToken, verifyRunToken } from '@/lib/flows/skill-run-token'
import { mintAgentRunToken, verifyAgentRunToken } from '@/lib/agent-run/agent-run-token'
import { mintChatRunToken, verifyChatRunToken } from '@/lib/chat/chat-run-token'

const CLAIMS = {
  kind: 'generate_title' as const,
  workspaceId: 'ws-1',
  userId: 'user-1',
  model: 'deepseek-v4-flash',
  params: {},
}

function repack(token: string, mutate: (c: Record<string, unknown>) => void, secret: string): string {
  const [payload] = token.split('.')
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  mutate(claims)
  const p = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')
  const sig = createHmac('sha256', secret).update(`utility.v1.${p}`).digest('base64url')
  return `${p}.${sig}`
}

beforeEach(() => {
  process.env.UTILITY_INTERNAL_SECRET = 'utility-secret'
})
afterEach(() => {
  delete process.env.UTILITY_INTERNAL_SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
  delete process.env.AGENT_RUN_INTERNAL_SECRET
  delete process.env.CHAT_INTERNAL_SECRET
  vi.useRealTimers()
})

describe('utility token — sign / verify', () => {
  it('round-trips the claims and stamps aud + exp', () => {
    const claims = verifyUtilityToken(mintUtilityToken({ ...CLAIMS, params: { tone: 'casual' } }))
    expect(claims).toMatchObject({ aud: 'utility', ...CLAIMS, params: { tone: 'casual' } })
    expect(claims!.exp).toBeGreaterThan(Date.now())
  })

  it('carries null tenancy (unattributed background work)', () => {
    const claims = verifyUtilityToken(
      mintUtilityToken({ ...CLAIMS, kind: 'knowledge_brief', userId: null, workspaceId: 'ws-1' }),
    )
    expect(claims?.userId).toBeNull()
    const noWs = verifyUtilityToken(mintUtilityToken({ ...CLAIMS, workspaceId: null }))
    expect(noWs?.workspaceId).toBeNull()
  })

  it('every kind round-trips', () => {
    for (const kind of UTILITY_KINDS) {
      expect(verifyUtilityToken(mintUtilityToken({ ...CLAIMS, kind }))?.kind).toBe(kind)
    }
  })

  it('refuses a tampered payload (signature no longer matches)', () => {
    const token = mintUtilityToken(CLAIMS)
    const [payload, sig] = token.split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    claims.workspaceId = 'ws-OTHER'
    const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`
    expect(verifyUtilityToken(forged)).toBeNull()
  })

  it('refuses a token signed with another key', () => {
    const token = repack(mintUtilityToken(CLAIMS), () => {}, 'not-the-secret')
    expect(verifyUtilityToken(token)).toBeNull()
  })

  it('refuses an expired token', () => {
    vi.useFakeTimers()
    const token = mintUtilityToken(CLAIMS)
    vi.advanceTimersByTime(11 * 60 * 1000)
    expect(verifyUtilityToken(token)).toBeNull()
  })

  it('refuses a validly signed token with the wrong audience, an unknown kind, or bad params', () => {
    const token = mintUtilityToken(CLAIMS)
    expect(verifyUtilityToken(repack(token, (c) => (c.aud = 'skill'), 'utility-secret'))).toBeNull()
    expect(verifyUtilityToken(repack(token, (c) => (c.kind = 'not_a_kind'), 'utility-secret'))).toBeNull()
    expect(verifyUtilityToken(repack(token, (c) => (c.params = { tone: 5 }), 'utility-secret'))).toBeNull()
    expect(verifyUtilityToken(repack(token, (c) => (c.model = ''), 'utility-secret'))).toBeNull()
    expect(verifyUtilityToken(repack(token, (c) => (c.userId = 7), 'utility-secret'))).toBeNull()
    // The repack helper itself produces valid tokens when nothing is wrong.
    expect(verifyUtilityToken(repack(token, () => {}, 'utility-secret'))).not.toBeNull()
  })

  it('refuses garbage', () => {
    for (const bad of [undefined, null, '', 'abc', '.sig', 'payload.', 'a.b.c']) {
      expect(verifyUtilityToken(bad as string)).toBeNull()
    }
  })
})

describe('utility token — secret chain', () => {
  it('falls back to RUN_SKILL_INTERNAL_SECRET', () => {
    delete process.env.UTILITY_INTERNAL_SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = 'skill-secret'
    expect(verifyUtilityToken(mintUtilityToken(CLAIMS))).not.toBeNull()
    expect(verifyUtilityInternalSecret('skill-secret')).toBe(true)
  })

  it('the dedicated secret wins over the fallback', () => {
    process.env.RUN_SKILL_INTERNAL_SECRET = 'skill-secret'
    expect(verifyUtilityInternalSecret('utility-secret')).toBe(true)
    expect(verifyUtilityInternalSecret('skill-secret')).toBe(false)
  })

  it('no secret: mint throws, verify and the secret check fail closed', () => {
    const token = mintUtilityToken(CLAIMS)
    delete process.env.UTILITY_INTERNAL_SECRET
    expect(() => mintUtilityToken(CLAIMS)).toThrow(/not set/)
    expect(verifyUtilityToken(token)).toBeNull()
    expect(verifyUtilityInternalSecret('')).toBe(false)
    expect(verifyUtilityInternalSecret('anything')).toBe(false)
  })
})

describe('utility token — domain separation under a shared secret', () => {
  beforeEach(() => {
    // The dev bootstrap: ONE secret feeds every family through the fallback.
    delete process.env.UTILITY_INTERNAL_SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = 'one-secret'
  })

  it('a skill-run, agent-run or chat token is not a utility token', () => {
    const skill = mintRunToken({
      workspaceId: 'ws-1',
      runAsUserId: 'user-1',
      skillId: 's1',
      mode: 'report',
      hasCapture: false,
      outputContract: 'prose',
      model: 'deepseek-v4-flash',
    })
    const agent = mintAgentRunToken({ agentRunId: 'r1', workspaceId: 'ws-1', userId: 'user-1' })
    const chat = mintChatRunToken({ conversationId: 'c1', workspaceId: 'ws-1', userId: 'user-1' })
    expect(verifyUtilityToken(skill)).toBeNull()
    expect(verifyUtilityToken(agent)).toBeNull()
    expect(verifyUtilityToken(chat)).toBeNull()
  })

  it('a utility token is not a skill-run, agent-run or chat token', () => {
    const utility = mintUtilityToken(CLAIMS)
    expect(verifyRunToken(utility)).toBeNull()
    expect(verifyAgentRunToken(utility)).toBeNull()
    expect(verifyChatRunToken(utility)).toBeNull()
  })
})
