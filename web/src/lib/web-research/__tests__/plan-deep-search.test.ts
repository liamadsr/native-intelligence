import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Exa's deep search on a free user's own ChatGPT plan
 * (src/lib/web-research/plan-deep-search.ts). Pinned:
 *   - the answer maps onto Exa's DeepSearchResult, so groundedFields and
 *     sourcesOf read it unchanged;
 *   - a citation must be an http(s) URL, on the given sites when there are
 *     any, and one of the searched pages when the stream named them; a field
 *     left uncited loses its grounding (it reads as 'low', filling no column);
 *   - the call runs on the plan (plan_web_search, Luna) and logs its usage
 *     under the plan's provider at no cost, a failed one included;
 *   - deepSearchForUser: the plan's for a person on it, Exa's otherwise, and
 *     a throw when the plan can't be read (never Exa for a free user).
 */

vi.mock('server-only', () => ({}))
const runUtilityTask = vi.fn()
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask: (...a: unknown[]) => runUtilityTask(...a) }))
const logUsage = vi.fn(async (_userId: string, _params: Record<string, unknown>) => ({}))
vi.mock('@/lib/ai/auth', () => ({ logUsage: (u: string, p: Record<string, unknown>) => logUsage(u, p) }))
const chatgptPlanFor = vi.fn<(u: string, o?: unknown) => Promise<boolean>>()
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: (u: string, o?: unknown) => chatgptPlanFor(u, o) }))

import { COMPANY_CARD_CORE, deepSearch, groundedFields, sourcesOf, type DeepSearchArgs } from '@/lib/exa/deep-search'
import {
  deepSearchForUser,
  planDeepSearch,
  planDeepSearchMessage,
  planDeepSearchResult,
  planWebSearch,
  relaxedCardSchema,
  type PlanDeepSearchAnswer,
} from '../plan-deep-search'

const ARGS: DeepSearchArgs = { query: 'acme.com company profile', category: 'company', outputSchema: COMPANY_CARD_CORE }

function answer(over: Partial<PlanDeepSearchAnswer> = {}): PlanDeepSearchAnswer {
  return {
    content: { industry: 'Industrial robotics', description: 'Acme builds warehouse robots.', website: 'https://acme.com' },
    grounding: [
      { field: 'industry', citations: [{ url: 'https://acme.com/about', title: 'About Acme' }], confidence: 'high' },
      { field: 'description', citations: [{ url: 'https://www.crunchbase.com/organization/acme', title: 'Acme - Crunchbase' }], confidence: 'medium' },
    ],
    sources: [{ url: 'https://acme.com/about', title: 'About Acme' }],
    ...over,
  }
}

beforeEach(() => {
  runUtilityTask.mockReset()
  logUsage.mockClear()
  chatgptPlanFor.mockReset()
})

describe('the request', () => {
  it("drops every required list, so a field the model can't find stays out", () => {
    const relaxed = relaxedCardSchema(COMPANY_CARD_CORE) as Record<string, unknown>
    expect(relaxed).not.toHaveProperty('required')
    expect(Object.keys(relaxed.properties as object)).toEqual(Object.keys(COMPANY_CARD_CORE.properties))
    expect(COMPANY_CARD_CORE.required).toEqual(['industry', 'description'])
    expect(relaxedCardSchema({ type: 'object', properties: { a: { type: 'array', items: { type: 'object', required: ['x'] } } }, required: ['a'] }))
      .toEqual({ type: 'object', properties: { a: { type: 'array', items: { type: 'object' } } } })
  })

  it("carries everything Exa's request does", () => {
    const message = JSON.parse(planDeepSearchMessage({
      ...ARGS, additionalQueries: ['acme robotics funding'], includeDomains: ['acme.com'], systemPrompt: ' up to 20 ', numResults: 5,
    }))
    expect(message).toMatchObject({
      query: 'acme.com company profile', subject: 'a company', extraSearches: ['acme robotics funding'],
      onlySites: ['acme.com'], instructions: 'up to 20', readAtLeast: '5 pages',
    })
    expect(message.card.properties.industry).toBeDefined()
  })
})

describe('the answer as Exa’s result', () => {
  it('reads unchanged through groundedFields and sourcesOf, at no cost', () => {
    const res = planDeepSearchResult(answer(), ARGS)
    expect(res.costDollars).toBe(0)
    const fields = groundedFields(res)
    expect(fields.industry).toMatchObject({ value: 'Industrial robotics', source_url: 'https://acme.com/about', confidence: 'high' })
    expect(fields.description.confidence).toBe('medium')
    // Filled, but cited nowhere: low, so it fills no column.
    expect(fields.website.confidence).toBe('low')
    expect(sourcesOf(res).map((s) => s.url)).toEqual(['https://acme.com/about', 'https://www.crunchbase.com/organization/acme'])
  })

  it('drops a field off the card, an empty one, and grounding for a field it does not hold', () => {
    const res = planDeepSearchResult(answer({
      content: { industry: 'Robots', ceoSecret: 'x', recentNews: '  ' },
      grounding: [
        { field: 'industry', citations: [{ url: 'https://acme.com/a', title: null }], confidence: 'high' },
        { field: 'annualRevenue', citations: [{ url: 'https://acme.com/b', title: null }], confidence: 'high' },
      ],
    }), ARGS)
    expect(res.content).toEqual({ industry: 'Robots' })
    expect(res.grounding.map((g) => g.field)).toEqual(['industry'])
  })

  it('keeps only http(s) citations, and on the given sites only', () => {
    const grounding: PlanDeepSearchAnswer['grounding'] = [
      { field: 'industry', citations: [{ url: 'javascript:alert(1)', title: null }, { url: 'https://evil.example/acme', title: null }, { url: 'https://www.acme.com/about', title: null }], confidence: 'high' },
      { field: 'description', citations: [{ url: 'https://en.wikipedia.org/wiki/Acme', title: null }], confidence: 'high' },
    ]
    const anchored = planDeepSearchResult(answer({ grounding, sources: [] }), { ...ARGS, includeDomains: ['acme.com'] })
    expect(anchored.grounding).toEqual([{ field: 'industry', citations: [{ url: 'https://www.acme.com/about', title: null }], confidence: 'high' }])
    expect(anchored.results.map((r) => r.url)).toEqual(['https://www.acme.com/about'])
    // Off the site, the description lost its only citation: it reads as low.
    expect(groundedFields(anchored).description.confidence).toBe('low')
    const open = planDeepSearchResult(answer({ grounding, sources: [] }), ARGS)
    expect(open.grounding.flatMap((g) => g.citations.map((c) => c.url))).toEqual(['https://evil.example/acme', 'https://www.acme.com/about', 'https://en.wikipedia.org/wiki/Acme'])
  })

  it('cites only pages the searches returned, when the stream named them', () => {
    const res = planDeepSearchResult(answer(), ARGS, ['https://acme.com/about'])
    expect(res.grounding.map((g) => g.field)).toEqual(['industry'])
    expect(res.results.map((r) => r.url)).toEqual(['https://acme.com/about'])
  })

  it("matches a searched page by host and path (OpenAI's utm tag), and reads a content.-prefixed path", () => {
    const res = planDeepSearchResult(answer({
      grounding: [{ field: 'content.industry', citations: [{ url: 'https://acme.com/about/?utm_source=openai', title: null }], confidence: 'high' }],
      sources: [],
    }), ARGS, ['https://www.acme.com/about'])
    expect(res.grounding).toEqual([{ field: 'content.industry', citations: [{ url: 'https://acme.com/about/?utm_source=openai', title: null }], confidence: 'high' }])
    expect(groundedFields(res).industry.confidence).toBe('high')
  })

  it('keeps at most three citations a field, and a long answer trimmed rather than refused', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ url: `https://acme.com/p${i}`, title: null }))
    const res = planDeepSearchResult(answer({
      grounding: [{ field: 'industry', citations: many, confidence: 'high' }],
      sources: Array.from({ length: 100 }, (_, i) => ({ url: `https://acme.com/s${i}`, title: null })),
    }), ARGS)
    expect(res.grounding[0].citations).toHaveLength(3)
    expect(res.results.length).toBeLessThanOrEqual(60)
  })

  it('grounds a list card by item', () => {
    const list = { type: 'object', properties: { companies: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, domain: { type: 'string' } } } } } }
    const res = planDeepSearchResult({
      content: { companies: [{ name: 'Acme', domain: 'acme.com' }] },
      grounding: [{ field: 'companies[0].domain', citations: [{ url: 'https://acme.com', title: 'Acme' }], confidence: 'high' }],
      sources: [],
    }, { query: 'robotics companies', outputSchema: list })
    expect(res.grounding).toHaveLength(1)
    expect(res.content).toEqual({ companies: [{ name: 'Acme', domain: 'acme.com' }] })
  })
})

describe('planDeepSearch', () => {
  it("runs on the person's plan and logs its usage under the plan at no cost", async () => {
    runUtilityTask.mockImplementation(async (a: { onUsage: (r: unknown) => void }) => {
      a.onUsage({ complete: true, usage: { inputTokens: 9_000, outputTokens: 400 } })
      return { text: '', model: 'chatgpt-plan/gpt-6-luna', usage: {}, object: answer(), webSources: [] }
    })
    const signal = AbortSignal.timeout(60_000)
    const res = await planDeepSearch({ ...ARGS, signal }, { userId: 'u1', workspaceId: 'w1' })
    expect(res.content).toMatchObject({ industry: 'Industrial robotics' })
    expect(runUtilityTask).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'plan_web_search', chatgptPlan: true, planModel: 'gpt-6-luna', userId: 'u1', workspaceId: 'w1', signal,
    }))
    expect(logUsage).toHaveBeenCalledWith('u1', expect.objectContaining({
      provider: 'chatgpt-plan', model: 'chatgpt-plan/gpt-6-luna', feature: 'web_research.plan', inputTokens: 9_000, outputTokens: 400,
    }))
    expect(logUsage.mock.calls[0][1]).not.toHaveProperty('costUsd')
  })

  it('throws as deepSearch does when the session fails, logging a dispatched attempt and nothing for no session', async () => {
    runUtilityTask.mockImplementationOnce(async (a: { onUsage: (r: unknown) => void }) => {
      a.onUsage({ complete: false, usage: { inputTokens: 300, outputTokens: 0 } })
      throw new Error('[utility] plan_web_search session failed')
    })
    await expect(planDeepSearch(ARGS, { userId: 'u1', workspaceId: null })).rejects.toThrow(/session failed/)
    expect(logUsage).toHaveBeenCalledWith('u1', expect.objectContaining({ provider: 'chatgpt-plan', inputTokens: 300 }))
    logUsage.mockClear()
    runUtilityTask.mockRejectedValueOnce(new Error('[utility] UTILITY_INTERNAL_SECRET is not set'))
    await expect(planDeepSearch(ARGS, { userId: 'u1', workspaceId: null })).rejects.toThrow(/not set/)
    expect(logUsage).not.toHaveBeenCalled()
  })

  it("throws the caller's deadline as itself, so a timeout reads as one", async () => {
    const controller = new AbortController()
    const deadline = new DOMException('signal timed out', 'TimeoutError')
    runUtilityTask.mockImplementationOnce(async () => {
      controller.abort(deadline)
      throw new Error('[utility] plan_web_search cancelled')
    })
    await expect(planDeepSearch({ ...ARGS, signal: controller.signal }, { userId: 'u1', workspaceId: null })).rejects.toBe(deadline)
  })

  it('reads an answer from a session that ran no web search as low throughout', async () => {
    runUtilityTask.mockResolvedValueOnce({ text: '', model: 'chatgpt-plan/gpt-6-luna', usage: {}, object: answer(), webSources: [], webSearches: 0 })
    const res = await planDeepSearch(ARGS, { userId: 'u1', workspaceId: null })
    expect(res.grounding.map((g) => g.confidence)).toEqual(['low', 'low'])
    expect(Object.values(groundedFields(res)).every((f) => f.confidence === 'low')).toBe(true)
  })
})

describe('planWebSearch', () => {
  it("lists the pages the answer relied on, in Exa's search shape, at no cost", async () => {
    runUtilityTask.mockResolvedValueOnce({
      text: '', model: 'chatgpt-plan/gpt-6-luna', usage: {}, webSources: [], webSearches: 1,
      object: {
        content: { results: [
          { title: 'Native Intelligence', url: 'https://dial8.ai/', snippet: 'Linear meets Granola.' },
          { title: 'Invented', url: 'https://not-read.example/', snippet: 'x' },
          { title: 'Bad', url: 'javascript:1', snippet: 'x' },
        ] },
        grounding: [{ field: 'results[0].url', citations: [{ url: 'https://dial8.ai/', title: 'Native Intelligence' }], confidence: 'high' }],
        sources: [{ url: 'https://dial8.ai/', title: 'Native Intelligence' }],
      },
    })
    const res = await planWebSearch({ query: 'dial8', numResults: 5 }, { userId: 'u1', workspaceId: 'w1' })
    expect(res).toEqual({ results: [{ title: 'Native Intelligence', url: 'https://dial8.ai/', publishedDate: null, author: null, highlights: ['Linear meets Granola.'] }], costDollars: 0 })
    expect(runUtilityTask).toHaveBeenCalledWith(expect.objectContaining({ kind: 'plan_web_search', chatgptPlan: true, userId: 'u1' }))
  })
})

describe('deepSearchForUser', () => {
  it("is the plan's for a person on it, Exa's for everyone else and for no person", async () => {
    chatgptPlanFor.mockResolvedValue(true)
    runUtilityTask.mockResolvedValue({ text: '', model: 'chatgpt-plan/gpt-6-luna', usage: {}, object: answer() })
    const onPlan = await deepSearchForUser('free', 'w1')
    expect(onPlan).not.toBe(deepSearch)
    await onPlan(ARGS)
    expect(runUtilityTask).toHaveBeenCalledOnce()
    expect(chatgptPlanFor).toHaveBeenCalledWith('free', { attempts: 2, failClosed: true })
    chatgptPlanFor.mockResolvedValue(false)
    expect(await deepSearchForUser('paid', 'w1')).toBe(deepSearch)
    expect(await deepSearchForUser(null, 'w1')).toBe(deepSearch)
  })

  it("throws when the plan can't be read, never handing a free user Exa", async () => {
    chatgptPlanFor.mockRejectedValue(new Error('ChatGPT plan check failed: boom'))
    await expect(deepSearchForUser('u1', 'w1')).rejects.toThrow(/plan check failed/)
  })
})
