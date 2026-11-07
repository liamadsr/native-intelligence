import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Evaluation } from '../contracts'

vi.mock('server-only', () => ({}))
const mock = vi.hoisted(() => ({
  read: vi.fn(), check: vi.fn(), evaluate: vi.fn(), log: vi.fn(), signals: [] as AbortSignal[], now: 0,
}))
vi.mock('../providers/jev', () => ({ evaluateJev: mock.evaluate, JEV_MODEL: 'typesafe-ai/jev' }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: mock.log, checkUsageLimits: mock.check, extractGatewayCost: () => undefined }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ from: (table: string) => {
  const query = { select: () => query, eq: () => query, contains: () => query, gte: () => query,
    order: () => query, limit: () => query,
    abortSignal: (signal: AbortSignal) => { mock.signals.push(signal); return query },
    maybeSingle: () => mock.read(table),
  }
  return query
} }) }))
import { runDecision } from '../run-decision'

const mail = { mailbox: 'me@example.com', threadId: 't', revision: 'm1', complete: true,
  preferences: 'Reply if needed', messages: [{ from: 'you@example.com', to: ['me@example.com'],
    date: '2026-10-03', subject: 'FYI', body: 'Done. No action needed.' }] }
const ctx = { userId: 'deadline-user', workspaceId: 'workspace' }
const evaluation = () => ({ answers: { reply: { type: 'boolean', probability: 0.01 } },
  usage: { inputTokens: 1000, outputTokens: 12 }, response: { modelId: 'typesafe-ai/jev' } }) as unknown as Evaluation
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  mock.now = 0; mock.signals = []
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(performance, 'now').mockImplementation(() => mock.now)
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('deadline', 'TimeoutError')), ms)
    return controller.signal
  })
  mock.read.mockReset().mockImplementation(async table => ({ data: table === 'member' ? { id: 'member' } : null, error: null }))
  mock.check.mockReset().mockResolvedValue({ allowed: true })
  mock.evaluate.mockReset().mockResolvedValue(evaluation())
  mock.log.mockReset().mockResolvedValue('logged')
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('shared decision deadlines', () => {
  it.each([[3556, 'accepted'], [5001, 'escalate']] as const)('bounds the browser cold path at five seconds (%i ms)', async (duration, status) => {
    mock.evaluate.mockImplementation(async () => {
      mock.now = duration
      return { ...evaluation(), answers: {
        operation: { type: 'choice', choice: 'escalate', probabilities: { escalate: 1, scroll_down: 0, scroll_up: 0, wait: 0 } },
        completion: { type: 'choice', choice: 'complete', probabilities: { complete: .99, incomplete: .01 } },
      }, providerMetadata: { typesafe: { confidence: { operation: .99, completion: .99 } } } }
    })
    const result = await runDecision('browser.next_action', {
      task: { goal: 'Open article', bindings: [], completion: [{ kind: 'text', value: 'Requested article' }], maxSteps: 16, timeoutMs: 45000 },
      history: [], observation: { protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 1, interactionEpoch: 0,
        observedAt: 0, url: 'https://example.com/article', title: 'Article', text: 'Requested article', elements: [] },
    }, ctx)
    expect(result.status).toBe(status)
    if (status === 'escalate') expect(result).toMatchObject({ reason: 'deadline_exceeded' })
    expect(mock.log).toHaveBeenCalledOnce()
  })
  it.each(['authorization', 'cache', 'budget'] as const)('releases a stalled %s read even when its transport ignores cancellation', async stage => {
    const pendingRead = deferred<never>()
    if (stage === 'budget') mock.check.mockReturnValue(pendingRead.promise)
    else mock.read.mockImplementation(table => table === (stage === 'authorization' ? 'member' : 'ai_usage_logs')
      ? pendingRead.promise : Promise.resolve({ data: { id: 'member' }, error: null }))
    const pending = runDecision('email.reply_required', mail, ctx)
    await vi.advanceTimersByTimeAsync(0)
    mock.now = 2500
    await vi.advanceTimersByTimeAsync(2500)
    expect(await pending).toMatchObject({ status: 'escalate', reason: 'deadline_exceeded',
      metrics: { timingMs: { [stage]: 2500, total: 2500 } } })
    expect(mock.evaluate).not.toHaveBeenCalled()
    expect(mock.log).not.toHaveBeenCalled()
    expect(mock.signals.every(signal => signal.aborted)).toBe(true)
    if (stage === 'budget') expect(mock.check.mock.calls[0][1].aborted).toBe(true)
  })

  it('honors caller cancellation during a stalled read without waiting for the task timeout', async () => {
    mock.read.mockReturnValue(deferred<never>().promise)
    const controller = new AbortController()
    const pending = runDecision('email.reply_required', mail, { ...ctx, signal: controller.signal })
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    expect(await pending).toMatchObject({ status: 'cancelled', reason: 'caller_cancelled' })
    expect(mock.evaluate).not.toHaveBeenCalled()
    expect(mock.log).not.toHaveBeenCalled()
  })

  it('rejects a cached answer if the clock expires before timer delivery', async () => {
    mock.read.mockImplementation(async table => {
      if (table === 'member') return { data: { id: 'member' }, error: null }
      mock.now = 2501
      return { data: { metadata: { decision_answer: evaluation(), inference_id: 'prior' } }, error: null }
    })
    expect(await runDecision('email.reply_required', mail, ctx)).toMatchObject({ status: 'escalate', reason: 'deadline_exceeded' })
    expect(mock.signals.every(signal => !signal.aborted)).toBe(true)
    expect(mock.evaluate).not.toHaveBeenCalled()
  })

  it('does not invoke the provider after a budget read consumes the deadline without timer delivery', async () => {
    mock.check.mockImplementation(async () => { mock.now = 2501; return { allowed: true } })
    expect(await runDecision('email.reply_required', mail, ctx)).toMatchObject({ reason: 'deadline_exceeded' })
    expect(mock.evaluate).not.toHaveBeenCalled()
  })

  it('awaits and meters a late provider response, without letting that answer seed a cache', async () => {
    const late = deferred<Evaluation>()
    mock.evaluate.mockReturnValue(late.promise)
    const pending = runDecision('email.reply_required', mail, ctx)
    await vi.advanceTimersByTimeAsync(0)
    expect(mock.evaluate).toHaveBeenCalledOnce()
    mock.now = 2501
    await vi.advanceTimersByTimeAsync(2501)
    late.resolve(evaluation())
    const result = await pending
    expect(result).toMatchObject({ reason: 'deadline_exceeded', metrics: { usage: { inputTokens: 1000, outputTokens: 12, known: true } } })
    expect(mock.log).toHaveBeenCalledOnce()
    expect(mock.log.mock.calls[0][1].metadata).toMatchObject({ outcome: 'deadline_exceeded', usage_unknown: false })
    expect(mock.log.mock.calls[0][1].metadata).not.toHaveProperty('decision_cache_key')
  })

  it('also rejects late provider answers when the timeout timer has not fired yet', async () => {
    mock.evaluate.mockImplementation(async () => { mock.now = 2501; return evaluation() })
    expect(await runDecision('email.reply_required', mail, ctx)).toMatchObject({ reason: 'deadline_exceeded' })
    expect(mock.log.mock.calls[0][1].metadata).not.toHaveProperty('decision_cache_key')
    expect(mock.log.mock.calls[0][1].inputTokens).toBe(1000)
  })

  it('keeps a timely answer reusable after slow durable accounting, while the expired caller falls back', async () => {
    const accounting = deferred<string>()
    mock.log.mockReturnValue(accounting.promise)
    const pending = runDecision('email.reply_required', mail, ctx)
    await vi.advanceTimersByTimeAsync(0)
    const params = mock.log.mock.calls[0][1]
    expect(params.metadata).toHaveProperty('decision_cache_key')
    mock.now = 2501
    await vi.advanceTimersByTimeAsync(2501)
    accounting.resolve('logged')
    expect(await pending).toMatchObject({ reason: 'deadline_exceeded', metrics: { usage: { known: true } } })
    mock.read.mockImplementation(async table => ({ data: table === 'member' ? { id: 'member' } : { metadata: params.metadata }, error: null }))
    mock.evaluate.mockClear()
    expect(await runDecision('email.reply_required', mail, ctx)).toMatchObject({ status: 'accepted', cached: true })
    expect(mock.evaluate).not.toHaveBeenCalled()
    expect(mock.log).toHaveBeenCalledOnce()
  })
})
