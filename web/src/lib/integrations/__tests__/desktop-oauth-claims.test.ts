/**
 * The desktop claim store (security review 2026-10-31, P0-2): only the window
 * that started a connect holds its claim secret; a deep link for a connect
 * this window didn't start is ignored (never claimed); taking a secret removes
 * it, so a code is claimed at most once from here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  claimDesktopMcp,
  claimDesktopOAuth,
  claimDesktopSlackInstall,
  holdDesktopMcpClaim,
  holdDesktopOAuthClaim,
  holdDesktopSlackClaim,
  resetDesktopOAuthClaimsForTests,
} from '../desktop-oauth-claims'

const LINK = { provider: 'google', capability: 'email', sealed: 'the-sealed-code', state: 'signed.state' }

beforeEach(() => resetDesktopOAuthClaimsForTests())

function okFetch() {
  return vi.fn(async () => new Response(JSON.stringify({ success: true, provider: 'google', capability: 'email', email: 'a@b.c' })))
}

describe('claimDesktopOAuth', () => {
  it('a deep link this window did not start: null, and nothing is posted', async () => {
    const fetchImpl = okFetch()
    expect(await claimDesktopOAuth(LINK, fetchImpl)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('posts the code, the exact state and the held secret to the claim route', async () => {
    holdDesktopOAuthClaim(LINK.state, 'the-secret')
    const fetchImpl = okFetch()
    expect(await claimDesktopOAuth(LINK, fetchImpl)).toEqual({ success: true, provider: 'google', capability: 'email' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/oauth/google/claim')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ sealed: 'the-sealed-code', state: 'signed.state', claimSecret: 'the-secret' })
  })

  it('a secret is taken once: a replayed deep link is ignored', async () => {
    holdDesktopOAuthClaim(LINK.state, 'the-secret')
    const fetchImpl = okFetch()
    await claimDesktopOAuth(LINK, fetchImpl)
    expect(await claimDesktopOAuth(LINK, fetchImpl)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("another connect's state never unlocks this one's secret", async () => {
    holdDesktopOAuthClaim('other.state', 'the-secret')
    expect(await claimDesktopOAuth(LINK, okFetch())).toBeNull()
  })

  it('a refused claim or a network failure reports a failure with the reason', async () => {
    holdDesktopOAuthClaim(LINK.state, 's')
    const refused = vi.fn(async () => new Response(JSON.stringify({ success: false, error: 'csrf_validation_failed' }), { status: 403 }))
    expect(await claimDesktopOAuth(LINK, refused)).toMatchObject({ success: false, error: 'csrf_validation_failed' })

    holdDesktopOAuthClaim(LINK.state, 's')
    const down = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await claimDesktopOAuth(LINK, down)).toMatchObject({ success: false, error: 'claim_failed' })
  })

  it('a held secret expires with the state (10 minutes)', async () => {
    vi.useFakeTimers()
    try {
      holdDesktopOAuthClaim(LINK.state, 's')
      vi.advanceTimersByTime(10 * 60 * 1000 + 1)
      expect(await claimDesktopOAuth(LINK, okFetch())).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('claimDesktopMcp (MCP connectors)', () => {
  const MCP = { state: 'desk.abc', code: 'mcp-code' }
  const okMcp = () => vi.fn(async () => new Response(JSON.stringify({ success: true, name: 'Linear', tool_count: 3 })))

  it('a link for a flow this window did not start: null, and nothing is posted', async () => {
    const fetchImpl = okMcp()
    expect(await claimDesktopMcp(MCP, fetchImpl)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("posts the code, state and the flow's claim secret to the MCP claim route, once", async () => {
    holdDesktopMcpClaim(MCP.state, 'mcp-secret')
    const fetchImpl = okMcp()
    expect(await claimDesktopMcp(MCP, fetchImpl)).toEqual({ state: 'desk.abc', success: true, name: 'Linear' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/account/mcp-servers/oauth/claim')
    expect(JSON.parse(init.body as string)).toEqual({ code: 'mcp-code', state: 'desk.abc', claim_secret: 'mcp-secret' })
    expect(await claimDesktopMcp(MCP, fetchImpl)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("an error link for this window's flow ends it without a claim; the integration store never unlocks it", async () => {
    holdDesktopMcpClaim(MCP.state, 'mcp-secret')
    const fetchImpl = okMcp()
    expect(await claimDesktopMcp({ state: MCP.state, error: 'access_denied' }, fetchImpl)).toEqual({ state: 'desk.abc', success: false, error: 'access_denied' })
    expect(fetchImpl).not.toHaveBeenCalled()
    // Separate stores: an integration claim for the same string is not an MCP one.
    holdDesktopOAuthClaim(MCP.state, 'x')
    expect(await claimDesktopMcp(MCP, fetchImpl)).toBeNull()
  })

  it('onClaiming runs once the claim is this window\'s, before the request; never for an error link or another flow', async () => {
    const order: string[] = []
    holdDesktopMcpClaim(MCP.state, 's')
    const fetchImpl = vi.fn(async () => (order.push('fetch'), new Response(JSON.stringify({ success: true }))))
    await claimDesktopMcp(MCP, fetchImpl, () => order.push('claiming'))
    expect(order).toEqual(['claiming', 'fetch'])
    const onClaiming = vi.fn()
    await claimDesktopMcp(MCP, fetchImpl, onClaiming) // not held any more
    holdDesktopMcpClaim(MCP.state, 's')
    await claimDesktopMcp({ state: MCP.state, error: 'denied' }, fetchImpl, onClaiming)
    expect(onClaiming).not.toHaveBeenCalled()
  })

  it("a refused claim reports the route's reason", async () => {
    holdDesktopMcpClaim(MCP.state, 's')
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: 'This connection is not yours' }), { status: 403 }))
    expect(await claimDesktopMcp(MCP, refused)).toEqual({ state: 'desk.abc', success: false, error: 'This connection is not yours' })
  })
})

describe('claimDesktopSlackInstall (Slack installs)', () => {
  const SLACK = { state: 'slack.state', sealed: 'the-sealed-code' }
  const okSlack = (result = 'installed') => vi.fn(async () => new Response(JSON.stringify({ result })))

  it('a link for an install this window did not start: null, and nothing is posted', async () => {
    const fetchImpl = okSlack()
    expect(await claimDesktopSlackInstall(SLACK, fetchImpl)).toBeNull()
    expect(await claimDesktopSlackInstall({ state: SLACK.state, error: 'denied' }, fetchImpl)).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('posts the sealed code, the exact state and the held secret to the Slack claim route, once', async () => {
    holdDesktopSlackClaim(SLACK.state, 'slack-secret')
    const fetchImpl = okSlack()
    expect(await claimDesktopSlackInstall(SLACK, fetchImpl)).toEqual({ state: 'slack.state', result: 'installed' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/slack/oauth/claim')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ sealed: 'the-sealed-code', state: 'slack.state', claimSecret: 'slack-secret' })
    expect(await claimDesktopSlackInstall(SLACK, fetchImpl)).toBeNull()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("an error link for this window's install ends it with the link's result, without a claim", async () => {
    holdDesktopSlackClaim(SLACK.state, 's')
    const fetchImpl = okSlack()
    expect(await claimDesktopSlackInstall({ state: SLACK.state, error: 'denied' }, fetchImpl)).toEqual({ state: 'slack.state', result: 'denied' })
    holdDesktopSlackClaim(SLACK.state, 's')
    expect(await claimDesktopSlackInstall({ state: SLACK.state, sealed: null }, fetchImpl)).toEqual({ state: 'slack.state', result: 'failed' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it("a refusal reports the route's result; an unknown answer or a network failure is 'failed'", async () => {
    holdDesktopSlackClaim(SLACK.state, 's')
    const refused = vi.fn(async () => new Response(JSON.stringify({ result: 'session' }), { status: 403 }))
    expect(await claimDesktopSlackInstall(SLACK, refused)).toEqual({ state: 'slack.state', result: 'session' })

    holdDesktopSlackClaim(SLACK.state, 's')
    const odd = vi.fn(async () => new Response(JSON.stringify({ result: '<b>hi</b>' })))
    expect(await claimDesktopSlackInstall(SLACK, odd)).toEqual({ state: 'slack.state', result: 'failed' })

    holdDesktopSlackClaim(SLACK.state, 's')
    const down = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await claimDesktopSlackInstall(SLACK, down)).toEqual({ state: 'slack.state', result: 'failed' })
  })

  it('kept apart from the other two stores: neither unlocks a Slack install, nor it theirs', async () => {
    holdDesktopOAuthClaim(SLACK.state, 'x')
    holdDesktopMcpClaim(SLACK.state, 'y')
    expect(await claimDesktopSlackInstall(SLACK, okSlack())).toBeNull()
    holdDesktopSlackClaim('slack.only', 'z')
    expect(await claimDesktopMcp({ state: 'slack.only', code: 'c' }, okSlack())).toBeNull()
    expect(await claimDesktopOAuth({ ...LINK, state: 'slack.only' }, okSlack())).toBeNull()
  })

  it("a held secret lives 15 minutes: the state's 10 plus the claim grace", async () => {
    vi.useFakeTimers()
    try {
      holdDesktopSlackClaim(SLACK.state, 's')
      vi.advanceTimersByTime(15 * 60 * 1000 - 1)
      expect(await claimDesktopSlackInstall(SLACK, okSlack())).toEqual({ state: 'slack.state', result: 'installed' })
      holdDesktopSlackClaim(SLACK.state, 's')
      vi.advanceTimersByTime(15 * 60 * 1000 + 1)
      expect(await claimDesktopSlackInstall(SLACK, okSlack())).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
