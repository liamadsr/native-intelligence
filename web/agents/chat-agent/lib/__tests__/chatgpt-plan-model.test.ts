import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ChatSpec } from '../spec-client'

/**
 * The ChatGPT free tier's model (lib/chatgpt-plan-model.ts): a turn whose spec
 * carries `chatgptPlan` runs every step on a live OpenAI Responses model that
 * calls the app's plan proxy, never the Gateway; a spec outage falls back to
 * the plan when the run token says so; the helper runs on the plan's lighter
 * model; and the turn-scope guard is one the Gateway refuses (checked live
 * 10-20: "No available providers match the 'only' filter: chatgpt-plan").
 * The chat's plan steps run on the search model, which eve reads as OpenAI's
 * own (its provider name up to the first dot), so the chat's web_search is
 * OpenAI's hosted search on the person's plan.
 */

const fetchChatSpec = vi.fn<(t: string, c: string) => Promise<ChatSpec | null>>()
let runToken = 'tok.sig'
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
    fetchChatSpec: (...a: [string, string]) => fetchChatSpec(...a),
    runTokenFromAuth: () => runToken,
    turnCtxFromAuth: () => 'ENC_CTX',
  }
})

import { chatModel, helperChatModel } from '../chat-model'
import { chatGptPlanProxy, modelSelectionFromSpec } from '../spec-client'
import { helperModelFor } from '../helper-models'
import { HELPER_MODEL_KEYS } from '../helpers'
import {
  CHATGPT_PLAN_PROVIDER,
  FALLBACK_CHATGPT_PLAN,
  PLAN_MODELS,
  chatGptPlanForTurn,
  chatgptPlanFromRunToken,
  planReportModelId,
  planSearchStepSelection,
  planStepSelection,
  planTurnSelection,
  validChatGptPlan,
} from '../chatgpt-plan-model'
import * as app from '@/lib/chatgpt/plan-models'
import { chatCompactionWindow } from '../compaction-window'

type Resolver = { events: Record<string, (e: unknown, ctx: { session: { auth: unknown }; messages?: unknown[] }) => Promise<unknown>> }
const resolver = (m: unknown) => m as Resolver
const ctx = { session: { auth: {} }, messages: [] }
const turnEvent = { data: { turnId: 'turn-1', sequence: 0, stepIndex: 1 } }
const plan = { model: 'gpt-6.1-sol', helperModel: 'gpt-6-luna', reasoning: 'low' }

function spec(over: Partial<ChatSpec> = {}): ChatSpec {
  return { systemPrompt: 'p', model: 'deepseek/deepseek-v4-flash', ceiling: null, ceilingTools: [], coreToolNames: [], ...over }
}

/** A run token as the mint signs it (the agent only reads the payload). */
function tokenWith(claims: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify({ userId: 'u1', exp: Date.now() + 60_000, ...claims })).toString('base64url')}.sig`
}

type LiveModel = { provider: string; modelId: string; doStream: (o: unknown) => Promise<unknown> }

beforeEach(() => {
  stateStore.clear()
  fetchChatSpec.mockReset()
  runToken = 'tok.sig'
})

describe('the plan resolver', () => {
  it('runs a plan turn on the guard at turn scope and the live plan model at every step', async () => {
    fetchChatSpec.mockResolvedValue(spec({ model: 'openai/gpt-6.1-sol', chatgptPlan: plan }))
    const turn = await resolver(chatModel).events['turn.started'](turnEvent, ctx)
    expect(turn).toEqual(planTurnSelection(validChatGptPlan(plan)!))
    const step = (await resolver(chatModel).events['step.started'](turnEvent, ctx)) as { model: LiveModel; modelOptions: unknown }
    expect(step.model.provider).toBe('openai.chatgpt-plan.responses')
    expect(step.model.modelId).toBe('gpt-6.1-sol')
    expect(step.modelOptions).toEqual({ providerOptions: { openai: { store: false } } })
  })

  it("puts the chat's plan steps on the model eve reads as OpenAI's own, so its web_search is OpenAI's", async () => {
    fetchChatSpec.mockResolvedValue(spec({ model: 'openai/gpt-6.1-sol', chatgptPlan: plan }))
    await resolver(chatModel).events['turn.started'](turnEvent, ctx)
    const step = (await resolver(chatModel).events['step.started'](turnEvent, ctx)) as { model: LiveModel }
    // eve's model profile and step id both take the provider up to its first dot.
    expect(step.model.provider.split('.')[0]).toBe('openai')
    expect(`${step.model.provider.split('.')[0]}/${step.model.modelId}`).toBe('openai/gpt-6.1-sol')
  })

  it("runs the helper on the plan's lighter model", async () => {
    fetchChatSpec.mockResolvedValue(spec({ model: 'openai/gpt-6.1-sol', chatgptPlan: plan }))
    await resolver(helperChatModel).events['turn.started'](turnEvent, ctx)
    const step = (await resolver(helperChatModel).events['step.started'](turnEvent, ctx)) as { model: LiveModel }
    expect(step.model.modelId).toBe('gpt-6-luna')
    expect(step.model.provider).toBe('openai.chatgpt-plan.responses')
  })

  it('falls back to the plan, never a Gateway model, when the spec fails and the token says plan', async () => {
    fetchChatSpec.mockResolvedValue(null)
    runToken = tokenWith({ chatgptPlan: true })
    expect(await resolver(chatModel).events['turn.started'](turnEvent, ctx)).toEqual(planTurnSelection(FALLBACK_CHATGPT_PLAN))
    const step = (await resolver(chatModel).events['step.started'](turnEvent, ctx)) as { model: LiveModel }
    expect(step.model.provider).toBe('openai.chatgpt-plan.responses')
  })

  it('keeps everyone else on Gateway models, and a paid turn after a plan turn leaves the plan', async () => {
    fetchChatSpec.mockResolvedValueOnce(spec({ model: 'openai/gpt-6.1-sol', chatgptPlan: plan }))
    await resolver(chatModel).events['turn.started'](turnEvent, ctx)
    fetchChatSpec.mockResolvedValueOnce(spec())
    expect(await resolver(chatModel).events['turn.started'](turnEvent, ctx)).toEqual(modelSelectionFromSpec(spec()))
    const step = (await resolver(chatModel).events['step.started'](turnEvent, ctx)) as { model: LiveModel | string }
    expect(typeof step.model === 'string' ? step.model : step.model.provider).not.toMatch(/chatgpt-plan/)
    // A spec outage without the claim falls to the thread's own model.
    fetchChatSpec.mockResolvedValueOnce(null)
    const fallback = (await resolver(chatModel).events['turn.started'](turnEvent, ctx)) as { model: string }
    expect(fallback.model).toBe('anthropic/claude-haiku-5.5')
  })

  it.each(HELPER_MODEL_KEYS.filter((k) => k !== 'flash'))("fails the %s helper closed on a plan turn: the guard, never a Gateway model", async (key) => {
    fetchChatSpec.mockResolvedValue(spec({ model: 'openai/gpt-6.1-sol', chatgptPlan: plan }))
    const model = helperModelFor(key)
    expect(await resolver(model).events['turn.started'](turnEvent, ctx)).toEqual(planTurnSelection(validChatGptPlan(plan)!))
    expect(resolver(model).events['step.started']).toBeUndefined()
  })
})

describe('the plan pieces', () => {
  it('guards the spec field', () => {
    expect(validChatGptPlan(plan)).toEqual(plan)
    expect(validChatGptPlan({ ...plan, model: 'openai/gpt-6.1-sol' })).toBeNull()
    expect(validChatGptPlan({ ...plan, helperModel: 'claude-sonnet-5.5' })).toBeNull()
    expect(validChatGptPlan({ ...plan, reasoning: 'max' })).toBeNull()
    expect(validChatGptPlan(null)).toBeNull()
  })

  it('reads the claim from the token payload only when it is exactly true', () => {
    expect(chatgptPlanFromRunToken(tokenWith({ chatgptPlan: true }))).toBe(true)
    expect(chatgptPlanFromRunToken(tokenWith({ chatgptPlan: 'yes' }))).toBe(false)
    expect(chatgptPlanFromRunToken(tokenWith({}))).toBe(false)
    expect(chatgptPlanFromRunToken('garbage')).toBe(false)
    expect(chatgptPlanFromRunToken('')).toBe(false)
  })

  it("trusts a spec that says no plan over the token's claim", () => {
    const claimed = tokenWith({ chatgptPlan: true })
    expect(chatGptPlanForTurn(spec(), claimed)).toBeNull()
    expect(chatGptPlanForTurn(null, claimed)).toEqual(FALLBACK_CHATGPT_PLAN)
    expect(chatGptPlanForTurn(spec({ chatgptPlan: { model: 'bogus' } }), claimed)).toEqual(FALLBACK_CHATGPT_PLAN)
    expect(chatGptPlanForTurn(null, 'tok.sig')).toBeNull()
  })

  it('pins the turn guard to a Gateway host that does not exist', () => {
    expect(planTurnSelection(FALLBACK_CHATGPT_PLAN).modelOptions).toEqual({ providerOptions: { gateway: { only: ['chatgpt-plan'] } } })
  })

  it('stays in step with the app (src/lib/chatgpt/plan-models.ts)', () => {
    expect(CHATGPT_PLAN_PROVIDER).toBe(app.CHATGPT_PLAN_PROVIDER)
    expect([...PLAN_MODELS].sort()).toEqual([...app.PLAN_MODELS].sort())
    expect(FALLBACK_CHATGPT_PLAN).toEqual(app.chatGptPlanSpec('fast'))
    expect(planTurnSelection(FALLBACK_CHATGPT_PLAN).modelContextWindowTokens).toBe(chatCompactionWindow(app.PLAN_CONTEXT_WINDOW_TOKENS))
  })
})

describe('the live plan model', () => {
  const env = { ...process.env }
  afterEach(() => {
    process.env = { ...env }
    vi.unstubAllGlobals()
  })

  it('calls the plan proxy with the run token and secret on the fetch, never a key, with store:false', async () => {
    process.env.CHAT_INTERNAL_SECRET = 'chat-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'http://127.0.0.1:3002'
    const fetchMock = vi.fn(async () =>
      new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const step = planStepSelection(FALLBACK_CHATGPT_PLAN, chatGptPlanProxy('run.token'), 'main')
    await (step.model as unknown as LiveModel).doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      providerOptions: step.modelOptions.providerOptions,
    })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:3002/api/internal/chatgpt-plan/v1/responses')
    const headers = new Headers(init.headers)
    expect(headers.get('x-chat-run-secret')).toBe('chat-secret')
    expect(headers.get('x-chat-run-token')).toBe('run.token')
    expect(headers.get('authorization')).toBeNull()
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true })
  })

  it("sends OpenAI's web search from the search model, through the same proxy and credentials", async () => {
    process.env.CHAT_INTERNAL_SECRET = 'chat-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'http://127.0.0.1:3002'
    const fetchMock = vi.fn(async () =>
      new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const step = planSearchStepSelection(FALLBACK_CHATGPT_PLAN, chatGptPlanProxy('run.token'), 'main')
    // The provider tool eve adds to an OpenAI model's web_search slot.
    await (step.model as unknown as LiveModel).doStream({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ type: 'provider', id: 'openai.web_search', name: 'web_search', args: {} }],
      providerOptions: step.modelOptions.providerOptions,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:3002/api/internal/chatgpt-plan/v1/responses')
    expect(new Headers(init.headers).get('x-chat-run-token')).toBe('run.token')
    expect(new Headers(init.headers).get('authorization')).toBeNull()
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ model: 'gpt-6.1-sol', store: false, stream: true })
    expect(body.tools).toEqual([expect.objectContaining({ type: 'web_search' })])
  })

  it("names a search step under the plan's own name for the run's plan models only", () => {
    expect(planReportModelId('openai/gpt-6.1-sol', FALLBACK_CHATGPT_PLAN)).toBe('chatgpt-plan/gpt-6.1-sol')
    expect(planReportModelId('openai/gpt-6-luna', FALLBACK_CHATGPT_PLAN)).toBe('chatgpt-plan/gpt-6-luna')
    expect(planReportModelId('openai/gpt-5.6-sol', FALLBACK_CHATGPT_PLAN)).toBe('openai/gpt-5.6-sol')
    expect(planReportModelId('chatgpt-plan/gpt-6.1-sol', FALLBACK_CHATGPT_PLAN)).toBe('chatgpt-plan/gpt-6.1-sol')
    expect(planReportModelId('openai/gpt-6.1-sol', null)).toBe('openai/gpt-6.1-sol')
    expect(planReportModelId(null, FALLBACK_CHATGPT_PLAN)).toBeNull()
  })
})
