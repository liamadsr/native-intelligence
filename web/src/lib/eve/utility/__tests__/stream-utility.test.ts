/**
 * streamUtilityText — the streaming sibling of runUtilityTask, for note
 * continuation (/api/ai/complete).
 *
 * Pinned:
 *   - the same TASK session on /eve/utility as runUtilityTask: the prompt as
 *     the message verbatim, no outputSchema, a token carrying the kind, the
 *     tenancy and the caller's model;
 *   - INCREMENTAL: each message.appended delta reaches the reader while the
 *     session is still running — nothing waits for the answer to finish;
 *     reasoning deltas are never forwarded; a message.completed carrying text
 *     the deltas did not is sent once, never duplicated;
 *   - the stream stops at the session's terminal event, though the live
 *     stream stays open after it;
 *   - onCompleted gets the text, the model and step.completed usage (eve's 0
 *     cost → null) and is AWAITED before the stream closes; it never runs for
 *     a failed, timed-out or abandoned session, and its throw never reaches
 *     the reader;
 *   - a session that cannot start rejects (the route answers 500); one that
 *     fails, parks or ends early errors the stream;
 *   - a timeout (create or stream) or the reader going away cancels the eve
 *     session so it stops spending;
 *   - the session is RETIRED, in the background (after(), or floating outside
 *     a request scope), once the boundary has been read or reading is given
 *     up (failure, timeout, reader gone); never while deltas are still
 *     arriving; the close never waits on it, and a failed retire never
 *     reaches the reader.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  attached: [] as string[],
  cancel: vi.fn(async (..._a: unknown[]) => ({ status: 'accepted' })),
  createTaskSession: vi.fn(),
  retireTaskSession: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
  order: [] as string[],
  after: vi.fn((_work: unknown): void => {
    throw new Error('outside a request scope')
  }),
  surfaceModel: vi.fn((..._a: unknown[]): unknown => 'claude-haiku-4-5-20251001'),
}))

vi.mock('eve/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('eve/client')>()),
  Client: class {
    sessions = {
      attach: (id: string) => {
        hoisted.attached.push(id)
        return { cancel: hoisted.cancel }
      },
    }
    constructor(opts: Record<string, unknown>) {
      hoisted.clients.push(opts)
    }
  },
}))
vi.mock('@/lib/eve/task-session', () => ({
  createTaskSession: hoisted.createTaskSession,
  retireTaskSession: hoisted.retireTaskSession,
}))
vi.mock('@/lib/ai/model-defaults', () => ({ surfaceModel: hoisted.surfaceModel }))
vi.mock('next/server', () => ({ after: (work: unknown) => hoisted.after(work) }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))

const { streamUtilityText, UtilitySessionError } = await import('../run-utility')
const { verifyUtilityToken } = await import('@/lib/eve/utility-run-token')

const appended = (messageDelta: string, messageSoFar = '') => ({
  type: 'message.appended',
  data: { messageDelta, messageSoFar, sequence: 0, stepIndex: 0, turnId: 't1' },
})
const reasoning = (reasoningDelta: string) => ({
  type: 'reasoning.appended',
  data: { reasoningDelta, reasoningSoFar: reasoningDelta, sequence: 0, stepIndex: 0, turnId: 't1' },
})
const completedMessage = (message: string) => ({ type: 'message.completed', data: { finishReason: 'stop', message } })
const stepCompleted = (inputTokens: number, outputTokens: number, costUsd?: number) => ({
  type: 'step.completed',
  data: { usage: { inputTokens, outputTokens, ...(costUsd !== undefined ? { costUsd } : {}) } },
})

/**
 * A live session the test feeds one event at a time. Iterating it blocks
 * until the test pushes the next event, like a real eve stream waiting on
 * the model; it never ends on its own unless told to.
 */
function liveSession(sessionId = 'sess-s') {
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  let ended = false
  const nudge = () => {
    const w = wake
    wake = null
    w?.()
  }
  return {
    push(...events: unknown[]) {
      queue.push(...events)
      nudge()
    },
    end() {
      ended = true
      nudge()
    },
    response: {
      sessionId,
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift()
          if (ended) return
          await new Promise<void>((r) => (wake = r))
        }
      },
    },
  }
}

/** Read everything; resolves with the chunks, rejects with the stream's error. */
async function drain(stream: ReadableStream<string>): Promise<string[]> {
  const chunks: string[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return chunks
    chunks.push(value)
  }
}

const base = { kind: 'note_continuation' as const, workspaceId: 'ws-1', userId: 'user-1', model: 'deepseek-v4-flash' }

beforeEach(() => {
  process.env.UTILITY_INTERNAL_SECRET = 'sec'
  hoisted.clients.length = 0
  hoisted.attached.length = 0
  hoisted.cancel.mockReset()
  hoisted.cancel.mockResolvedValue({ status: 'accepted' })
  hoisted.createTaskSession.mockReset()
  hoisted.retireTaskSession.mockReset()
  hoisted.retireTaskSession.mockImplementation(async () => {
    hoisted.order.push('retire')
    return true
  })
  hoisted.order.length = 0
  hoisted.after.mockReset()
  hoisted.after.mockImplementation(() => {
    throw new Error('outside a request scope')
  })
  hoisted.surfaceModel.mockClear()
})
afterEach(() => {
  delete process.env.UTILITY_INTERNAL_SECRET
  vi.restoreAllMocks()
})

describe('streamUtilityText — the session', () => {
  it('creates a task session on /eve/utility: prompt verbatim, no schema, token with kind, tenancy and model', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const out = await streamUtilityText({ ...base, message: '# Notes\n\n- first point' })

    expect(out.model).toBe('deepseek-v4-flash')
    expect(out.sessionId).toBe('sess-s')
    expect(hoisted.surfaceModel).not.toHaveBeenCalled()
    const client = hoisted.clients[0]
    expect(client.host).toBe('http://localhost:3000/eve/utility')
    expect(client.redirect).toBe('error')
    const headers = client.headers as Record<string, string>
    expect(headers['x-utility-run-kind']).toBe('note_continuation')
    expect(verifyUtilityToken(headers['x-utility-run-token'])).toMatchObject({
      kind: 'note_continuation',
      workspaceId: 'ws-1',
      userId: 'user-1',
      model: 'deepseek-v4-flash',
      params: {},
    })
    const [, opts] = hoisted.createTaskSession.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(opts.message).toBe('# Notes\n\n- first point')
    expect(opts).not.toHaveProperty('outputSchema')
    await out.stream.cancel()
  })

  it('resolves the model on the drafting surface when the caller did not', async () => {
    hoisted.createTaskSession.mockResolvedValue(liveSession().response)
    const supabase = { s: 1 } as never
    const out = await streamUtilityText({ ...base, model: undefined, supabase, message: 'm' })
    expect(hoisted.surfaceModel).toHaveBeenCalledWith('drafting')
    expect(out.model).toBe('claude-haiku-4-5-20251001')
    await out.stream.cancel()
  })

  it('rejects before streaming when the secret is missing or the create fails', async () => {
    delete process.env.UTILITY_INTERNAL_SECRET
    await expect(streamUtilityText({ ...base, message: 'm' })).rejects.toThrow(/UTILITY_INTERNAL_SECRET/)
    process.env.UTILITY_INTERNAL_SECRET = 'sec'
    hoisted.createTaskSession.mockRejectedValue(new Error('eve task-session create failed (503)'))
    await expect(streamUtilityText({ ...base, message: 'm' })).rejects.toThrow(/create failed \(503\)/)
  })

  it('a create still in flight at the timeout rejects, and the session it then names is cancelled', async () => {
    let land!: (v: unknown) => void
    hoisted.createTaskSession.mockReturnValue(new Promise((r) => (land = r)))
    const pending = streamUtilityText({ ...base, message: 'm', timeoutMs: 20 })
    setTimeout(() => land(liveSession('sess-late').response), 60)
    await expect(pending).rejects.toThrow(/note_continuation timed out after 20ms/)
    expect(hoisted.attached).toEqual(['sess-late'])
    expect(hoisted.cancel).toHaveBeenCalledTimes(1)
    // ...and then retired, so retention 0 purges its prompt now.
    expect(hoisted.retireTaskSession).toHaveBeenCalledTimes(1)
    expect(hoisted.retireTaskSession.mock.calls[0][1]).toBe('sess-late')
  })
})

describe('streamUtilityText — incremental delivery', () => {
  it('each delta reaches the reader while the session is still writing', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const onCompleted = vi.fn()
    const { stream } = await streamUtilityText({ ...base, message: 'm', onCompleted })
    const reader = stream.getReader()

    live.push(appended('The next'))
    expect(await reader.read()).toEqual({ done: false, value: 'The next' })
    // Nothing else has been written yet; the first chunk did not wait for it.
    live.push(reasoning('thinking…'), appended(' step is'))
    expect(await reader.read()).toEqual({ done: false, value: ' step is' })
    live.push(appended(' shipping.'))
    expect(await reader.read()).toEqual({ done: false, value: ' shipping.' })
    expect(onCompleted).not.toHaveBeenCalled()

    // The answer ends; the live stream stays open after session.completed.
    live.push(stepCompleted(120, 9, 0), completedMessage('The next step is shipping.'), { type: 'session.completed' })
    expect(await reader.read()).toEqual({ done: true, value: undefined })
    expect(onCompleted).toHaveBeenCalledWith({
      text: 'The next step is shipping.',
      model: 'deepseek-v4-flash',
      usage: { inputTokens: 120, outputTokens: 9, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 },
    })
  })

  it('a message.completed with text no delta carried is sent once; one the deltas already carried is not repeated', async () => {
    const quiet = liveSession()
    hoisted.createTaskSession.mockResolvedValue(quiet.response)
    const a = await streamUtilityText({ ...base, message: 'm' })
    quiet.push(completedMessage('Whole answer at once.'), { type: 'session.completed' })
    expect(await drain(a.stream)).toEqual(['Whole answer at once.'])

    const streamed = liveSession()
    hoisted.createTaskSession.mockResolvedValue(streamed.response)
    const b = await streamUtilityText({ ...base, message: 'm' })
    streamed.push(appended('Whole '), appended('answer.'), completedMessage('Whole answer.'), { type: 'session.completed' })
    expect(await drain(b.stream)).toEqual(['Whole ', 'answer.'])
  })

  it('usage is logged BEFORE the stream closes, and a non-zero eve cost passes through', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    let finishLog!: () => void
    const onCompleted = vi.fn(() => new Promise<void>((r) => (finishLog = r)))
    const { stream } = await streamUtilityText({ ...base, message: 'm', onCompleted })
    const reader = stream.getReader()
    live.push(appended('x'), stepCompleted(10, 2, 0.004), { type: 'session.completed' })
    expect((await reader.read()).value).toBe('x')

    let closed = false
    const last = reader.read().then((r) => {
      closed = r.done
      return r
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(onCompleted).toHaveBeenCalledTimes(1)
    expect(onCompleted.mock.calls[0]).toEqual([expect.objectContaining({ usage: expect.objectContaining({ costUsd: 0.004 }) })])
    expect(closed).toBe(false)
    finishLog()
    expect((await last).done).toBe(true)
  })

  it('a throwing onCompleted is logged; the reader still gets a clean end', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { stream } = await streamUtilityText({
      ...base,
      message: 'm',
      onCompleted: async () => {
        throw new Error('usage RPC down')
      },
    })
    live.push(appended('ok'), { type: 'session.completed' })
    expect(await drain(stream)).toEqual(['ok'])
    expect(error).toHaveBeenCalled()
  })
})

describe('streamUtilityText — failures', () => {
  it('a failed session errors the stream after the text it did write; no usage', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const onCompleted = vi.fn()
    const { stream } = await streamUtilityText({ ...base, message: 'm', onCompleted })
    const reader = stream.getReader()
    live.push(appended('partial'))
    expect((await reader.read()).value).toBe('partial')
    live.push({
      type: 'session.failed',
      data: { code: 'TURN_FAILED', details: { semanticErrorId: 'model-call-failed' } },
    })
    const err = await reader.read().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(UtilitySessionError)
    expect((err as Error).message).toBe('[utility] note_continuation session failed (TURN_FAILED: model-call-failed)')
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('a stream that ends without a terminal event is a failure, never a silent success', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const onCompleted = vi.fn()
    const { stream } = await streamUtilityText({ ...base, message: 'm', onCompleted })
    live.push(appended('half'))
    live.end()
    await expect(drain(stream)).rejects.toThrow(/note_continuation session ended-early/)
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('a parked session errors the stream', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const { stream } = await streamUtilityText({ ...base, message: 'm' })
    live.push({ type: 'session.waiting', data: {} })
    await expect(drain(stream)).rejects.toThrow(/session waiting/)
  })

  it('a non-string message (file parts) is refused before any session or client exists', async () => {
    const fileParts = [{ type: 'file', data: 'data:application/pdf;base64,JVBERi0=', mediaType: 'application/pdf' }]
    await expect(
      // The type forbids it; a caller casting a request body must still be stopped.
      streamUtilityText({ ...base, message: fileParts as unknown as string }),
    ).rejects.toThrow(/note_continuation streams a text message only/)
    expect(hoisted.createTaskSession).not.toHaveBeenCalled()
    expect(hoisted.clients).toHaveLength(0)
  })

  it('a timeout mid-stream cancels the eve session and errors the stream; no usage', async () => {
    const live = liveSession('sess-slow')
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const onCompleted = vi.fn()
    const { stream } = await streamUtilityText({ ...base, message: 'm', onCompleted, timeoutMs: 30 })
    const reader = stream.getReader()
    live.push(appended('slow '))
    expect((await reader.read()).value).toBe('slow ')
    await expect(reader.read()).rejects.toThrow(/note_continuation timed out after 30ms/)
    expect(hoisted.attached).toEqual(['sess-slow'])
    expect(hoisted.cancel).toHaveBeenCalledTimes(1)
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('the reader going away cancels the eve session; no usage', async () => {
    const live = liveSession('sess-gone')
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const onCompleted = vi.fn()
    const { stream } = await streamUtilityText({ ...base, message: 'm', onCompleted })
    const reader = stream.getReader()
    live.push(appended('a'))
    expect((await reader.read()).value).toBe('a')
    // A read is in flight when the browser disconnects.
    const inFlight = reader.read()
    await reader.cancel()
    expect(await inFlight).toEqual({ done: true, value: undefined })
    expect(hoisted.attached).toEqual(['sess-gone'])
    expect(hoisted.cancel).toHaveBeenCalledTimes(1)
    // Events that land after the cancel are dropped quietly.
    live.push(appended('b'), { type: 'session.completed' })
    await new Promise((r) => setTimeout(r, 10))
    expect(onCompleted).not.toHaveBeenCalled()
  })

  it('a session that already finished is not cancelled when the reader lets go', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const { stream } = await streamUtilityText({ ...base, message: 'm' })
    live.push(appended('done'), { type: 'session.completed' })
    expect(await drain(stream)).toEqual(['done'])
    await stream.cancel().catch(() => {})
    expect(hoisted.cancel).not.toHaveBeenCalled()
  })
})

describe('streamUtilityText — session retire', () => {
  it('retires only after the boundary, before onCompleted, and the close never waits on it', async () => {
    const live = liveSession('sess-r')
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const handed: Promise<unknown>[] = []
    hoisted.after.mockImplementation((work: unknown) => { handed.push(work as Promise<unknown>) })
    hoisted.retireTaskSession.mockImplementation(() => {
      hoisted.order.push('retire')
      return new Promise<boolean>(() => {})
    })
    const onCompleted = vi.fn(async () => { hoisted.order.push('onCompleted') })
    const { stream } = await streamUtilityText({ ...base, message: 'm', onCompleted })
    const reader = stream.getReader()
    live.push(appended('a'))
    expect((await reader.read()).value).toBe('a')
    expect(hoisted.retireTaskSession).not.toHaveBeenCalled()

    live.push(appended('b'), { type: 'session.completed' })
    expect((await reader.read()).value).toBe('b')
    // The retire never settles, yet the stream closes.
    expect((await reader.read()).done).toBe(true)
    expect(hoisted.order).toEqual(['retire', 'onCompleted'])
    expect(hoisted.retireTaskSession.mock.calls[0][1]).toBe('sess-r')
    expect(hoisted.retireTaskSession).toHaveBeenCalledTimes(1)
    expect(hoisted.after).toHaveBeenCalledTimes(1)
    expect(handed).toHaveLength(1)
  })

  it('a failed session is retired after its failure was read', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const { stream } = await streamUtilityText({ ...base, message: 'm' })
    live.push({ type: 'session.failed', data: { code: 'TURN_FAILED' } })
    await expect(drain(stream)).rejects.toThrow(/session failed/)
    expect(hoisted.retireTaskSession).toHaveBeenCalledTimes(1)
  })

  it('a timeout cancels, then retires', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    hoisted.cancel.mockImplementation(async () => {
      hoisted.order.push('cancel')
      return { status: 'accepted' }
    })
    const { stream } = await streamUtilityText({ ...base, message: 'm', timeoutMs: 20 })
    await expect(drain(stream)).rejects.toThrow(/timed out after 20ms/)
    expect(hoisted.order).toEqual(['cancel', 'retire'])
  })

  it('the reader going away cancels, then retires, once', async () => {
    const live = liveSession()
    hoisted.createTaskSession.mockResolvedValue(live.response)
    hoisted.cancel.mockImplementation(async () => {
      hoisted.order.push('cancel')
      return { status: 'accepted' }
    })
    const { stream } = await streamUtilityText({ ...base, message: 'm' })
    const reader = stream.getReader()
    live.push(appended('a'))
    expect((await reader.read()).value).toBe('a')
    await reader.cancel()
    expect(hoisted.order).toEqual(['cancel', 'retire'])
  })

  it('a failing retire logs one line; the reader still gets every chunk and a clean end', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoisted.retireTaskSession.mockRejectedValue(new Error('reset 500'))
    const live = liveSession('sess-w')
    hoisted.createTaskSession.mockResolvedValue(live.response)
    const { stream } = await streamUtilityText({ ...base, message: 'm' })
    live.push(appended('ok'), { type: 'session.completed' })
    expect(await drain(stream)).toEqual(['ok'])
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(String(warn.mock.calls[0][0])).toMatch(/note_continuation retiring session sess-w failed/)
  })
})
