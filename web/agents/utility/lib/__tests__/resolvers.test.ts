/**
 * The utility agent's dynamic resolvers — the glue between the spec route and
 * the session. The route tests prove what the spec SAYS; these prove it
 * reaches the session.
 *
 * Pinned:
 *   - FAIL CLOSED: with no spec, the session-level model resolver, the
 *     step-level model resolver AND the instructions resolver each throw on
 *     their own (the spec memo can evict or drop a failure between them, so
 *     no resolver may lean on another having failed first);
 *   - the kind's system prompt reaches the session as its instructions,
 *     byte-for-byte; a kind with no prompt (generate_title) contributes none;
 *   - provider options (Gateway telemetry, a drafting kind's DeepSeek no-thinking)
 *     ride the model selection;
 *   - a kind with an output cap gets, at step.started, a Gateway model wrapped
 *     so the model call itself carries maxOutputTokens ≤ the cap — proven on
 *     the object the resolver RETURNS (gateway() is mocked to hand back a
 *     MockLanguageModelV4 we can inspect); every kind also enforces the utility
 *     tool contract through the same supported wrapper;
 *   - the STEP CEILING: step.started throws once the event's stepIndex
 *     reaches the spec's maxSteps (1 text / 2 structured; 1 when absent), and
 *     on an event with no readable stepIndex.
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { wrapLanguageModel } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import type { UtilitySpec } from '../spec-client'

const fetchUtilitySpec = vi.fn<(t: string) => Promise<UtilitySpec | null>>()

function mockInner() {
  return new MockLanguageModelV4({
    provider: 'gateway',
    modelId: 'deepseek/deepseek-v4-flash',
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
      },
      warnings: [],
    }),
  })
}

const gw = vi.hoisted(() => ({
  gateway: vi.fn(),
}))

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  gateway: (id: string) => gw.gateway(id),
}))

vi.mock('../spec-client', async () => {
  const actual = await vi.importActual<typeof import('../spec-client')>('../spec-client')
  return {
    ...actual,
    fetchUtilitySpec: (t: string) => fetchUtilitySpec(t),
    runTokenFromAuth: () => 'tok.sig',
  }
})

import agent from '../../agent'
import kindInstructions from '../../instructions/kind'
import { outputCapMiddleware } from '../spec-client'

type Resolver = { events: Record<string, (e: unknown, ctx: { session: { auth: unknown } }) => Promise<unknown>> }
const model = (agent as unknown as { model: Resolver }).model
const instructions = kindInstructions as unknown as Resolver
const ctx = { session: { auth: {} } }
/** The event eve 0.66.3's harness dispatches to a step.started resolver. */
const stepEvent = (stepIndex: number) => ({ type: 'step.started', data: { sequence: 3, stepIndex, turnId: 't-1' } })

function spec(over: Partial<UtilitySpec> = {}): UtilitySpec {
  return { kind: 'generate_title', model: 'deepseek/deepseek-v4-flash', systemPrompt: 'You name chats.', ...over }
}

beforeEach(() => {
  fetchUtilitySpec.mockReset()
  gw.gateway.mockReset()
  gw.gateway.mockImplementation(() => mockInner())
})

describe('utility agent — model resolvers', () => {
  it('resolves at session.started and step.started', () => {
    expect(Object.keys(model.events).sort()).toEqual(['session.started', 'step.started'])
  })

  it.each(['session.started', 'step.started'])('%s throws when the spec cannot be fetched', async (event) => {
    fetchUtilitySpec.mockResolvedValue(null)
    await expect(model.events[event](stepEvent(0), ctx)).rejects.toThrow(/refusing to run without its instructions/)
  })

  it('carries provider options (DeepSeek no-thinking + telemetry) on the selection', async () => {
    const providerOptions = {
      deepseek: { thinking: { type: 'disabled' } },
      gateway: { tags: ['feature:generate_title'] },
    }
    fetchUtilitySpec.mockResolvedValue(spec({ providerOptions }))
    const expected = { model: 'deepseek/deepseek-v4-flash', modelOptions: { providerOptions } }
    expect(await model.events['session.started']({}, ctx)).toEqual(expected)
    const step = await model.events['step.started'](stepEvent(0), ctx)
    expect(step).toMatchObject({ model: { modelId: expected.model, provider: 'gateway' }, modelOptions: { providerOptions } })
    expect(gw.gateway).toHaveBeenCalledExactlyOnceWith(expected.model)
  })

  it("runs a call on the person's ChatGPT plan on the plan model, never the Gateway, under the same contract", async () => {
    const plan = { model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'low' }
    fetchUtilitySpec.mockResolvedValue(spec({ model: 'openai/gpt-6-luna', maxOutputTokens: 1600, chatgptPlan: plan }))
    // The session's selection is the guard: the Gateway may serve it from no host.
    expect(await model.events['session.started']({}, ctx)).toEqual({
      model: 'openai/gpt-6-luna',
      reasoning: 'low',
      modelContextWindowTokens: 250_000,
      modelOptions: { providerOptions: { gateway: { only: ['chatgpt-plan'] } } },
    })
    const step = (await model.events['step.started'](stepEvent(0), ctx)) as {
      model: { provider: string; modelId: string }
      modelOptions: unknown
      reasoning: string
    }
    expect(step.model.provider).toBe('chatgpt-plan.responses')
    expect(step.model.modelId).toBe('gpt-6-luna')
    expect(step.modelOptions).toEqual({ providerOptions: { openai: { store: false } } })
    expect(step.reasoning).toBe('low')
    expect(gw.gateway).not.toHaveBeenCalled()
  })

  it("calls the plan proxy with this agent's own secret and the call's token", async () => {
    const env = { ...process.env }
    process.env.UTILITY_INTERNAL_SECRET = 'utility-secret'
    process.env.NEXT_PUBLIC_APP_URL = 'http://127.0.0.1:3002'
    const fetchMock = vi.fn(async () =>
      new Response('data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    try {
      fetchUtilitySpec.mockResolvedValue(spec({ chatgptPlan: { model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'low' } }))
      const step = (await model.events['step.started'](stepEvent(0), ctx)) as { model: { doStream: (o: unknown) => Promise<unknown> } }
      await step.model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], providerOptions: { openai: { store: false } } })
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('http://127.0.0.1:3002/api/internal/chatgpt-plan/v1/responses')
      const headers = new Headers(init.headers)
      expect(headers.get('x-utility-run-secret')).toBe('utility-secret')
      expect(headers.get('x-utility-run-token')).toBe('tok.sig')
      expect(headers.get('authorization')).toBeNull()
      expect(JSON.parse(String(init.body))).toMatchObject({ model: 'gpt-6-luna', store: false })
    } finally {
      process.env = env
      vi.unstubAllGlobals()
    }
  })

  it('a bare model when there are no provider options', async () => {
    fetchUtilitySpec.mockResolvedValue(spec())
    expect(await model.events['session.started']({}, ctx)).toBe('deepseek/deepseek-v4-flash')
  })

  it('a capped kind gets a live Gateway model at step.started, same model id, options kept', async () => {
    const providerOptions = { gateway: { tags: ['feature:knowledge_brief'] } }
    fetchUtilitySpec.mockResolvedValue(
      spec({ kind: 'knowledge_brief', systemPrompt: 'brief', maxOutputTokens: 1600, providerOptions }),
    )
    // The session-level selection stays serializable (eve rejects live models there).
    expect(await model.events['session.started']({}, ctx)).toEqual({
      model: 'deepseek/deepseek-v4-flash',
      modelOptions: { providerOptions },
    })
    const step = (await model.events['step.started'](stepEvent(0), ctx)) as {
      model: { provider: string; modelId: string; specificationVersion: string }
      modelOptions: unknown
    }
    expect(typeof step.model).toBe('object')
    expect(step.model.provider).toBe('gateway')
    expect(step.model.modelId).toBe('deepseek/deepseek-v4-flash')
    expect(step.modelOptions).toEqual({ providerOptions })
  })

  it('ignores a malformed cap while preserving the tool contract', async () => {
    fetchUtilitySpec.mockResolvedValue(spec({ maxOutputTokens: -5 }))
    expect(await model.events['step.started'](stepEvent(0), ctx)).toMatchObject({ model: { modelId: 'deepseek/deepseek-v4-flash' } })
    expect(gw.gateway).toHaveBeenCalledOnce()
  })
})

describe('utility agent — the cap is wired into the model the step resolver returns', () => {
  type StepModel = { model: { doGenerate: (o: unknown) => Promise<unknown> } }
  const prompt = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]

  it('knowledge_brief (cap 1600): a 64k request reaches the Gateway model as 1600', async () => {
    const inner = mockInner()
    gw.gateway.mockReturnValueOnce(inner)
    fetchUtilitySpec.mockResolvedValue(spec({ kind: 'knowledge_brief', maxOutputTokens: 1600, maxSteps: 1 }))
    const step = (await model.events['step.started'](stepEvent(0), ctx)) as StepModel
    // The Gateway model is built for the spec's slug…
    expect(gw.gateway).toHaveBeenCalledWith('deepseek/deepseek-v4-flash')
    // …and the object handed to eve enforces the cap on the call itself.
    await step.model.doGenerate({ prompt, maxOutputTokens: 64_000 })
    expect((inner.doGenerateCalls[0] as { maxOutputTokens?: number }).maxOutputTokens).toBe(1600)
  })

  it('reference_ingest_segment (cap 12k): an uncapped request gets the cap', async () => {
    const inner = mockInner()
    gw.gateway.mockReturnValueOnce(inner)
    fetchUtilitySpec.mockResolvedValue(
      spec({ kind: 'reference_ingest_segment', model: 'anthropic/claude-sonnet-4.5', maxOutputTokens: 12_000, maxSteps: 2 }),
    )
    const step = (await model.events['step.started'](stepEvent(0), ctx)) as StepModel
    expect(gw.gateway).toHaveBeenCalledWith('anthropic/claude-sonnet-4.5')
    await step.model.doGenerate({ prompt })
    expect((inner.doGenerateCalls[0] as { maxOutputTokens?: number }).maxOutputTokens).toBe(12_000)
  })

  it('an uncapped kind still wraps the same model without inventing an output cap', async () => {
    const inner = mockInner()
    gw.gateway.mockReturnValueOnce(inner)
    fetchUtilitySpec.mockResolvedValue(spec({ kind: 'email_draft_reply', maxSteps: 1 }))
    const step = await model.events['step.started'](stepEvent(0), ctx) as StepModel
    await step.model.doGenerate({ prompt })
    expect(inner.doGenerateCalls[0].maxOutputTokens).toBeUndefined()
    expect(inner.doGenerateCalls[0].toolChoice).toEqual({ type: 'none' })
  })
})

describe('utility agent — step ceiling (one model call, plus one repair for structured kinds)', () => {
  it('a text kind (maxSteps 1) runs step 0 and refuses step 1', async () => {
    fetchUtilitySpec.mockResolvedValue(spec({ kind: 'knowledge_brief', maxSteps: 1 }))
    await expect(model.events['step.started'](stepEvent(0), ctx)).resolves.toBeDefined()
    await expect(model.events['step.started'](stepEvent(1), ctx)).rejects.toThrow(
      /knowledge_brief session reached its 1-step ceiling \(step index 1\)/,
    )
  })

  it('a structured kind (maxSteps 2) gets one repair step, then is refused', async () => {
    fetchUtilitySpec.mockResolvedValue(
      spec({ kind: 'reference_ingest_outline', maxOutputTokens: 3_000, maxSteps: 2 }),
    )
    await expect(model.events['step.started'](stepEvent(0), ctx)).resolves.toBeDefined()
    await expect(model.events['step.started'](stepEvent(1), ctx)).resolves.toBeDefined()
    await expect(model.events['step.started'](stepEvent(2), ctx)).rejects.toThrow(/2-step ceiling/)
    await expect(model.events['step.started'](stepEvent(9), ctx)).rejects.toThrow(/2-step ceiling/)
  })

  it('a spec with no (or a malformed) maxSteps gets ONE step — fail closed', async () => {
    fetchUtilitySpec.mockResolvedValue(spec({ kind: 'skill_draft' }))
    await expect(model.events['step.started'](stepEvent(0), ctx)).resolves.toBeDefined()
    await expect(model.events['step.started'](stepEvent(1), ctx)).rejects.toThrow(/1-step ceiling/)
    fetchUtilitySpec.mockResolvedValue(spec({ kind: 'skill_draft', maxSteps: 0 }))
    await expect(model.events['step.started'](stepEvent(1), ctx)).rejects.toThrow(/1-step ceiling/)
  })

  it('an event without a readable stepIndex is refused, never treated as step 0', async () => {
    fetchUtilitySpec.mockResolvedValue(spec({ maxSteps: 2 }))
    for (const ev of [{}, null, { data: {} }, { data: { stepIndex: '0' } }, { data: { stepIndex: -1 } }]) {
      await expect(model.events['step.started'](ev, ctx)).rejects.toThrow(/step ceiling/)
    }
  })

  it("gates eve's OWN step.started event (built by the installed eve), not just the literal above", async () => {
    // step-event-contract.test.ts pins that tool-loop dispatches this shape.
    const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))
    const { createStepStartedEvent } = (await import(
      pathToFileURL(join(eveRoot, 'dist/src/protocol/message.js')).href
    )) as { createStepStartedEvent: (e: Record<string, unknown>) => unknown }
    const eveEvent = (stepIndex: number) =>
      createStepStartedEvent({ modelId: 'deepseek/deepseek-v4-flash', sequence: 1, stepIndex, turnId: 't-1' })
    fetchUtilitySpec.mockResolvedValue(spec({ kind: 'knowledge_brief', maxSteps: 1 }))
    await expect(model.events['step.started'](eveEvent(0), ctx)).resolves.toBeDefined()
    await expect(model.events['step.started'](eveEvent(1), ctx)).rejects.toThrow(/1-step ceiling \(step index 1\)/)
  })

  it('the session-level resolver is not step-gated', async () => {
    fetchUtilitySpec.mockResolvedValue(spec({ maxSteps: 1 }))
    await expect(model.events['session.started']({}, ctx)).resolves.toBe('deepseek/deepseek-v4-flash')
  })
})

describe('outputCapMiddleware — the cap reaches the model call', () => {
  async function callWith(cap: number, requested: number | undefined) {
    const inner = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      }),
    })
    const wrapped = wrapLanguageModel({ model: inner, middleware: outputCapMiddleware(cap) })
    await wrapped.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      ...(requested !== undefined ? { maxOutputTokens: requested } : {}),
    } as never)
    return (inner.doGenerateCalls[0] as { maxOutputTokens?: number }).maxOutputTokens
  }

  it('sets the cap when the caller asked for none', async () => {
    expect(await callWith(1600, undefined)).toBe(1600)
  })

  it('lowers a larger request to the cap', async () => {
    expect(await callWith(1600, 64_000)).toBe(1600)
  })

  it('never raises a smaller request', async () => {
    expect(await callWith(1600, 500)).toBe(500)
  })
})

describe('utility agent — instructions resolver', () => {
  it('resolves once per session', () => {
    expect(Object.keys(instructions.events)).toEqual(['session.started'])
  })

  it("returns the kind's system prompt byte-for-byte", async () => {
    const prompt = 'You compile a workspace knowledge brief…\n\n- rule one\n- rule "two"'
    fetchUtilitySpec.mockResolvedValue(spec({ systemPrompt: prompt }))
    const out = (await instructions.events['session.started']({}, ctx)) as { content: string }
    expect(out.content).toBe(prompt)
  })

  it('returns null for a kind that has no system prompt (generate_title)', async () => {
    fetchUtilitySpec.mockResolvedValue(spec({ kind: 'generate_title', systemPrompt: null }))
    expect(await instructions.events['session.started']({}, ctx)).toBeNull()
  })

  it('THROWS when the spec cannot be fetched — never runs a kind without its rules', async () => {
    fetchUtilitySpec.mockResolvedValue(null)
    await expect(instructions.events['session.started']({}, ctx)).rejects.toThrow(
      /refusing to run without its instructions/,
    )
  })
})
