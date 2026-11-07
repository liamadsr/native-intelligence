/**
 * POST /api/ai/complete — note continuation ("continue writing").
 *
 * Runs the real route → stream-route → streamUtilityText chain; only the
 * eve session (createTaskSession / Client), auth, workspace lookup and
 * logUsage are faked.
 *
 * Pinned:
 *   - the text streams from a note_continuation session on the
 *     utility agent as a plain text stream, chunk by chunk as eve writes it
 *     (the first chunk arrives while the session is still running);
 *   - usage is logged once, after the answer, with the pre-port onEnd's
 *     fields: provider 'claude', the workspace's drafting model, feature
 *     'ai_complete', step.completed tokens, eve's 0 cost omitted (the RPC
 *     prices the row), no metadata;
 *   - a session that cannot start is a 500 'Completion failed', not an empty
 *     200; a missing or non-string context (e.g. file parts) is a 400 and
 *     runs nothing — only server-built messages may carry file parts;
 *   - the browser going away mid-stream cancels the eve session and logs no
 *     usage, through the real Response body (not just the library stream);
 *   - a non-zero eve cost reaches the usage row as-is (billing parity with
 *     the pre-port extractGatewayCost path);
 *   - the kind's wall clock plus the post-timeout cancel fit inside the
 *     route's maxDuration, and the session's timeout shrinks by whatever the
 *     route's own pre-work (auth, usage-limit check, workspace + model
 *     lookup) already spent; pre-work that leaves under 10s is a 503 before
 *     any eve session exists.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  createTaskSession: vi.fn(),
  cancel: vi.fn(async () => ({ status: 'accepted' })),
  logUsage: vi.fn(async (..._a: unknown[]) => {}),
  getCurrentWorkspaceId: vi.fn(async (): Promise<string | null> => 'ws-1'),
  authenticateUser: vi.fn(async (..._a: unknown[]) => ({ user: { id: 'user-1' } })),
  checkUsageLimits: vi.fn(async (..._a: unknown[]) => {}),
  clients: [] as Array<Record<string, unknown>>,
}))

vi.mock('eve/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('eve/client')>()),
  Client: class {
    sessions = { attach: () => ({ cancel: hoisted.cancel }) }
    constructor(opts: Record<string, unknown>) {
      hoisted.clients.push(opts)
    }
  },
}))
vi.mock('@/lib/eve/task-session', () => ({ createTaskSession: hoisted.createTaskSession }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId }))
vi.mock('@/lib/ai/auth', () => ({
  authenticateUser: hoisted.authenticateUser,
  checkUsageLimits: hoisted.checkUsageLimits,
  logUsage: hoisted.logUsage,
}))

const { POST, maxDuration } = await import('../route')
const { routeModelTimeoutMs } = await import('@/lib/eve/utility/stream-route')
const { UTILITY_KIND_SPECS } = await import('@/lib/eve/utility/spec')
const { CANCEL_TIMEOUT_MS } = await import('@/lib/eve/utility/run-utility')
const { verifyUtilityToken } = await import('@/lib/eve/utility-run-token')

const appended = (messageDelta: string) => ({
  type: 'message.appended',
  data: { messageDelta, messageSoFar: '', sequence: 0, stepIndex: 0, turnId: 't1' },
})

/** An eve session the test feeds event by event (never ends on its own). */
function liveSession() {
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  return {
    push(...events: unknown[]) {
      queue.push(...events)
      const w = wake
      wake = null
      w?.()
    },
    response: {
      sessionId: 'sess-1',
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift()
          await new Promise<void>((r) => (wake = r))
        }
      },
    },
  }
}

function post(body: unknown) {
  return POST(
    new Request('http://localhost:3000/api/ai/complete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

beforeEach(() => {
  process.env.UTILITY_INTERNAL_SECRET = 'sec'
  hoisted.createTaskSession.mockReset()
  hoisted.cancel.mockClear()
  hoisted.logUsage.mockClear()
  hoisted.authenticateUser.mockClear()
  hoisted.checkUsageLimits.mockClear()
  hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-1')
  hoisted.clients.length = 0
})
afterEach(() => {
  delete process.env.UTILITY_INTERNAL_SECRET
  vi.restoreAllMocks()
})

describe('/api/ai/complete — server path on the eve utility agent', () => {
  it('streams each delta as eve writes it, then logs usage like the pre-port onEnd', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const res = await post({ context: '# Plan\n\n- ship' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)

    // A note_continuation task session with the context as its message.
    const headers = hoisted.clients[0].headers as Record<string, string>
    expect(verifyUtilityToken(headers['x-utility-run-token'])).toMatchObject({
      kind: 'note_continuation',
      workspaceId: 'ws-1',
      userId: 'user-1',
      model: 'deepseek-v4-flash',
    })
    const [, opts] = hoisted.createTaskSession.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(opts.message).toBe('# Plan\n\n- ship')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    live.push(appended('- test'))
    const first = await reader.read()
    expect(decoder.decode(first.value, { stream: true })).toBe('- test')
    expect(hoisted.logUsage).not.toHaveBeenCalled()

    live.push(
      appended('\n- launch'),
      { type: 'step.completed', data: { usage: { inputTokens: 210, outputTokens: 7, costUsd: 0 } } },
      { type: 'message.completed', data: { finishReason: 'stop', message: '- test\n- launch' } },
      { type: 'session.completed' },
    )
    let rest = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      rest += decoder.decode(value, { stream: true })
    }
    expect(rest).toBe('\n- launch')

    expect(hoisted.logUsage).toHaveBeenCalledTimes(1)
    const [userId, row] = hoisted.logUsage.mock.calls[0] as [string, Record<string, unknown>]
    expect(userId).toBe('user-1')
    expect(row).toMatchObject({
      // The provider of the model that ran, so (provider, model) hits its
      // mig 199 price row instead of the $15/$75 fallback.
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      feature: 'ai_complete',
      inputTokens: 210,
      outputTokens: 7,
    })
    expect(row.costUsd).toBeUndefined()
    expect(row.metadata).toBeUndefined()
    expect(typeof row.durationMs).toBe('number')
  })

  it("eve's non-zero cost reaches the usage row as-is", async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const res = await post({ context: 'x' })
    live.push(
      appended('y'),
      { type: 'step.completed', data: { usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.004 } } },
      { type: 'message.completed', data: { finishReason: 'stop', message: 'y' } },
      { type: 'session.completed' },
    )
    expect(await res.text()).toBe('y')
    expect(hoisted.logUsage).toHaveBeenCalledTimes(1)
    const [, row] = hoisted.logUsage.mock.calls[0] as [string, Record<string, unknown>]
    expect(row).toMatchObject({ feature: 'ai_complete', inputTokens: 10, outputTokens: 2, costUsd: 0.004 })
  })

  it('cached input tokens ride the usage metadata log_ai_usage discounts', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const res = await post({ context: 'x' })
    live.push(
      appended('z'),
      {
        type: 'step.completed',
        data: { usage: { inputTokens: 1000, outputTokens: 5, cacheReadTokens: 800, cacheWriteTokens: 100 } },
      },
      { type: 'message.completed', data: { finishReason: 'stop', message: 'z' } },
      { type: 'session.completed' },
    )
    expect(await res.text()).toBe('z')
    const [, row] = hoisted.logUsage.mock.calls[0] as [string, Record<string, unknown>]
    expect(row.metadata).toEqual({ cache_read_input_tokens: 800, cache_creation_input_tokens: 100 })
  })

  it('no workspace → the same fixed drafting model, no workspace on the token', async () => {
    hoisted.getCurrentWorkspaceId.mockResolvedValue(null)
    hoisted.createTaskSession.mockResolvedValue(liveSession().response)
    const res = await post({ context: 'x' })
    const headers = hoisted.clients[0].headers as Record<string, string>
    expect(verifyUtilityToken(headers['x-utility-run-token'])).toMatchObject({ workspaceId: null, model: 'deepseek-v4-flash' })
    await res.body!.cancel()
  })

  it('a session that cannot start is a 500, not an empty 200', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    hoisted.createTaskSession.mockRejectedValue(new Error('eve task-session create failed (503)'))
    const res = await post({ context: 'x' })
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Completion failed' })
    expect(hoisted.logUsage).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
  })

  it('missing context is a 400 and runs nothing', async () => {
    const res = await post({})
    expect(res.status).toBe(400)
    expect(hoisted.createTaskSession).not.toHaveBeenCalled()
  })

  it.each([
    ['file parts (data: URL)', [{ type: 'file', data: 'data:application/pdf;base64,JVBERi0=', mediaType: 'application/pdf' }]],
    ['file parts (https URL)', [{ type: 'file', data: 'https://example.com/a.pdf', mediaType: 'application/pdf' }]],
    ['an object', { type: 'text', text: 'x' }],
    ['a number', 42],
    ['an empty string', ''],
  ])('context as %s is a 400 and never reaches eve', async (_label, context) => {
    const res = await post({ context })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'context is required' })
    expect(hoisted.createTaskSession).not.toHaveBeenCalled()
    expect(hoisted.clients).toHaveLength(0)
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })

  it('a non-object JSON body is a 400, not a 500', async () => {
    const res = await post(null)
    expect(res.status).toBe(400)
    expect(hoisted.createTaskSession).not.toHaveBeenCalled()
  })

  it('the browser going away mid-stream cancels the eve session; no usage', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const res = await post({ context: 'x' })
    const reader = res.body!.getReader()
    live.push(appended('partial'))
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('partial')
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 0))
    expect(hoisted.cancel).toHaveBeenCalledTimes(1)
    live.push({ type: 'step.completed', data: { usage: { inputTokens: 1, outputTokens: 1 } } }, { type: 'session.completed' })
    await new Promise((r) => setTimeout(r, 10))
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })
})

describe('/api/ai/complete — wall clock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /**
   * Posts with `preWorkMs` = [auth, usage-limit check, model lookup] spent in
   * the route's awaits before the session starts. Spreading it across all
   * three pins the budget's start mark to the top of POST: moving it below
   * any of them drops that slice from the elapsed time.
   */
  async function postAfterPreWork([authMs, limitsMs, lookupMs]: [number, number, number]) {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    hoisted.authenticateUser.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(authMs)
      return { user: { id: 'user-1' } }
    })
    hoisted.checkUsageLimits.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(limitsMs)
    })
    hoisted.getCurrentWorkspaceId.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(lookupMs)
      return 'ws-1'
    })
    // A session that is created but never writes anything.
    hoisted.createTaskSession.mockResolvedValue(liveSession().response)
    return post({ context: 'x' })
  }

  /** postAfterPreWork, then the stream's first read (which the timeout rejects). */
  async function timeoutAfterPreWork(preWorkMs: [number, number, number]) {
    const res = await postAfterPreWork(preWorkMs)
    expect(res.status).toBe(200)
    const read = res.body!.getReader().read()
    let settled = false
    read.then(
      () => (settled = true),
      () => (settled = true),
    )
    return { read, isSettled: () => settled }
  }

  it('fast pre-work: the session keeps the kind\'s full timeout', async () => {
    const { read, isSettled } = await timeoutAfterPreWork([0, 0, 0])
    await vi.advanceTimersByTimeAsync(UTILITY_KIND_SPECS.note_continuation.timeoutMs - 1)
    expect(isSettled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(isSettled()).toBe(true)
    await expect(read).rejects.toThrow(`timed out after ${UTILITY_KIND_SPECS.note_continuation.timeoutMs}ms`)
    expect(hoisted.cancel).toHaveBeenCalledTimes(1)
  })

  it('slow pre-work comes out of the session timeout, so its cancel still lands inside maxDuration', async () => {
    // 7s auth + 7s usage-limit check + 6s lookup: 60s − 5s cancel − 2s tail − 20s = 33s left.
    const { read, isSettled } = await timeoutAfterPreWork([7_000, 7_000, 6_000])
    await vi.advanceTimersByTimeAsync(32_999)
    expect(isSettled()).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(isSettled()).toBe(true)
    await expect(read).rejects.toThrow('timed out after 33000ms')
    expect(hoisted.cancel).toHaveBeenCalledTimes(1)
    expect(20_000 + 33_000 + CANCEL_TIMEOUT_MS).toBeLessThan(maxDuration * 1000)
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })

  it('pre-work that leaves under 10s answers 503 and never starts an eve session', async () => {
    // 15s + 15s + 15s = 45s: 60s − 5s − 2s − 45s = 8s, under the 10s minimum.
    const res = await postAfterPreWork([15_000, 15_000, 15_000])
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Completion unavailable, try again', code: 'ROUTE_BUDGET_EXHAUSTED' })
    expect(hoisted.createTaskSession).not.toHaveBeenCalled()
    expect(hoisted.clients).toHaveLength(0)
    expect(hoisted.cancel).not.toHaveBeenCalled()
    expect(hoisted.logUsage).not.toHaveBeenCalled()
  })

  it('routeModelTimeoutMs: capped at the kind default, cut by elapsed time, null under 10s', () => {
    const kind = UTILITY_KIND_SPECS.note_continuation.timeoutMs
    const max = maxDuration * 1000
    expect(routeModelTimeoutMs(kind, 1_000, max, 1_000)).toBe(kind)
    expect(routeModelTimeoutMs(kind, 1_000, max, 4_000)).toBe(kind)
    expect(routeModelTimeoutMs(kind, 0, max, 10_000)).toBe(43_000)
    // Exactly the 10s minimum left still runs; one ms less does not.
    expect(routeModelTimeoutMs(kind, 0, max, 43_000)).toBe(10_000)
    expect(routeModelTimeoutMs(kind, 0, max, 43_001)).toBeNull()
    expect(routeModelTimeoutMs(kind, 0, max, 50_000)).toBeNull()
    // A clock that went backwards never grows the budget past the default.
    expect(routeModelTimeoutMs(kind, 5_000, max, 0)).toBe(kind)
  })

  it("note_continuation's timeout plus the post-timeout cancel end inside the route's maxDuration", () => {
    // Derived, not measured (see spec.ts): it must leave room for auth, the
    // model lookup and the usage write within the same function invocation.
    expect(UTILITY_KIND_SPECS.note_continuation.timeoutMs + CANCEL_TIMEOUT_MS).toBeLessThan(maxDuration * 1000)
  })
})
