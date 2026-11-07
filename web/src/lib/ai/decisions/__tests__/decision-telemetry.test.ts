import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Evaluation } from '../contracts'

vi.mock('server-only', () => ({}))
const mock = vi.hoisted(() => ({ evaluate: vi.fn(), log: vi.fn(), check: vi.fn(), gatewayCost: undefined as number | undefined,
  now: 0, member: true, cached: null as unknown }))
vi.mock('../providers/jev', () => ({ evaluateJev: mock.evaluate, JEV_MODEL: 'typesafe-ai/jev' }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: mock.log, checkUsageLimits: mock.check, extractGatewayCost: () => mock.gatewayCost }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: (table: string) => {
  const query = { select: () => query, eq: () => query, contains: () => query, gte: () => query, order: () => query, limit: () => query, abortSignal: () => query,
    maybeSingle: async () => {
      mock.now += table === 'member' ? 3 : 5
      return { data: table === 'member' ? (mock.member ? { id: 'member' } : null) : mock.cached, error: null }
    } }
  return query
} }) }))
import { runDecision } from '../run-decision'

const mail = { mailbox: 'me@example.com', threadId: 't', revision: 'm1', complete: true, preferences: 'Reply if needed',
  messages: [{ from: 'you@example.com', to: ['me@example.com'], date: '2026-10-03', subject: 'Private subject', body: 'Private body. No action needed.' }] }
const ctx = { userId: 'telemetry-user', workspaceId: 'workspace', runId: 'run' }
const evaluation = (probability = 0.01) => ({ answers: { reply: { type: 'boolean', probability } },
  usage: { inputTokens: 1200, outputTokens: 80 }, response: { modelId: 'typesafe-ai/jev', id: 'request' } }) as unknown as Evaluation

beforeEach(() => {
  mock.now = 0; mock.member = true; mock.cached = null; mock.gatewayCost = undefined
  vi.spyOn(performance, 'now').mockImplementation(() => mock.now)
  mock.check.mockReset().mockImplementation(async () => { mock.now += 7; return { allowed: true } })
  mock.evaluate.mockReset().mockImplementation(async () => { mock.now += 11; return evaluation() })
  mock.log.mockReset().mockImplementation(async () => { mock.now += 13; return 'logged' })
})
afterEach(() => vi.restoreAllMocks())

describe('decision telemetry', () => {
  it('returns each browser answer with its probability and confidence; other decisions do not', async () => {
    mock.evaluate.mockImplementation(async () => ({ ...evaluation(), answers: {
      operation: { type: 'choice', choice: 'scroll_down', probabilities: { scroll_down: .4, escalate: .35, wait: .25 } },
      completion: { type: 'choice', choice: 'incomplete', probabilities: { complete: .1, incomplete: .9 } },
    }, providerMetadata: { typesafe: { confidence: { operation: .3, completion: .88 } } } }))
    const result = await runDecision('browser.next_action', {
      task: { goal: 'Open article', bindings: [], completion: [{ kind: 'text', value: 'Requested article' }], maxSteps: 16, timeoutMs: 45000 },
      history: [], observation: { protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 1, interactionEpoch: 0,
        observedAt: 0, url: 'https://example.com/article', title: 'Article', text: 'Requested article',
        viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, scrollWidth: 800, scrollHeight: 1800 }, elements: [] },
    }, ctx)
    expect(result).toMatchObject({ metrics: { answers: {
      operation: { choice: 'scroll_down', probability: .4, confidence: .3 },
      completion: { choice: 'incomplete', probability: .9, confidence: .88 },
    } } })
    expect((await runDecision('email.reply_required', mail, ctx)).metrics).not.toHaveProperty('answers')
  })

  it('separates Gateway roundtrip, authorization, budget, cache and awaited accounting', async () => {
    mock.gatewayCost = 0.00123
    const result = await runDecision('email.reply_required', mail, ctx)
    expect(result).toMatchObject({ status: 'accepted', metrics: {
      timingMs: { preparation: 0, authorization: 3, cache: 5, budget: 7, provider: 11, acceptance: 0, accounting: 13, total: 39 },
      usage: { inputTokens: 1200, outputTokens: 80, known: true, costUsd: 0.00123, costSource: 'gateway' },
      questionCount: 3, // email-reply-v4: reply + the two email.trust questions
    } })
    expect(result.metrics?.stateBytes).toBeGreaterThan(0)
    expect(result.metrics?.questionBytes).toBeGreaterThan(0)
    const params = mock.log.mock.calls[0][1]
    expect(params.durationMs).toBe(26)
    expect(params.metadata.decision_timing_ms).toMatchObject({ provider: 11, total_before_accounting: 26 })
    expect(params.metadata.decision_timing_ms).not.toHaveProperty('accounting')
    expect(params.metadata.decision_input.state_bytes).toBe(result.metrics?.stateBytes)
    expect(JSON.stringify(params)).not.toContain('Private subject')
    expect(JSON.stringify(params)).not.toContain('Private body')
  })

  it('meters uncertain decisions with reported usage and explicitly labels fallback costs', async () => {
    mock.evaluate.mockResolvedValue(evaluation(0.3))
    const result = await runDecision('email.reply_required', mail, ctx)
    expect(result).toMatchObject({ status: 'escalate', reason: 'uncertain', metrics: {
      usage: { inputTokens: 1200, outputTokens: 80, known: true, costSource: 'catalog' },
    } })
    expect(result.metrics?.usage?.costUsd).toBeCloseTo(0.0000504, 10)
    expect(mock.log.mock.calls[0][1].metadata.outcome).toBe('escalate')
  })

  it('does not spend or invent provider usage for early failures and cache hits', async () => {
    mock.member = false
    expect(await runDecision('email.reply_required', mail, ctx)).toMatchObject({ reason: 'not_authorized', metrics: {
      timingMs: { authorization: 3, provider: 0, accounting: 0, total: 3 },
    } })
    mock.member = true
    mock.cached = { metadata: { decision_answer: evaluation(), inference_id: 'previous' } }
    const cached = await runDecision('email.reply_required', mail, ctx)
    expect(cached).toMatchObject({ status: 'accepted', cached: true, metrics: { timingMs: { cache: 5, provider: 0, accounting: 0, total: 8 } } })
    expect(cached.metrics?.usage).toBeUndefined()
    expect(mock.evaluate).not.toHaveBeenCalled()
    expect(mock.log).not.toHaveBeenCalled()
  })

  it('retains known usage when cancelled after the provider response', async () => {
    const controller = new AbortController()
    mock.evaluate.mockImplementation(async () => { mock.now += 11; controller.abort(); return evaluation() })
    const result = await runDecision('email.reply_required', mail, { ...ctx, signal: controller.signal })
    expect(result).toMatchObject({ status: 'cancelled', metrics: { usage: { inputTokens: 1200, outputTokens: 80, known: true } } })
    expect(mock.log).toHaveBeenCalledTimes(1)
    expect(mock.log.mock.calls[0][1].metadata).toMatchObject({ outcome: 'cancelled', usage_unknown: false })
    expect(mock.log.mock.calls[0][1].metadata).not.toHaveProperty('decision_cache_key')
  })

  it('records timed-out attempts as unknown, including the failed provider roundtrip', async () => {
    mock.evaluate.mockImplementation(async () => { mock.now += 110; throw new Error('private provider details') })
    const result = await runDecision('email.reply_required', mail, ctx)
    expect(result).toMatchObject({ status: 'escalate', reason: 'unavailable', metrics: {
      timingMs: { provider: 110, accounting: 13, total: 138 }, usage: { known: false, costSource: 'unknown' },
    } })
    expect(result.metrics?.usage).not.toHaveProperty('inputTokens')
    expect(result.metrics?.usage).not.toHaveProperty('costUsd')
    expect(mock.log.mock.calls[0][1].metadata).toMatchObject({ usage_unknown: true, cost_unknown: true })
    expect(JSON.stringify(result)).not.toContain('private provider details')
  })

  it('retains the same billing key and known usage if accounting throws unexpectedly', async () => {
    mock.log.mockRejectedValueOnce(new Error('database disconnected'))
    const result = await runDecision('email.reply_required', mail, ctx)
    expect(result).toMatchObject({ status: 'escalate', reason: 'unavailable', metrics: { usage: { inputTokens: 1200, outputTokens: 80, known: true } } })
    expect(mock.log).toHaveBeenCalledTimes(2)
    const [first, retry] = mock.log.mock.calls.map(call => call[1])
    expect(retry.idempotencyKey).toBe(first.idempotencyKey)
    expect(retry.inputTokens).toBe(1200)
    expect(retry.outputTokens).toBe(80)
    expect(retry.metadata.usage_unknown).toBe(false)
  })

  it('does not treat omitted output tokens as reported zero tokens', async () => {
    mock.evaluate.mockResolvedValue({ ...evaluation(), usage: { inputTokens: 1200 } })
    const result = await runDecision('email.reply_required', mail, ctx)
    expect(result).toMatchObject({ status: 'escalate', reason: 'accounting_unavailable', metrics: { usage: { inputTokens: 1200, known: false } } })
    expect(result.metrics?.usage?.outputTokens).toBeUndefined()
    expect(mock.log.mock.calls[0][1].metadata.usage_unknown).toBe(true)
  })
})
