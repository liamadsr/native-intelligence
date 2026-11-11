/**
 * Tests for the coding-agent's internal-route client (fetchEveSpec / postEvent /
 * postOutcome). We mock global fetch and assert:
 *   - graceful degradation on every failure path (null spec, canceling:false,
 *     settled:false) rather than a throw that would crash the session;
 *   - the run token gates every call (no token → no fetch, safe defaults);
 *   - the 409 "already settled" outcome is surfaced distinctly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  gitGateUrl,
  fetchEveSpec,
  postEvent,
  postOutcome,
  runTokenFromAuth,
  validGatewayTelemetry,
} from '../spec-client'
import type { SessionAuth } from 'eve/context'

const SECRET = 'agent-run-secret'

function mockFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn(impl)
  vi.stubGlobal('fetch', spy as unknown as typeof fetch)
  return spy
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env.AGENT_RUN_INTERNAL_SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
  delete process.env.NEXT_PUBLIC_APP_URL
})

describe('runTokenFromAuth', () => {
  it('reads the run token off the principal attributes', () => {
    const auth = {
      current: { attributes: { runToken: 'tok-1' } },
    } as unknown as SessionAuth
    expect(runTokenFromAuth(auth)).toBe('tok-1')
  })
  it('returns "" when absent', () => {
    expect(runTokenFromAuth({ current: null } as unknown as SessionAuth)).toBe('')
  })
})

describe('fetchEveSpec', () => {
  it('returns null with NO fetch when there is no run token', async () => {
    const spy = mockFetch(() => json({}))
    expect(await fetchEveSpec('')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns the parsed spec on 200 and sends the secret + token headers', async () => {
    const spec = {
      systemPrompt: 'sp', taskPrompt: 'tp', model: 'claude-opus-4-8',
      repoFullName: 'o/r', baseBranch: 'main', branchName: 'dial8/x',
      networkAccess: 'restricted', setupScript: null, envVars: {}, gitPushToken: 'gate.token',
    }
    const spy = mockFetch(() => json(spec))
    const got = await fetchEveSpec('tok')
    expect(got).toEqual(spec)
    const [url, init] = spy.mock.calls[0]
    expect(url).toBe('https://app.test/api/internal/agent-run/spec')
    const headers = (init!.headers as Record<string, string>)
    expect(headers['x-agent-run-secret']).toBe(SECRET)
    expect(headers['x-agent-run-token']).toBe('tok')
  })

  it('returns null on a non-OK response', async () => {
    mockFetch(() => json({ error: 'nope' }, 404))
    expect(await fetchEveSpec('tok')).toBeNull()
  })

  it('returns null when fetch throws (route down)', async () => {
    mockFetch(() => { throw new Error('ECONNREFUSED') })
    expect(await fetchEveSpec('tok')).toBeNull()
  })

  it('returns null (no throw) when neither secret env is set', async () => {
    delete process.env.AGENT_RUN_INTERNAL_SECRET
    const spy = mockFetch(() => json({}))
    expect(await fetchEveSpec('tok')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('postEvent', () => {
  it('returns { canceling: false } with NO fetch when there is no run token', async () => {
    const spy = mockFetch(() => json({ canceling: true }))
    expect(await postEvent('', 'log', 'x')).toEqual({ canceling: false })
    expect(spy).not.toHaveBeenCalled()
  })

  it('surfaces canceling:true from the route response', async () => {
    mockFetch(() => json({ canceling: true }))
    expect(await postEvent('tok', 'progress', 'working')).toEqual({ canceling: true })
  })

  it('treats a non-true canceling field as false', async () => {
    mockFetch(() => json({ canceling: 'yes' }))
    expect(await postEvent('tok', 'progress', 'x')).toEqual({ canceling: false })
  })

  it('fails OPEN to canceling:false on a non-OK response', async () => {
    mockFetch(() => json({ error: 'boom' }, 500))
    expect(await postEvent('tok', 'log', 'x')).toEqual({ canceling: false })
  })

  it('fails OPEN to canceling:false when fetch throws', async () => {
    mockFetch(() => { throw new Error('network') })
    expect(await postEvent('tok', 'log', 'x')).toEqual({ canceling: false })
  })

  it('sends the kind + text in the body', async () => {
    const spy = mockFetch(() => json({ canceling: false }))
    await postEvent('tok', 'log', 'hello')
    const body = JSON.parse((spy.mock.calls[0][1]!.body as string))
    expect(body).toEqual({ kind: 'log', text: 'hello' })
  })
})

describe('postOutcome', () => {
  it('refuses with settled:false when there is no run token', async () => {
    const spy = mockFetch(() => json({}))
    const res = await postOutcome('', { result: 'completed', summary: 's' })
    expect(res.settled).toBe(false)
    expect(res.error).toMatch(/no run token/i)
    expect(spy).not.toHaveBeenCalled()
  })

  it('returns settled:true + prUrl on 200 (reads the route camelCase prUrl)', async () => {
    // The outcome route's success body is { ok, alreadySettled, prUrl }.
    mockFetch(() => json({ ok: true, alreadySettled: false, prUrl: 'https://github.com/o/r/pull/7' }))
    const res = await postOutcome('tok', {
      result: 'pr_open',
      summary: 'did it',
      pr: { title: 't', body: 'b', head: 'dial8/x', base: 'main' },
    })
    expect(res.settled).toBe(true)
    expect(res.alreadySettled).toBe(false)
    expect(res.prUrl).toBe('https://github.com/o/r/pull/7')
  })

  it('propagates alreadySettled:true from a 200 same-outcome replay', async () => {
    mockFetch(() => json({ ok: true, alreadySettled: true, prUrl: null }))
    const res = await postOutcome('tok', { result: 'completed', summary: 's' })
    expect(res.settled).toBe(true)
    expect(res.alreadySettled).toBe(true)
  })

  it('surfaces a 409 as alreadySettled with the route error as message', async () => {
    // The route's 409 body is { error, code } — no prUrl.
    mockFetch(() => json({ error: "run already settled as 'failed'", code: 'OUTCOME_CONFLICT' }, 409))
    const res = await postOutcome('tok', { result: 'completed', summary: 's' })
    expect(res.settled).toBe(true)
    expect(res.alreadySettled).toBe(true)
    expect(res.message).toMatch(/already settled/i)
    expect(res.prUrl).toBeNull()
  })

  it('a reviewer’s changes settle nothing and carry what to change (P10 F6)', async () => {
    mockFetch(() => json({ ok: false, settled: false, changesRequested: true, roundsLeft: 1, message: 'Re-enable the button on error.' }))
    const res = await postOutcome('tok', { result: 'pr_open', summary: 's', pr: { title: 't', body: 'b', head: 'h', base: 'main' } })
    expect(res).toEqual({ settled: false, changesRequested: true, message: 'Re-enable the button on error.' })
  })

  it('a review that stopped the run is settled, with the reason and no PR', async () => {
    mockFetch(() => json({ ok: true, alreadySettled: false, prUrl: null, reviewStopped: true, message: 'No pull request: rejected.' }))
    const res = await postOutcome('tok', { result: 'pr_open', summary: 's', pr: { title: 't', body: 'b', head: 'h', base: 'main' } })
    expect(res).toEqual({ settled: true, reviewStopped: true, prUrl: null, message: 'No pull request: rejected.' })
  })

  it('returns settled:false + error on a non-409 failure', async () => {
    mockFetch(() => json({ error: 'server exploded' }, 500))
    const res = await postOutcome('tok', { result: 'failed', summary: 's', error: 'x' })
    expect(res.settled).toBe(false)
    expect(res.error).toBe('server exploded')
  })

  it('returns settled:false when fetch throws', async () => {
    mockFetch(() => { throw new Error('down') })
    const res = await postOutcome('tok', { result: 'completed', summary: 's' })
    expect(res.settled).toBe(false)
    expect(res.error).toMatch(/down/)
  })

  it('sends the full outcome body', async () => {
    const spy = mockFetch(() => json({}))
    await postOutcome('tok', {
      result: 'pr_open',
      summary: 's',
      pr: { title: 't', body: 'b', head: 'h', base: 'base' },
    })
    const body = JSON.parse((spy.mock.calls[0][1]!.body as string))
    expect(body).toEqual({
      result: 'pr_open',
      summary: 's',
      pr: { title: 't', body: 'b', head: 'h', base: 'base' },
    })
  })
})

describe('validGatewayTelemetry (Phase A shape-guard — never crash the resolver)', () => {
  it('accepts a well-formed telemetry object with user + tags', () => {
    const t = { user: 'user-1', tags: ['feature:coding_run', 'env:production'] }
    expect(validGatewayTelemetry(t)).toEqual(t)
  })

  it('accepts an absent user (tags-only attribution)', () => {
    const t = { tags: ['feature:coding_run'] }
    expect(validGatewayTelemetry(t)).toEqual({ tags: ['feature:coding_run'] })
  })

  it('strips extra keys, keeping only user + tags', () => {
    const guarded = validGatewayTelemetry({ user: 'u', tags: ['a'], evil: 'x' })
    expect(guarded).toEqual({ user: 'u', tags: ['a'] })
  })

  for (const bad of [
    undefined,
    null,
    'string',
    42,
    {},
    { tags: 'not-an-array' },
    { tags: [1, 2, 3] },
    { user: 42, tags: ['a'] },
    { user: {}, tags: ['a'] },
  ]) {
    it(`returns null for malformed input ${JSON.stringify(bad)} (falls back to plain model)`, () => {
      expect(validGatewayTelemetry(bad)).toBeNull()
    })
  }
})

describe('gitGateUrl', () => {
  afterEach(() => vi.unstubAllEnvs())

  it("is the app's PUBLIC origin's git gate, never the deployment URL (whose protection would need a bypass secret in the sandbox)", () => {
    vi.stubEnv('VERCEL_URL', 'dial8-abc123.vercel.app')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://app.example.com/')
    expect(gitGateUrl()).toBe('https://app.example.com/api/internal/agent-run/git')
  })

  it('falls back to the local app when no public origin is set, off Vercel', () => {
    vi.stubEnv('VERCEL', '')
    vi.stubEnv('VERCEL_URL', '')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(gitGateUrl()).toBe('http://localhost:3000/api/internal/agent-run/git')
  })

  it('is null on Vercel without a public origin (never the protected deployment URL)', () => {
    vi.stubEnv('VERCEL', '1')
    vi.stubEnv('VERCEL_URL', 'dial8-abc123.vercel.app')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(gitGateUrl()).toBeNull()
  })
})
