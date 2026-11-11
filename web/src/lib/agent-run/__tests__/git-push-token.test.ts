/**
 * The run's git gate token ("push token" in code): it opens only the git gate
 * (reads and pushes), so it must never verify as a run token (which opens the
 * spec route, the event route and the outcome route), nor a run token as it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { extractGitPushToken, GIT_PUSH_TOKEN_TTL_MS, mintGitPushToken, verifyGitPushToken } from '../git-push-token'
import { mintAgentRunToken, verifyAgentRunToken } from '../agent-run-token'

const SECRET = 'test-agent-run-secret-push-0000000'
const CLAIMS = { agentRunId: 'run-bright-loom-1', workspaceId: 'ws-bright-loom', repoFullName: 'bright-loom/site', branchName: 'dial8/web-1-run00001' }

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
})
afterEach(() => {
  delete process.env.AGENT_RUN_INTERNAL_SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})

describe('git push token', () => {
  it('round-trips the run', () => {
    const v = verifyGitPushToken(mintGitPushToken(CLAIMS))
    expect(v).toMatchObject(CLAIMS)
  })

  it('expires', () => {
    const t = mintGitPushToken(CLAIMS, 1_000)
    expect(verifyGitPushToken(t, 1_000 + GIT_PUSH_TOKEN_TTL_MS - 1)).not.toBeNull()
    expect(verifyGitPushToken(t, 1_000 + GIT_PUSH_TOKEN_TTL_MS)).toBeNull()
  })

  it('refuses a tampered payload or signature', () => {
    const t = mintGitPushToken(CLAIMS)
    const [payload, sig] = t.split('.')
    const other = Buffer.from(JSON.stringify({ ...CLAIMS, purpose: 'git-push', agentRunId: 'run-other', exp: Date.now() + 60_000 })).toString('base64url')
    expect(verifyGitPushToken(`${other}.${sig}`)).toBeNull()
    expect(verifyGitPushToken(`${payload}.${sig.slice(0, -2)}xx`)).toBeNull()
    expect(verifyGitPushToken(`${t}.extra`)).toBeNull()
    expect(verifyGitPushToken('')).toBeNull()
  })

  it('is never a run token, and a run token is never a push token (domain-separated MACs)', () => {
    expect(verifyAgentRunToken(mintGitPushToken(CLAIMS))).toBeNull()
    expect(verifyGitPushToken(mintAgentRunToken({ agentRunId: CLAIMS.agentRunId, workspaceId: CLAIMS.workspaceId, userId: 'user-1' }))).toBeNull()
  })

  it('carries the repo and branch it was minted for, and refuses a token without them', () => {
    expect(verifyGitPushToken(mintGitPushToken(CLAIMS))).toMatchObject({ repoFullName: 'bright-loom/site', branchName: 'dial8/web-1-run00001' })
    expect(verifyGitPushToken(mintGitPushToken({ ...CLAIMS, repoFullName: '' }))).toBeNull()
    expect(verifyGitPushToken(mintGitPushToken({ ...CLAIMS, branchName: '' }))).toBeNull()
  })

  it('fails closed without the secret', () => {
    const t = mintGitPushToken(CLAIMS)
    delete process.env.AGENT_RUN_INTERNAL_SECRET
    expect(verifyGitPushToken(t)).toBeNull()
    expect(() => mintGitPushToken(CLAIMS)).toThrow(/not set/)
  })

  it('a different secret refuses it', () => {
    const t = mintGitPushToken(CLAIMS)
    process.env.AGENT_RUN_INTERNAL_SECRET = 'another-secret-entirely-000000000'
    expect(verifyGitPushToken(t)).toBeNull()
  })

  it('reads the token from git Basic auth (password) or Bearer, nothing else', () => {
    const req = (authorization?: string) => new Request('https://app.test/x', { headers: authorization ? { authorization } : {} })
    const basic = 'Basic ' + Buffer.from('x-access-token:abc.def').toString('base64')
    expect(extractGitPushToken(req(basic))).toBe('abc.def')
    expect(extractGitPushToken(req('Bearer abc.def'))).toBe('abc.def')
    expect(extractGitPushToken(req())).toBeNull()
    expect(extractGitPushToken(req('Token abc'))).toBeNull()
    expect(extractGitPushToken(req('Basic ' + Buffer.from('nocolon').toString('base64')))).toBeNull()
  })
})
