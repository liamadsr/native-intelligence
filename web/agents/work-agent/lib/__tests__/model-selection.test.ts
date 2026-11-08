import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EveSpec } from '../spec-client'
import { deepseekSurfacePolicy, gatewayModelSlug } from '@/lib/ai/models'
import { COMPACTION_WINDOW_TOKENS } from '../model-policy'

/**
 * The work-agent's model resolver (agent.ts): a work run on DeepSeek thinks at its
 * default effort, on private hosts (the spec's modelPolicy,
 * deepseekSurfacePolicy 'on'); any other model is called as before; and with
 * no spec the resolver throws, so the session fails before its first model
 * call instead of running with no prompt and no tools. Each selection is run
 * through eve's own resolveRuntimeModelSelection, since an invalid one fails
 * the session.
 */
const fetchEveSpec = vi.fn<(t: string) => Promise<EveSpec | null>>()
const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => stateStore.set(name, fn(stateStore.has(name) ? (stateStore.get(name) as T) : initial())),
  }),
}))

const token = vi.hoisted(() => ({ value: 'tok.sig' }))

vi.mock('../spec-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spec-client')>()),
  fetchEveSpec: (t: string) => fetchEveSpec(t),
  runTokenFromAuth: () => token.value,
}))

import agent from '../../agent'

const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
type Reference = { id: string; contextWindowTokens?: number; reasoning?: string; providerOptions?: Record<string, unknown> }
async function resolveWithEve(selection: unknown): Promise<Reference> {
  const { resolveRuntimeModelSelection } = (await import(
    pathToFileURL(join(eveRoot, 'dist/src/runtime/agent/resolve-model.js')).href
  )) as { resolveRuntimeModelSelection: (a: unknown) => Promise<{ reference: Reference }> }
  const catalog = { getByGatewayId: vi.fn(async () => null), getByProviderModelId: vi.fn(async () => null) }
  const { reference } = await resolveRuntimeModelSelection({
    selection,
    state: { get: vi.fn(), set: vi.fn() },
    catalog,
    durability: 'durable',
  })
  return reference
}

type Resolver = { events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<unknown>> }
const resolve = () => (agent as unknown as { model: Resolver }).model.events['session.started']({}, { session: { auth: {} } })
const TELEMETRY = { user: 'user-1', tags: ['feature:work_run', 'env:development', 'runtime:eve'] }

/** The spec the Next side sends for `id`, as the agent receives it (JSON). */
function specFor(id: string, withTelemetry: boolean): EveSpec {
  const modelPolicy = deepseekSurfacePolicy(id, 'on')
  return JSON.parse(
    JSON.stringify({
      systemPrompt: 'p',
      model: gatewayModelSlug(id),
      ceilingTools: [],
      ...(withTelemetry ? { gatewayTelemetry: TELEMETRY } : {}),
      ...(modelPolicy ? { modelPolicy } : {}),
    }),
  ) as EveSpec
}

beforeEach(() => {
  fetchEveSpec.mockReset()
  token.value = 'tok.sig'
  stateStore.clear()
})

describe('work-agent model resolver — DeepSeek thinking and hosts', () => {
  for (const id of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    for (const withTelemetry of [true, false]) {
      it(`${id} (telemetry: ${withTelemetry}): thinking on, private hosts, and eve accepts it`, async () => {
        fetchEveSpec.mockResolvedValue(specFor(id, withTelemetry))
        const selection = await resolve()
        const policy = deepseekSurfacePolicy(id, 'on')!
        const reference = await resolveWithEve(selection)
        expect(reference.id).toBe(gatewayModelSlug(id))
        expect(reference.reasoning).toBe('high')
        // The 1M window is capped at the 600K ceiling: the session compacts at 540K, like chat.
        expect(policy.contextWindowTokens).toBeGreaterThan(COMPACTION_WINDOW_TOKENS)
        expect(reference.contextWindowTokens).toBe(COMPACTION_WINDOW_TOKENS)
        expect(reference.providerOptions).toEqual({
          deepseek: { thinking: { type: 'enabled' } },
          gateway: { ...(withTelemetry ? TELEMETRY : {}), ...policy.gateway },
        })
      })
    }
  }

  it('any other model keeps its call, plus the compaction ceiling: its real window, capped at 600K', async () => {
    fetchEveSpec.mockResolvedValue(specFor('claude-sonnet-4-5-20250929', false))
    expect(await resolve()).toEqual({ model: 'anthropic/claude-sonnet-4.5', modelContextWindowTokens: 200_000 })
    fetchEveSpec.mockResolvedValue(specFor('claude-sonnet-5-5', true))
    const selection = await resolve()
    expect(selection).toEqual({ model: 'anthropic/claude-sonnet-5.5', modelContextWindowTokens: 600_000, modelOptions: { providerOptions: { gateway: TELEMETRY } } })
    // eve takes it: a 1M non-DeepSeek model compacts at 540K, not 900K.
    expect((await resolveWithEve(selection)).contextWindowTokens).toBe(600_000)
  })

  it('a model of unknown window is called exactly as before (eve keeps its own window)', async () => {
    fetchEveSpec.mockResolvedValue({ ...specFor('claude-sonnet-5-5', false), model: 'acme/mystery-1' } as never)
    expect(await resolve()).toBe('acme/mystery-1')
  })

  it('caps the window eve compacts against at 600K and keeps a smaller one', async () => {
    for (const [window, handed] of [[1_000_000, 600_000], [600_000, 600_000], [262_000, 262_000], [200_000, 200_000]]) {
      fetchEveSpec.mockResolvedValue({ ...specFor('claude-sonnet-5-5', false), modelPolicy: { contextWindowTokens: window } } as never)
      const selection = await resolve()
      expect(selection).toEqual({ model: 'anthropic/claude-sonnet-5.5', modelContextWindowTokens: handed })
      expect((await resolveWithEve(selection)).contextWindowTokens).toBe(handed)
    }
  })

  it('a malformed policy is dropped, not thrown on', async () => {
    fetchEveSpec.mockResolvedValue({ ...specFor('deepseek-v4-flash', false), modelPolicy: { reasoning: 'max', gateway: { only: [] } } } as never)
    // Its known window still applies.
    expect(await resolve()).toEqual({ model: 'deepseek/deepseek-v4-flash', modelContextWindowTokens: 600_000 })
  })

  it('fails closed without a spec: no run token, or a fetch that failed, and the resolver throws', async () => {
    token.value = ''
    fetchEveSpec.mockResolvedValue(null)
    await expect(resolve()).rejects.toThrow(/refusing to run the work blind/)
    // A spec route that answered 500, or a fetch that errored: fetchEveSpec answers null.
    token.value = 'tok.sig'
    fetchEveSpec.mockResolvedValue(null)
    await expect(resolve()).rejects.toThrow(/refusing to run the work blind/)
    expect(fetchEveSpec).toHaveBeenLastCalledWith('tok.sig')
  })

  it('refuses a spec that names no model the same way', async () => {
    fetchEveSpec.mockResolvedValue({ ...specFor('deepseek-v4-flash', true), model: '' } as never)
    await expect(resolve()).rejects.toThrow(/refusing to run the work blind/)
  })
})

/** A run token as the app signs it (the agent reads only the payload). */
function tokenWith(claims: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify({ exp: Date.now() + 60_000, ...claims })).toString('base64url')}.sig`
}

type Events = Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<unknown>>
const events = () => (agent as unknown as { model: { events: Events } }).model.events
const ctx = { session: { auth: {} } }
const PLAN = { model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'medium' }
const GUARD = {
  model: 'openai/gpt-6-luna',
  reasoning: 'medium',
  modelContextWindowTokens: 250_000,
  modelOptions: { providerOptions: { gateway: { only: ['chatgpt-plan'] } } },
}
type LiveStep = { model: { provider: string; modelId: string; doStream: (o: unknown) => Promise<unknown> }; modelOptions: unknown }

describe('work-agent model resolver — the person\'s own ChatGPT plan (the free tier)', () => {
  it('a plan spec: the session holds the Gateway guard, and every step runs the plan model through the proxy with this agent\'s own secret', async () => {
    const env = { ...process.env }
    process.env.AGENT_RUN_INTERNAL_SECRET = 'agent-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'http://127.0.0.1:3002'
    delete process.env.VERCEL_URL
    const fetchMock = vi.fn(async () =>
      new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      fetchEveSpec.mockResolvedValue({ ...specFor('deepseek-v4-flash', true), model: 'openai/gpt-6-luna', chatgptPlan: PLAN } as never)
      expect(await events()['session.started']({}, ctx)).toEqual(GUARD)
      expect(await events()['turn.started']({}, ctx)).toEqual(GUARD)
      const step = (await events()['step.started']({}, ctx)) as LiveStep
      expect(step.model.provider).toBe('openai.chatgpt-plan.responses')
      expect(step.model.modelId).toBe('gpt-6-luna')
      expect(step.modelOptions).toEqual({ providerOptions: { openai: { store: false } } })
      await step.model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], providerOptions: { openai: { store: false } } })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('http://127.0.0.1:3002/api/internal/chatgpt-plan/v1/responses')
      const headers = new Headers(init.headers)
      expect(headers.get('x-agent-run-secret')).toBe('agent-secret')
      expect(headers.get('x-agent-run-token')).toBe('tok.sig')
      expect(headers.get('authorization')).toBeNull()
      // The spec was read once, at session.started.
      expect(fetchEveSpec).toHaveBeenCalledTimes(1)
    } finally {
      process.env = env
      vi.unstubAllGlobals()
    }
  })

  it('a Gateway session hands its own selection back at every turn and step, unchanged', async () => {
    fetchEveSpec.mockResolvedValue(specFor('deepseek-v4-flash', true))
    const chosen = await events()['session.started']({}, ctx)
    expect(await events()['turn.started']({}, ctx)).toEqual(chosen)
    expect(await events()['step.started']({}, ctx)).toEqual(chosen)
    expect(fetchEveSpec).toHaveBeenCalledTimes(1)
  })

  it('a later turn moves a Gateway session onto the plan once its person is on it; a spec it cannot read keeps the session as it was', async () => {
    fetchEveSpec.mockResolvedValue(specFor('deepseek-v4-flash', false))
    const chosen = await events()['session.started']({}, ctx)
    token.value = tokenWith({ agentRunId: 'r1', workspaceId: 'w1', userId: 'u1', resume: true })
    fetchEveSpec.mockResolvedValue(null)
    expect(await events()['turn.started']({}, ctx)).toEqual(chosen)
    fetchEveSpec.mockResolvedValue({ ...specFor('deepseek-v4-flash', false), model: 'openai/gpt-6-luna', chatgptPlan: PLAN } as never)
    expect(await events()['turn.started']({}, ctx)).toEqual(GUARD)
    expect(((await events()['step.started']({}, ctx)) as LiveStep).model.provider).toBe('openai.chatgpt-plan.responses')
  })

  it('a plan session never moves back to the Gateway', async () => {
    fetchEveSpec.mockResolvedValue({ ...specFor('deepseek-v4-flash', false), model: 'openai/gpt-6-luna', chatgptPlan: PLAN } as never)
    await events()['session.started']({}, ctx)
    token.value = tokenWith({ agentRunId: 'r1', workspaceId: 'w1', userId: 'u1', resume: true })
    fetchEveSpec.mockResolvedValue(specFor('deepseek-v4-flash', false))
    expect(await events()['turn.started']({}, ctx)).toEqual(GUARD)
  })

  it('a session started before this resolver kept nothing: its first step reads the spec once', async () => {
    fetchEveSpec.mockResolvedValue(specFor('deepseek-v4-flash', false))
    const step = await events()['step.started']({}, ctx)
    expect(step).toEqual(await resolve())
    expect(await events()['step.started']({}, ctx)).toEqual(step)
    expect(fetchEveSpec).toHaveBeenCalledTimes(2)
  })

  it("refuses a plan it can't read rather than run on a Gateway model Native Intelligence pays for", async () => {
    fetchEveSpec.mockResolvedValue({ ...specFor('deepseek-v4-flash', false), chatgptPlan: { model: 'gpt-4o', helperModel: 'gpt-4o', reasoning: 'low' } } as never)
    await expect(resolve()).rejects.toThrow(/ChatGPT plan this agent can't read/)
  })

  it('still fails closed without a spec', async () => {
    fetchEveSpec.mockResolvedValue(null)
    await expect(events()['step.started']({}, ctx)).rejects.toThrow(/refusing to run the work blind/)
  })
})
