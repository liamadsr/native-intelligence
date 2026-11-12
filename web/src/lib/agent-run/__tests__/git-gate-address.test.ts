/**
 * The git gate's address check (git-gate-address.ts, applied first thing in
 * authorizeRun, so reads and pushes alike):
 *   - AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES unset or blank: no check at all;
 *   - set: only a request whose x-real-ip (set by the edge from the real peer)
 *     is one of the listed addresses reaches the token check; any other, a
 *     missing one, or a forged x-forwarded-for alone gets the very 403 a bad
 *     token gets, and nothing reaches GitHub;
 *   - addresses compare by value (IPv6 spellings, IPv4-mapped IPv6, brackets,
 *     zone ids, case);
 *   - one entry that is not an address refuses everything (fail closed), with
 *     a log line that names the setting and never the value.
 * The spec's `gitGateAddressBound` is pinned in spec-rebuild.test.ts. Every
 * address here is a documentation address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({}) }))

import { GIT_PUSH_PATH, handleGitPush, type PushTarget } from '../git-push-proxy'
import { handleGitGate, ReadSlots, type GitReadDeps } from '../git-read-proxy'
import { mintGitPushToken, verifyGitPushToken } from '../git-push-token'
import {
  canonicalAddress,
  gitGateAddressBound,
  gitGateAddressPolicy,
  GIT_GATE_ALLOWED_ADDRESSES_ENV,
  parseGitGateAddresses,
} from '../git-gate-address'

const SECRET = 'test-agent-run-secret-addr-gate-00'
process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
const BRANCH = 'dial8/web-3-run00003'
const RUN = { agentRunId: 'run-quiet-fern-3', workspaceId: 'ws-quiet-fern', repoFullName: 'quiet-fern/site', branchName: BRANCH }
const TARGET: PushTarget = { repoFullName: 'quiet-fern/site', branchName: BRANCH, baseBranch: 'main', githubToken: 'gho_quietfern_madeup' }
const SANDBOX_V4 = '203.0.113.7'
const SANDBOX_V6 = '2001:db8::7'
const ELSEWHERE = '198.51.100.20'

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  vi.stubEnv(GIT_GATE_ALLOWED_ADDRESSES_ENV, '')
})
afterEach(() => {
  delete process.env.AGENT_RUN_INTERNAL_SECRET
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function deps() {
  const fetchImpl = vi.fn(async () => new Response('upstream-ok', { status: 200, headers: { 'content-type': 'application/x-git-result' } }))
  const loadTarget = vi.fn(async () => TARGET as PushTarget | { refused: string })
  return { verifyToken: (t: string | null) => verifyGitPushToken(t), loadTarget, fetchImpl, readSlots: new ReadSlots() } as GitReadDeps & {
    fetchImpl: typeof fetchImpl
    loadTarget: typeof loadTarget
  }
}

const auth = () => 'Basic ' + Buffer.from(`x-access-token:${mintGitPushToken(RUN)}`).toString('base64')

/** A read (the clone advertisement) and a push (its advertisement), from `headers`. */
async function both(headers: Record<string, string>) {
  const read = deps()
  const readRes = await handleGitGate(
    new Request(`https://app.test${GIT_PUSH_PATH}/info/refs?service=git-upload-pack`, { headers: { authorization: auth(), ...headers } }),
    ['info', 'refs'],
    read,
  )
  const push = deps()
  const pushRes = await handleGitPush(
    new Request(`https://app.test${GIT_PUSH_PATH}/info/refs?service=git-receive-pack`, { headers: { authorization: auth(), ...headers } }),
    ['info', 'refs'],
    push,
  )
  return { readRes, pushRes, upstreamCalls: read.fetchImpl.mock.calls.length + push.fetchImpl.mock.calls.length }
}

/** What a bad token gets: the reference refusal. */
async function badTokenAnswer() {
  const res = await handleGitPush(
    new Request(`https://app.test${GIT_PUSH_PATH}/info/refs?service=git-receive-pack`, { headers: { authorization: 'Bearer nope' } }),
    ['info', 'refs'],
    deps(),
  )
  return { status: res.status, body: await res.text() }
}

describe('canonicalAddress', () => {
  it('compares by value, not spelling', () => {
    expect(canonicalAddress(' 203.0.113.7 ')).toBe('203.0.113.7')
    expect(canonicalAddress('2001:0DB8:0:0:0:0:0:7')).toBe('2001:db8::7')
    expect(canonicalAddress('[2001:db8::7]')).toBe('2001:db8::7')
    expect(canonicalAddress('fe80::1%eth0')).toBe('fe80::1')
    expect(canonicalAddress('::ffff:203.0.113.7')).toBe('203.0.113.7')
    expect(canonicalAddress('::FFFF:CB00:7107')).toBe('203.0.113.7')
  })

  it('anything else is not an address', () => {
    for (const bad of ['', 'sandbox.example.com', '203.0.113.300', '203.0.113.07', '2001:db8::7::1', '203.0.113.0/24', 'unknown']) {
      expect(canonicalAddress(bad), bad).toBeNull()
    }
  })
})

describe('parseGitGateAddresses / gitGateAddressBound', () => {
  it('blank → off; addresses (comma or space separated) → allow; one bad entry → refuse everything', () => {
    expect(parseGitGateAddresses(undefined)).toEqual({ kind: 'off' })
    expect(parseGitGateAddresses(' , \n')).toEqual({ kind: 'off' })
    const allow = parseGitGateAddresses(`${SANDBOX_V4}, 2001:0db8::0007\n`)
    expect(allow).toEqual({ kind: 'allow', addresses: new Set([SANDBOX_V4, SANDBOX_V6]) })
    expect(parseGitGateAddresses(`${SANDBOX_V4} sandbox.example.com`)).toEqual({ kind: 'refuse' })
  })

  it('bound exactly when at least one valid address and no invalid one', () => {
    expect(gitGateAddressBound({})).toBe(false)
    expect(gitGateAddressBound({ [GIT_GATE_ALLOWED_ADDRESSES_ENV]: ' ' })).toBe(false)
    expect(gitGateAddressBound({ [GIT_GATE_ALLOWED_ADDRESSES_ENV]: SANDBOX_V4 })).toBe(true)
    expect(gitGateAddressBound({ [GIT_GATE_ALLOWED_ADDRESSES_ENV]: `${SANDBOX_V4},not-an-ip` })).toBe(false)
  })

  it('an invalid entry is logged once, naming the setting and never the value', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const value = `${SANDBOX_V4},secret-looking-entry-9`
    gitGateAddressPolicy({ [GIT_GATE_ALLOWED_ADDRESSES_ENV]: value })
    gitGateAddressPolicy({ [GIT_GATE_ALLOWED_ADDRESSES_ENV]: value })
    expect(error).toHaveBeenCalledTimes(1)
    const line = String(error.mock.calls[0][0])
    expect(line).toContain(GIT_GATE_ALLOWED_ADDRESSES_ENV)
    expect(line).not.toContain('secret-looking-entry-9')
    expect(line).not.toContain(SANDBOX_V4)
  })
})

describe('the git gate with the setting unset: as before', () => {
  it('any address, or none, reaches the token check (reads and pushes)', async () => {
    for (const headers of [{}, { 'x-real-ip': ELSEWHERE }]) {
      const { readRes, pushRes, upstreamCalls } = await both(headers)
      expect([readRes.status, pushRes.status]).toEqual([200, 200])
      expect(upstreamCalls).toBe(2)
    }
  })
})

describe('the git gate with AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES set', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubEnv(GIT_GATE_ALLOWED_ADDRESSES_ENV, `${SANDBOX_V4}, ${SANDBOX_V6}`)
  })

  it('a listed x-real-ip passes, IPv4 and IPv6, in any spelling (reads and pushes)', async () => {
    for (const peer of [SANDBOX_V4, '::ffff:203.0.113.7', SANDBOX_V6, '2001:0db8:0000:0000:0000:0000:0000:0007', '[2001:DB8::7]']) {
      const { readRes, pushRes, upstreamCalls } = await both({ 'x-real-ip': peer })
      expect([readRes.status, pushRes.status], peer).toEqual([200, 200])
      expect(upstreamCalls).toBe(2)
    }
  })

  it('another address, a missing one, or a forged x-forwarded-for alone: the bad-token 403, and nothing reaches GitHub', async () => {
    const reference = await badTokenAnswer()
    expect(reference.status).toBe(403)
    for (const headers of [
      { 'x-real-ip': ELSEWHERE },
      { 'x-real-ip': '2001:db8::8' },
      {},
      { 'x-forwarded-for': SANDBOX_V4 },
      { 'x-forwarded-for': `${SANDBOX_V4}, ${ELSEWHERE}`, 'x-real-ip': ELSEWHERE },
      { 'x-real-ip': 'garbage' },
    ]) {
      const { readRes, pushRes, upstreamCalls } = await both(headers as Record<string, string>)
      expect([readRes.status, pushRes.status], JSON.stringify(headers)).toEqual([403, 403])
      expect(await pushRes.text()).toBe(reference.body)
      expect(upstreamCalls).toBe(0)
    }
  })

  it('a valid token from the wrong address is refused before the run is read', async () => {
    const push = deps()
    const res = await handleGitPush(
      new Request(`https://app.test${GIT_PUSH_PATH}/info/refs?service=git-receive-pack`, { headers: { authorization: auth(), 'x-real-ip': ELSEWHERE } }),
      ['info', 'refs'],
      push,
    )
    expect(res.status).toBe(403)
    expect(push.loadTarget).not.toHaveBeenCalled()
  })

  it('one entry that is not an address refuses everything, the listed addresses included (fail closed)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubEnv(GIT_GATE_ALLOWED_ADDRESSES_ENV, `${SANDBOX_V4}, sandbox.example.com`)
    const { readRes, pushRes, upstreamCalls } = await both({ 'x-real-ip': SANDBOX_V4 })
    expect([readRes.status, pushRes.status]).toEqual([403, 403])
    expect(upstreamCalls).toBe(0)
  })
})
