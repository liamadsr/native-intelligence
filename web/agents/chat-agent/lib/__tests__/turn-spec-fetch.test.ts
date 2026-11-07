import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'

/**
 * A turn fetches its spec ONCE (chat-ttft P2). eve runs a new chat's
 * session.started tools resolver, then the turn.started usage gate, model,
 * persona and turn-context resolvers, then a step.started tools resolver per
 * model call, in one process. Every one of them reads the same spec, and each fetch is a full
 * rebuild on the app side (it was five before the first model call). Here they
 * all run for real against the REAL spec-client over a stubbed fetch: one GET
 * of the superset variant, and each still gets what it reads.
 */

// In-memory defineState so the tools resolver's discovery state works without an eve runtime.
const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => {
      const prev = stateStore.has(name) ? (stateStore.get(name) as T) : initial()
      stateStore.set(name, fn(prev))
    },
  }),
}))

import agent from '../../agent'
import persona from '../../instructions/persona'
import turnContext from '../../instructions/turn-context'
import gate from '../../hooks/usage-limit-gate'
import workspaceTools from '../../tools/workspace_tools'
import { resetSpecMemoForTests, type ChatSpec } from '../spec-client'

type Handler = (event: unknown, ctx: unknown) => Promise<unknown>
const events = (m: unknown) => (m as { events: Record<string, Handler> }).events
const model = (agent as unknown as { model: unknown }).model
type ToolMap = Record<string, { execute: (input: unknown) => Promise<unknown>; inputSchema?: unknown }>

const auth = { current: { attributes: { chatRunToken: 'tok.sig', chatRunCtx: 'ENC_CTX' } } }
const ctx = { session: { auth }, messages: [] }

const FIND_SCHEMA = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
const SPEC: ChatSpec = {
  systemPrompt: 'THE LAYERED PROMPT\n\n## Available skills\n- recap: Weekly recap.',
  model: 'deepseek/deepseek-v4-pro',
  ceiling: null,
  ceilingTools: [
    { name: 'find', description: 'Unified retrieval.', inputSchema: FIND_SCHEMA },
    { name: 'create_email_draft', description: 'Draft an email to a contact.', inputSchema: { type: 'object' } },
  ],
  coreToolNames: ['find'],
  skills: [{ name: 'recap', description: 'Weekly recap.', markdown: 'RECAP_PLAYBOOK' }],
  modelPolicy: { reasoning: 'none', contextWindowTokens: 1_000_000 },
  turnContext: [{ key: 'time', markdown: 'Current date and time: Wednesday, September 30, 2026 at 10:05 AM EDT' }],
}

let fetchSpy: MockInstance<typeof fetch>
const specGets = () =>
  fetchSpy.mock.calls.map((c) => String(c[0])).filter((url) => url.includes('/api/internal/chat/spec'))

beforeEach(() => {
  process.env.CHAT_INTERNAL_SECRET = 'secret'
  process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'
  resetSpecMemoForTests()
  stateStore.clear()
  fetchSpy = vi.spyOn(global, 'fetch').mockImplementation(async () => new Response(JSON.stringify(SPEC), { status: 200 }))
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
  delete process.env.NEXT_PUBLIC_APP_URL
  vi.restoreAllMocks()
})

describe('a turn fetches its spec once', () => {
  it('a new chat: session tools, the gate, model, persona and every step share one GET; load_skill fetches its own', async () => {
    const sessionTools = (await events(workspaceTools)['session.started']({}, ctx)) as ToolMap
    await events(gate)['turn.started']({}, ctx)
    const selection = await events(model)['turn.started']({}, ctx)
    const instructions = (await events(persona)['turn.started']({}, ctx)) as { content: string }
    const context = (await events(turnContext)['turn.started']({}, ctx)) as { content: string; role: string }
    const step1 = (await events(workspaceTools)['step.started']({}, ctx)) as ToolMap
    // The model discovers a tool, loads a skill, and steps again.
    await sessionTools.search_tools.execute({ query: 'email draft' })
    const loaded = await sessionTools.load_skill.execute({ skill: 'recap' })
    const step2 = (await events(workspaceTools)['step.started']({}, ctx)) as ToolMap

    expect(specGets()).toEqual([
      'https://app.test/api/internal/chat/spec?skills=1&schemas=1&turnContext=1&ctx=ENC_CTX',
      // load_skill, fresh and on demand: a skill made earlier in the turn loads.
      'https://app.test/api/internal/chat/spec?skills=1&ctx=ENC_CTX',
    ])
    // Each consumer still reads what it needs off the one superset spec.
    expect(selection).toMatchObject({ model: 'deepseek/deepseek-v4-pro', reasoning: 'none' })
    expect(instructions.content).toBe(SPEC.systemPrompt)
    expect(context).toMatchObject({ role: 'user', content: expect.stringContaining('<section key="time"') })
    expect(sessionTools.find.inputSchema).toEqual(FIND_SCHEMA)
    expect(Object.keys(step1)).not.toContain('create_email_draft')
    expect(Object.keys(step2)).toContain('create_email_draft')
    expect(loaded).toMatchObject({ skill: 'recap', instructions: 'RECAP_PLAYBOOK' })
  })

  it('a later turn (a new run token) fetches afresh, once', async () => {
    await events(gate)['turn.started']({}, ctx)
    const next = { session: { auth: { current: { attributes: { chatRunToken: 'tok2.sig', chatRunCtx: 'ENC_CTX_2' } } } } }
    await events(gate)['turn.started']({}, next)
    await events(model)['turn.started']({}, next)
    await events(persona)['turn.started']({}, next)
    await events(turnContext)['turn.started']({}, { ...next, messages: [] })
    await events(workspaceTools)['step.started']({}, next)
    expect(specGets()).toEqual([
      'https://app.test/api/internal/chat/spec?skills=1&schemas=1&turnContext=1&ctx=ENC_CTX',
      'https://app.test/api/internal/chat/spec?skills=1&schemas=1&turnContext=1&ctx=ENC_CTX_2',
    ])
  })

  it('a usage block still stops the turn at the gate, and the resolvers do not reuse it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchSpy
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Usage limit exceeded', reason: 'monthly allowance reached' }), {
          status: 429,
        }),
      )
      .mockImplementation(async () => new Response(JSON.stringify(SPEC), { status: 200 }))
    // eve 0.68+ ignores a hook throw: the gate cancels the turn instead.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const cancel = vi.fn()
    await events(gate)['turn.started']({}, { ...ctx, cancel })
    expect(cancel).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(warn.mock.calls.at(-1))).toMatch(/monthly allowance reached/)
    // A 429 is never memoized: a resolver that ran anyway would fetch again.
    expect(await events(model)['turn.started']({}, ctx)).toMatchObject({ model: 'deepseek/deepseek-v4-pro' })
    expect(specGets()).toHaveLength(2)
  })
})
