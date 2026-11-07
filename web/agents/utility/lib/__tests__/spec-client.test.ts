/**
 * The utility agent's only link to the Next app. Pins:
 *   - providerOptions are shape-guarded before they reach a model selection
 *     (a malformed object degrades to the bare model, never a crash);
 *   - the model + instructions resolvers share ONE spec fetch per token;
 *   - a failed fetch is not memoized, and returns null (logged);
 *   - a call on the person's plan keeps its plan, and a spec that names the
 *     plan without one is refused: never the plan's model on the Gateway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  __resetSpecMemo,
  fetchUtilitySpec,
  modelSelectionFor,
  planSpecError,
  stepModelSelectionFor,
  validProviderOptions,
} from '../spec-client'

describe('validProviderOptions', () => {
  it('passes gateway telemetry + a deepseek block through', () => {
    const po = {
      gateway: { user: 'u1', tags: ['feature:generate_title', 'runtime:eve'] },
      deepseek: { thinking: { type: 'disabled' } },
    }
    expect(validProviderOptions(po)).toEqual(po)
  })

  for (const bad of [undefined, null, 'x', 42, [], { gateway: 'x' }, { gateway: [1] }, { gateway: { f: () => 1 } }]) {
    it(`rejects ${String(JSON.stringify(bad))}`, () => {
      expect(validProviderOptions(bad)).toBeNull()
    })
  }

  it('an empty object is "no options"', () => {
    expect(validProviderOptions({})).toBeNull()
  })
})

describe('modelSelectionFor', () => {
  it('a spec without provider options selects the bare slug', () => {
    expect(modelSelectionFor({ kind: 'generate_title', model: 'deepseek/deepseek-v4-flash', systemPrompt: null })).toBe(
      'deepseek/deepseek-v4-flash',
    )
  })

  it('valid provider options ride the selection object', () => {
    const providerOptions = { deepseek: { thinking: { type: 'disabled' } } }
    expect(
      modelSelectionFor({ kind: 'generate_title', model: 'deepseek/deepseek-v4-flash', systemPrompt: 'x', providerOptions }),
    ).toEqual({ model: 'deepseek/deepseek-v4-flash', modelOptions: { providerOptions } })
  })
})

describe('a spec that names the person\'s plan', () => {
  const plan = { model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'low' }

  it('runs on the plan when it carries one', () => {
    const spec = { kind: 'generate_title', model: 'openai/gpt-6-luna', systemPrompt: null, chatgptPlan: plan }
    expect(planSpecError(spec)).toBeNull()
    expect(modelSelectionFor(spec)).toMatchObject({ model: 'openai/gpt-6-luna', modelOptions: { providerOptions: { gateway: { only: ['chatgpt-plan'] } } } })
  })

  it('is refused without a readable plan: the guard slug alone, or a malformed plan', () => {
    for (const spec of [
      { kind: 'generate_title', model: 'openai/gpt-6-luna', systemPrompt: null },
      { kind: 'generate_title', model: 'openai/gpt-6.1-sol', systemPrompt: null },
      { kind: 'generate_title', model: 'openai/gpt-6-luna', systemPrompt: null, chatgptPlan: { model: 'gpt-4o' } },
      { kind: 'generate_title', model: 'deepseek/deepseek-v4-flash', systemPrompt: null, chatgptPlan: 'yes' },
    ]) {
      expect(planSpecError(spec)).toBeInstanceOf(Error)
      expect(() => modelSelectionFor(spec)).toThrow(/ChatGPT plan/)
      expect(() => stepModelSelectionFor(spec, 'tok')).toThrow(/ChatGPT plan/)
    }
  })

  it("refuses another agent's kind (the web-research agent's), plan or not", () => {
    const spec = { kind: 'plan_web_search', model: 'openai/gpt-6-luna', systemPrompt: null, chatgptPlan: plan, agent: 'web-research' }
    expect(planSpecError(spec)).toBeInstanceOf(Error)
    expect(() => modelSelectionFor(spec)).toThrow(/another agent/)
    expect(() => stepModelSelectionFor(spec, 'tok')).toThrow(/another agent/)
  })

  it('leaves a Gateway spec alone', () => {
    expect(planSpecError({ kind: 'generate_title', model: 'openai/gpt-5.6-sol', systemPrompt: null })).toBeNull()
  })
})

describe('fetchUtilitySpec', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    __resetSpecMemo()
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    process.env.UTILITY_INTERNAL_SECRET = 'sec'
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete process.env.UTILITY_INTERNAL_SECRET
  })

  it('sends the secret + token to the internal spec route, once per token', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ kind: 'generate_title', model: 'deepseek/deepseek-v4-flash', systemPrompt: 'Name it.' })),
    )
    const [a, b] = await Promise.all([fetchUtilitySpec('tok-1'), fetchUtilitySpec('tok-1')])
    expect(a).toEqual({ kind: 'generate_title', model: 'deepseek/deepseek-v4-flash', systemPrompt: 'Name it.' })
    expect(b).toEqual(a)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:3000/api/internal/utility/spec')
    expect(init.headers).toMatchObject({ 'x-utility-run-secret': 'sec', 'x-utility-run-token': 'tok-1' })
    expect(init.redirect).toBe('error')
  })

  it('returns null on a non-2xx and does not memoize the failure', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }))
    expect(await fetchUtilitySpec('tok-2')).toBeNull()
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'k', model: 'm/x', systemPrompt: null })))
    expect(await fetchUtilitySpec('tok-2')).toEqual({ kind: 'k', model: 'm/x', systemPrompt: null })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('returns null without a token, without fetching', async () => {
    expect(await fetchUtilitySpec('')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns null for a body with no model', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'k', systemPrompt: 'x' })))
    expect(await fetchUtilitySpec('tok-3')).toBeNull()
  })

  it('keeps a valid per-call output cap and drops a malformed one', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: 'knowledge_brief', model: 'm/x', systemPrompt: 'b', maxOutputTokens: 1600 })),
    )
    expect((await fetchUtilitySpec('tok-4'))?.maxOutputTokens).toBe(1600)
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: 'k', model: 'm/x', systemPrompt: 'b', maxOutputTokens: '1600' })),
    )
    expect(await fetchUtilitySpec('tok-5')).not.toHaveProperty('maxOutputTokens')
  })

  it('keeps a valid step ceiling and drops a malformed one (the resolver then allows ONE step)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: 'claim_extraction', model: 'm/x', systemPrompt: 'c', maxSteps: 2 })),
    )
    expect((await fetchUtilitySpec('tok-6'))?.maxSteps).toBe(2)
    for (const [i, bad] of [0, -1, 1.5, '2', null].entries()) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ kind: 'k', model: 'm/x', systemPrompt: 'c', maxSteps: bad })),
      )
      expect(await fetchUtilitySpec(`tok-bad-${i}`)).not.toHaveProperty('maxSteps')
    }
  })

  it('keeps the plan of a call on the person\'s ChatGPT plan', async () => {
    const chatgptPlan = { model: 'gpt-6-luna', helperModel: 'gpt-6-luna', reasoning: 'low' }
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ kind: 'generate_title', model: 'openai/gpt-6-luna', systemPrompt: null, maxSteps: 1, chatgptPlan })),
    )
    expect((await fetchUtilitySpec('tok-plan'))?.chatgptPlan).toEqual(chatgptPlan)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ kind: 'k', model: 'm/x', systemPrompt: null })))
    expect(await fetchUtilitySpec('tok-gateway')).not.toHaveProperty('chatgptPlan')
  })
})
