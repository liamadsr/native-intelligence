import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { LiveAgentSpec } from '../spec-client'

/**
 * agent.ts's dynamic MODEL resolver (LIVE-AGENT-DESIGN §3.3 / §5.2).
 *   1. subscribes to session.started (a task session IS one turn);
 *   2. returns the spec's Gateway slug — or, with valid gatewayTelemetry, the
 *      OBJECT selection form so per-user BYOK/cost attribution reaches every
 *      generation (the same shape chat/skill/work/coding agents return);
 *   3. on a spec failure THROWS — failing the session before its first model
 *      call — instead of running a turn with no prompt and no tools (see the
 *      FAILS CLOSED note in agent.ts);
 *   4. a turn on the person's own ChatGPT plan (spec.chatgptPlan, the free
 *      tier) runs every step on the plan model through the plan proxy, with
 *      this agent's own secret and the turn's token, never the Gateway.
 */
const fetchLiveAgentSpec = vi.fn<(t: string) => Promise<LiveAgentSpec | null>>()
const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => stateStore.set(name, fn(stateStore.has(name) ? (stateStore.get(name) as T) : initial())),
  }),
}))

vi.mock('../spec-client', async () => {
  const actual = await vi.importActual<typeof import('../spec-client')>('../spec-client')
  return {
    ...actual,
    fetchLiveAgentSpec: (t: string) => fetchLiveAgentSpec(t),
    runTokenFromAuth: () => 'tok.sig',
  }
})

import agent from '../../agent'

type Resolver = { events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<unknown>> }
const model = (agent as unknown as { model: Resolver }).model
const ctx = { session: { auth: {} } }

function spec(over: Partial<LiveAgentSpec> = {}): LiveAgentSpec {
  return {
    systemPrompt: 'p',
    model: 'anthropic/claude-sonnet-4.5',
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
  fetchLiveAgentSpec.mockReset()
  stateStore.clear()
})

describe('live-agent model resolver', () => {
  it('resolves at session.started; turn.started and step.started hand the same choice back', async () => {
    expect(Object.keys(model.events)).toEqual(['session.started', 'turn.started', 'step.started'])
    fetchLiveAgentSpec.mockResolvedValue(spec())
    const chosen = await model.events['session.started']({}, ctx)
    expect(await model.events['turn.started']({}, ctx)).toEqual(chosen)
    expect(await model.events['step.started']({}, ctx)).toEqual(chosen)
    // The spec was read once, at session.started.
    expect(fetchLiveAgentSpec).toHaveBeenCalledTimes(1)
  })

  it('returns the spec’s slug (the recipe → workspace chain is resolved server-side)', async () => {
    fetchLiveAgentSpec.mockResolvedValue(spec())
    expect(await model.events['session.started']({}, ctx)).toEqual({ model: 'anthropic/claude-sonnet-4.5', modelContextWindowTokens: 200_000 })
    expect(fetchLiveAgentSpec).toHaveBeenCalledWith('tok.sig')
  })

  it('returns the OBJECT form carrying providerOptions.gateway when telemetry is present', async () => {
    const gatewayTelemetry = { user: 'user-1', tags: ['feature:live_agent', 'env:development', 'runtime:eve'] }
    fetchLiveAgentSpec.mockResolvedValue(spec({ gatewayTelemetry }))
    expect(await model.events['session.started']({}, ctx)).toEqual({
      model: 'anthropic/claude-sonnet-4.5',
      modelContextWindowTokens: 200_000,
      modelOptions: { providerOptions: { gateway: gatewayTelemetry } },
    })
  })

  it('fails the session (throws) when the spec can’t be fetched — never a blind default', async () => {
    fetchLiveAgentSpec.mockResolvedValue(null)
    await expect(model.events['session.started']({}, ctx)).rejects.toThrow(/refusing to run the turn blind/)
  })

  it('fails the session when the spec carries no model', async () => {
    fetchLiveAgentSpec.mockResolvedValue(spec({ model: '' }))
    await expect(model.events['session.started']({}, ctx)).rejects.toThrow(/refusing to run the turn blind/)
  })

  it("runs a turn on the person's ChatGPT plan on the plan model, through the proxy with this agent's own secret", async () => {
    const env = { ...process.env }
    process.env.LIVE_AGENT_INTERNAL_SECRET = 'live-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'http://127.0.0.1:3002'
    delete process.env.VERCEL_URL
    const fetchMock = vi.fn(async () =>
      new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      fetchLiveAgentSpec.mockResolvedValue(spec({ model: 'openai/gpt-6-luna', webAccess: false, chatgptPlan: { model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'low' } }))
      // The session's selection is the guard: the Gateway may serve it from no host.
      expect(await model.events['session.started']({}, ctx)).toEqual({
        model: 'openai/gpt-6-luna',
        reasoning: 'low',
        modelContextWindowTokens: 250_000,
        modelOptions: { providerOptions: { gateway: { only: ['chatgpt-plan'] } } },
      })
      const step = (await model.events['step.started']({}, ctx)) as {
        model: { provider: string; modelId: string; doStream: (o: unknown) => Promise<unknown> }
        modelOptions: unknown
      }
      expect(step.model.provider).toBe('openai.chatgpt-plan.responses')
      expect(step.model.modelId).toBe('gpt-6-luna')
      expect(step.modelOptions).toEqual({ providerOptions: { openai: { store: false } } })
      await step.model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], providerOptions: { openai: { store: false } } })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('http://127.0.0.1:3002/api/internal/chatgpt-plan/v1/responses')
      const headers = new Headers(init.headers)
      expect(headers.get('x-live-agent-secret')).toBe('live-secret')
      expect(headers.get('x-live-agent-token')).toBe('tok.sig')
      expect(headers.get('authorization')).toBeNull()
    } finally {
      process.env = env
      vi.unstubAllGlobals()
    }
  })

  it("refuses a plan it can't read rather than run the turn on a Gateway model", async () => {
    fetchLiveAgentSpec.mockResolvedValue(spec({ chatgptPlan: { model: 'gpt-4o', helperModel: 'gpt-4o', reasoning: 'low' } }))
    await expect(model.events['session.started']({}, ctx)).rejects.toThrow(/ChatGPT plan this agent can't read/)
  })
})
