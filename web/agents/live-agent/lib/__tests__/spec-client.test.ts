import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SessionAuth } from 'eve/context'
import {
  SPEC_FETCH_TIMEOUT_MS,
  TOOL_DISPATCH_TIMEOUT_MS,
  dispatchLiveAgentTool,
  fetchLiveAgentSpec,
  modelSelectionFromSpec,
  resetLiveAgentSpecCache,
  runTokenFromAuth,
  validGatewayTelemetry,
  type LiveAgentSpec,
} from '../spec-client'

/**
 * The spec-client is the live-agent mount's ONLY link to the Next app. Pinned:
 * the auth-attribute reader, the spec fetch (headers, always ?schemas=1, secret
 * fallback, a timeout, null on failure, one shared fetch per run token), the
 * tool dispatch (structured error passthrough, a timeout), and the model
 * selection (Gateway slug; OBJECT form with per-user attribution).
 */

const SECRET = 'live-secret'

function spec(over: Partial<LiveAgentSpec> = {}): LiveAgentSpec {
  return {
    systemPrompt: 'p',
    model: 'deepseek/deepseek-v4-flash',
    ceiling: [],
    ceilingTools: [],
    coreToolNames: [],
    assistOnly: false,
    pairNotes: false,
    webAccess: true,
    ...over,
  }
}

beforeEach(() => {
  resetLiveAgentSpecCache()
  process.env.LIVE_AGENT_INTERNAL_SECRET = SECRET
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
})
afterEach(() => {
  delete process.env.LIVE_AGENT_INTERNAL_SECRET
  delete process.env.RUN_SKILL_INTERNAL_SECRET
  delete process.env.NEXT_PUBLIC_APP_URL
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('runTokenFromAuth', () => {
  it('reads the stamped run token, or "" when absent/non-string', () => {
    const auth = (attrs: Record<string, unknown>) => ({ current: { attributes: attrs } }) as unknown as SessionAuth
    expect(runTokenFromAuth(auth({ runToken: 'tok.sig' }))).toBe('tok.sig')
    expect(runTokenFromAuth(auth({}))).toBe('')
    expect(runTokenFromAuth(auth({ runToken: 7 }))).toBe('')
    expect(runTokenFromAuth({} as SessionAuth)).toBe('')
  })
})

describe('modelSelectionFromSpec (the model resolver mapping)', () => {
  it('passes a Gateway slug through as a bare string when attribution is off (a known model adds its window)', () => {
    expect(modelSelectionFromSpec(spec({ model: 'acme/mystery-1' }))).toBe('acme/mystery-1')
    expect(modelSelectionFromSpec(spec({ model: 'anthropic/claude-haiku-4.5' }))).toEqual({ model: 'anthropic/claude-haiku-4.5', modelContextWindowTokens: 200_000 })
  })

  it('returns the OBJECT selection form when valid gatewayTelemetry is present', () => {
    const telemetry = { user: 'user-1', tags: ['feature:live_agent', 'runtime:eve'] }
    expect(modelSelectionFromSpec(spec({ gatewayTelemetry: telemetry }))).toEqual({
      model: 'deepseek/deepseek-v4-flash',
      modelContextWindowTokens: 600_000,
      modelOptions: { providerOptions: { gateway: telemetry } },
    })
  })

  it('degrades malformed telemetry to the bare slug (never crash the resolver)', () => {
    expect(modelSelectionFromSpec(spec({ model: 'acme/mystery-1', gatewayTelemetry: { tags: 'x' } as never }))).toBe('acme/mystery-1')
    expect(validGatewayTelemetry({ user: 5, tags: [] })).toBeNull()
    expect(validGatewayTelemetry({ tags: ['a'] })).toEqual({ tags: ['a'] })
  })

  it('prefixes a bare id with anthropic/ and is null without a model', () => {
    expect(modelSelectionFromSpec(spec({ model: 'claude-x' }))).toBe('anthropic/claude-x')
    expect(modelSelectionFromSpec(spec({ model: '' }))).toBeNull()
    expect(modelSelectionFromSpec(null)).toBeNull()
  })
})

describe('fetchLiveAgentSpec', () => {
  it('GETs the spec route — always with real schemas — with the secret + token headers and a timeout', async () => {
    const fetchMock = vi.fn(async () => Response.json(spec()))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchLiveAgentSpec('tok.sig')).toEqual(spec())
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://app.test/api/internal/live-agent/spec?schemas=1')
    expect(init.headers).toMatchObject({ 'x-live-agent-secret': SECRET, 'x-live-agent-token': 'tok.sig' })
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(SPEC_FETCH_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })

  it('a hung spec route is abandoned at the timeout (null, logged)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('t', 'TimeoutError')))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        init.signal?.throwIfAborted()
        return Response.json(spec())
      }),
    )
    expect(await fetchLiveAgentSpec('tok.sig')).toBeNull()
    expect(timeout).toHaveBeenCalledWith(SPEC_FETCH_TIMEOUT_MS)
  })

  it('uses the RUN_SKILL_INTERNAL_SECRET fallback', async () => {
    delete process.env.LIVE_AGENT_INTERNAL_SECRET
    process.env.RUN_SKILL_INTERNAL_SECRET = 'root'
    const fetchMock = vi.fn(async () => Response.json(spec()))
    vi.stubGlobal('fetch', fetchMock)
    await fetchLiveAgentSpec('tok.sig')
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ 'x-live-agent-secret': 'root' })
  })

  it('is null (logged) on no token, a non-2xx, a network error, or no secret', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await fetchLiveAgentSpec('')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
    expect(await fetchLiveAgentSpec('tok.sig')).toBeNull()
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect(await fetchLiveAgentSpec('tok.sig')).toBeNull()
    delete process.env.LIVE_AGENT_INTERNAL_SECRET
    expect(await fetchLiveAgentSpec('tok.sig')).toBeNull()
  })

  it('every resolver of one turn shares ONE fetch (concurrent and repeat calls)', async () => {
    const fetchMock = vi.fn(async () => Response.json(spec()))
    vi.stubGlobal('fetch', fetchMock)
    const [a, b, c] = await Promise.all([
      fetchLiveAgentSpec('tok.sig'),
      fetchLiveAgentSpec('tok.sig'),
      fetchLiveAgentSpec('tok.sig'),
    ])
    expect(await fetchLiveAgentSpec('tok.sig')).toEqual(spec())
    expect([a, b, c]).toEqual([spec(), spec(), spec()])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('never serves one token’s spec to another (a copilot and a notes turn back to back)', async () => {
    const byToken: Record<string, LiveAgentSpec> = {
      'copilot.sig': spec({ ceiling: ['say_to_user', 'propose_change'] }),
      'notes.sig': spec({ ceiling: ['propose_change'] }),
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) =>
        Response.json(byToken[(init.headers as Record<string, string>)['x-live-agent-token']]),
      ),
    )
    const [copilot, notes] = await Promise.all([fetchLiveAgentSpec('copilot.sig'), fetchLiveAgentSpec('notes.sig')])
    expect(copilot!.ceiling).toContain('say_to_user')
    expect(notes!.ceiling).not.toContain('say_to_user')
    expect((await fetchLiveAgentSpec('copilot.sig'))!.ceiling).toContain('say_to_user')
    expect((await fetchLiveAgentSpec('notes.sig'))!.ceiling).not.toContain('say_to_user')
  })

  it('does not cache a failure — the next call retries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const fetchMock = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValue(Response.json(spec()))
    vi.stubGlobal('fetch', fetchMock)
    expect(await fetchLiveAgentSpec('tok.sig')).toBeNull()
    expect(await fetchLiveAgentSpec('tok.sig')).toEqual(spec())
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('re-fetches once the cached spec is older than the TTL', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const fetchMock = vi.fn(async () => Response.json(spec()))
      vi.stubGlobal('fetch', fetchMock)
      await fetchLiveAgentSpec('tok.sig')
      vi.setSystemTime(Date.now() + 6 * 60 * 1000)
      await fetchLiveAgentSpec('tok.sig')
      expect(fetchMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('dispatchLiveAgentTool', () => {
  it('POSTs { toolName, input } and returns the output', async () => {
    const fetchMock = vi.fn(async () => Response.json({ output: { ok: 1 } }))
    vi.stubGlobal('fetch', fetchMock)
    expect(await dispatchLiveAgentTool('search_contacts', 'tok.sig', { query: 'a' })).toEqual({ ok: 1 })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://app.test/api/internal/live-agent/tool')
    expect(JSON.parse(init.body as string)).toEqual({ toolName: 'search_contacts', input: { query: 'a' } })
    expect(init.headers).toMatchObject({ 'x-live-agent-token': 'tok.sig' })
  })

  it('throws the route’s structured error (code + Zod details) so the model can adapt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({ error: 'input failed tool schema validation', code: 'INPUT_INVALID', details: 'query: expected string' }, { status: 400 }),
      ),
    )
    await expect(dispatchLiveAgentTool('search_contacts', 'tok.sig', {})).rejects.toThrow(
      'search_contacts: input failed tool schema validation [INPUT_INVALID] — query: expected string',
    )
  })

  it('bounds the dispatch with a timeout, and a timed-out call warns against a blind retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort(new DOMException('t', 'TimeoutError')))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        init.signal?.throwIfAborted()
        return Response.json({ output: 1 })
      }),
    )
    await expect(dispatchLiveAgentTool('propose_change', 'tok.sig', {})).rejects.toThrow(/may still have gone through/)
    expect(timeout).toHaveBeenCalledWith(TOOL_DISPATCH_TIMEOUT_MS)
  })

  it('refuses without a run token and surfaces a network failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(dispatchLiveAgentTool('x', '', {})).rejects.toThrow(/NO_RUN_TOKEN/)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('boom') }))
    await expect(dispatchLiveAgentTool('x', 'tok.sig', {})).rejects.toThrow(/failed to reach the workspace/)
  })
})
