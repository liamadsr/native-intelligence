/**
 * runUtilityTask — the one dispatcher every ported generator calls.
 *
 * Pinned:
 *   - the session is a TASK session on the /eve/utility mount, created with the
 *     caller's prompt as the message VERBATIM and (for structured kinds) the
 *     schema as its outputSchema;
 *   - the signed token carries the kind, tenancy, params and the RESOLVED bare
 *     model — and the result reports that same model, so logUsage records the
 *     model the session ran on;
 *   - usage is summed from step.completed; eve's 0 cost becomes null (the RPC
 *     then prices from ai_model_costs);
 *   - a failed session, an off-schema object, a timeout and a missing secret
 *     all THROW, like generateText/generateObject did;
 *   - the timeout is the KIND's default when the caller passes none, covers
 *     the stream read as well as the create (even a stream that ignores the
 *     abort signal), and cancels the timed-out session so it stops spending —
 *     including a session whose create response only lands after the
 *     deadline (bounded wait; a create that never returns is aborted and
 *     logged; the whole post-timeout path stays inside the 5s budget);
 *   - every kind keeps its pre-port model surface;
 *   - the session is RETIRED once its answer (or failure) has been read —
 *     never before the boundary event — on success, failure, timeout and
 *     caller cancel, and a late-created session after its cancel; the retire
 *     runs in the BACKGROUND (handed to next/server after(), or floating
 *     outside a request scope), so the result never waits on it, and a
 *     failed or hung retire never changes the result.
 */
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const hoisted = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  attached: [] as string[],
  cancel: vi.fn(async (..._a: unknown[]) => ({ status: 'accepted' })),
  createTaskSession: vi.fn(),
  retireTaskSession: vi.fn(async (..._a: unknown[]): Promise<boolean> => true),
  order: [] as string[],
  /** next/server after(): throws by default, as outside a request scope. */
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

const { runUtilityTask, UtilitySessionError, webSearchSourcesOf } = await import('../run-utility')
const { verifyUtilityToken, UTILITY_KINDS } = await import('@/lib/eve/utility-run-token')
const { EMAIL_DRAFT_REPLY_TIMEOUT_MS, UTILITY_KIND_SPECS } = await import('../spec')

function stepCompleted(inputTokens: number, outputTokens: number, costUsd?: number) {
  return { type: 'step.completed', data: { usage: { inputTokens, outputTokens, ...(costUsd !== undefined ? { costUsd } : {}) } } }
}

/** A task-session response streaming `events`, then hanging open (like the live stream does after session.completed). */
function streaming(events: unknown[], opts: { hangAfter?: boolean; sessionId?: string } = {}) {
  return {
    sessionId: opts.sessionId ?? 'sess-1',
    async *[Symbol.asyncIterator]() {
      for (const ev of events) yield ev
      if (opts.hangAfter ?? true) await new Promise(() => {})
    },
  }
}

/** A completed session: optional step events, the final message, an optional structured result. */
function respond(result: { message?: string; data?: unknown; events?: unknown[] }) {
  const events: unknown[] = [...(result.events ?? [])]
  if (result.message !== undefined) {
    events.push({ type: 'message.completed', data: { finishReason: 'stop', message: result.message } })
  }
  if ('data' in result && result.data !== undefined) events.push({ type: 'result.completed', data: { result: result.data } })
  events.push({ type: 'session.completed' })
  hoisted.createTaskSession.mockResolvedValue(streaming(events))
}

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
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('runUtilityTask — the web-research agent', () => {
  it("dispatches plan_web_search to the web-research mount on the person's plan, with the pages its searches returned", async () => {
    const { z } = await import('zod')
    respond({
      data: { ok: true },
      events: [
        { type: 'action.result', data: { result: { toolName: 'web_search', output: { action: { type: 'search' }, sources: [{ type: 'url', url: 'https://acme.com/about' }, { type: 'api', name: 'x' }] } } } },
        { type: 'action.result', data: { result: { toolName: 'web_search', output: { sources: [{ type: 'url', url: 'https://acme.com/about' }, { type: 'url', url: 'javascript:1' }] } } } },
        { type: 'action.result', data: { result: { toolName: 'web_search', output: { action: { type: 'openPage', url: 'https://acme.com/team' } } } } },
        stepCompleted(500, 40),
      ],
    })
    const out = await runUtilityTask({
      kind: 'plan_web_search', workspaceId: 'ws-1', userId: 'user-1', chatgptPlan: true, planModel: 'gpt-6-luna',
      message: '{"query":"acme"}', outputSchema: z.object({ ok: z.boolean() }),
    })
    const client = hoisted.clients[0]
    expect(client.host).toBe('http://localhost:3000/eve/web-research')
    const claims = verifyUtilityToken((client.headers as Record<string, string>)['x-utility-run-token'])
    expect(claims).toMatchObject({ kind: 'plan_web_search', userId: 'user-1', model: 'chatgpt-plan/gpt-6-luna' })
    expect(out.model).toBe('chatgpt-plan/gpt-6-luna')
    expect(out.webSources).toEqual(['https://acme.com/about', 'https://acme.com/team'])
    expect(out.webSearches).toBe(3)
  })

  it('reads no sources from a stream that carries none', () => {
    expect(webSearchSourcesOf([{ type: 'step.completed', data: {} }] as never)).toEqual([])
  })
})

describe('runUtilityTask', () => {
  it('creates a task session on /eve/utility with the prompt verbatim and a token carrying the resolved model', async () => {
    respond({ message: 'Q3 renewal', events: [stepCompleted(80, 6, 0)] })
    const supabase = { user: true } as never
    const out = await runUtilityTask({
      kind: 'draft_followup',
      supabase,
      workspaceId: 'ws-1',
      userId: 'user-1',
      message: 'Meeting: Q3\n\nSummary:\nstuff',
      params: { tone: 'casual' },
    })

    // Model resolved once, on the kind's surface (its fixed model).
    expect(hoisted.surfaceModel).toHaveBeenCalledWith('drafting')

    const client = hoisted.clients[0]
    expect(client.host).toBe('http://localhost:3000/eve/utility')
    expect(client.auth).toEqual({ bearer: 'sec' })
    expect(client.redirect).toBe('error')
    const headers = client.headers as Record<string, string>
    expect(headers['x-utility-run-secret']).toBe('sec')
    expect(headers['x-utility-run-kind']).toBe('draft_followup')
    const claims = verifyUtilityToken(headers['x-utility-run-token'])
    expect(claims).toMatchObject({
      kind: 'draft_followup',
      workspaceId: 'ws-1',
      userId: 'user-1',
      model: 'claude-haiku-4-5-20251001',
      params: { tone: 'casual' },
    })

    const [, opts] = hoisted.createTaskSession.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(opts.message).toBe('Meeting: Q3\n\nSummary:\nstuff')
    expect(opts.outputSchema).toBeUndefined()
    expect(opts.signal).toBeInstanceOf(AbortSignal)

    expect(out).toEqual({
      text: 'Q3 renewal',
      model: 'claude-haiku-4-5-20251001',
      usage: { inputTokens: 80, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: null, steps: 1 },
    })
  })

  it('uses a caller-resolved model without re-reading settings', async () => {
    respond({ message: 'x' })
    const out = await runUtilityTask({
      kind: 'knowledge_weaver_judge',
      model: 'deepseek-v4-flash',
      workspaceId: 'ws-1',
      userId: null,
      message: 'm',
    })
    expect(hoisted.surfaceModel).not.toHaveBeenCalled()
    expect(out.model).toBe('deepseek-v4-flash')
    const headers = hoisted.clients[0].headers as Record<string, string>
    expect(headers['x-utility-run-user']).toBeUndefined()
    expect(verifyUtilityToken(headers['x-utility-run-token'])?.userId).toBeNull()
  })

  it('no workspace → the same surface model (the workspace no longer matters)', async () => {
    respond({ message: 'x' })
    const out = await runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm' })
    expect(out.model).toBe('claude-haiku-4-5-20251001')
    expect(hoisted.surfaceModel).toHaveBeenCalledWith('drafting')
  })

  it('dispatches to the address in NEXT_PUBLIC_APP_URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://staging.example')
    respond({ message: 'x' })
    await runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm' })
    expect(hoisted.clients[0].host).toBe('https://staging.example/eve/utility')
  })

  it('passes a non-zero eve cost through', async () => {
    respond({ message: 'x', events: [stepCompleted(1, 2, 0.002), stepCompleted(3, 4, 0.001)] })
    const out = await runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm' })
    expect(out.usage).toEqual({ inputTokens: 4, outputTokens: 6, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.003, steps: 2 })
  })

  it('carries the cached-input counts so the usage row can be cache-priced', async () => {
    respond({
      message: 'x',
      events: [
        { type: 'step.completed', data: { usage: { inputTokens: 500, outputTokens: 2, cacheReadTokens: 400, cacheWriteTokens: 50 } } },
        { type: 'step.completed', data: { usage: { inputTokens: 500, outputTokens: 2, cacheReadTokens: 450 } } },
      ],
    })
    const out = await runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm' })
    expect(out.usage).toMatchObject({ inputTokens: 1000, cacheReadTokens: 850, cacheWriteTokens: 50 })
    expect(usageCacheMetadata(out.usage)).toEqual({ cache_read_input_tokens: 850, cache_creation_input_tokens: 50 })
  })

  it('structured kinds send the schema and return the validated object', async () => {
    const schema = z.object({ description: z.string() })
    respond({ data: { description: 'When the user triages tickets.' }, message: '' })
    const out = await runUtilityTask({
      kind: 'skill_draft',
      workspaceId: null,
      userId: 'u',
      message: 'Skill prompt:\n\nx',
      outputSchema: schema,
    })
    expect(out.object).toEqual({ description: 'When the user triages tickets.' })
    const [, opts] = hoisted.createTaskSession.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(opts.outputSchema).toBe(schema)
  })

  it('throws when the structured result does not match the schema (or is missing)', async () => {
    const schema = z.object({ description: z.string() })
    respond({ data: { nope: 1 } })
    await expect(
      runUtilityTask({ kind: 'skill_draft', workspaceId: null, userId: 'u', message: 'm', outputSchema: schema }),
    ).rejects.toThrow(/no valid structured output/)
    respond({ message: 'no result event' })
    await expect(
      runUtilityTask({ kind: 'skill_draft', workspaceId: null, userId: 'u', message: 'm', outputSchema: schema }),
    ).rejects.toThrow(/no valid structured output/)
  })

  it('throws on a failed (or parked) session', async () => {
    hoisted.createTaskSession.mockResolvedValue(
      streaming([{ type: 'session.failed', data: { code: 'MODEL_CALL_FAILED', message: 'x', sessionId: 's' } }]),
    )
    await expect(runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm' })).rejects.toThrow(
      /generate_title session failed/,
    )
    hoisted.createTaskSession.mockResolvedValue(streaming([{ type: 'session.waiting', data: {} }]))
    await expect(runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm' })).rejects.toThrow(
      /session waiting/,
    )
  })

  it("a failed session's eve classification rides the error (empty model response is recognisable)", async () => {
    hoisted.createTaskSession.mockResolvedValue(
      streaming([
        {
          type: 'session.failed',
          data: {
            code: 'MODEL_CALL_FAILED',
            message: 'The model did not return a response.',
            details: { semanticErrorId: 'empty-model-response' },
            sessionId: 's',
          },
        },
      ]),
    )
    const err = await runUtilityTask({ kind: 'knowledge_brief', workspaceId: null, userId: null, message: 'm' }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(UtilitySessionError)
    const e = err as InstanceType<typeof UtilitySessionError>
    expect(e.message).toBe('[utility] knowledge_brief session failed (MODEL_CALL_FAILED: empty-model-response)')
    expect(e.isEmptyModelResponse).toBe(true)
    expect(e.code).toBe('MODEL_CALL_FAILED')
  })

  it('a stream that closes without a terminal event is a failure, not an empty success', async () => {
    hoisted.createTaskSession.mockResolvedValue(
      streaming([{ type: 'message.completed', data: { finishReason: 'stop', message: 'half' } }], { hangAfter: false }),
    )
    await expect(runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm' })).rejects.toThrow(
      /session ended-early/,
    )
  })

  it('returns at session.completed without waiting for the stream to close', async () => {
    // streaming() hangs forever after its last event; resolving at all proves
    // the read stops at the boundary.
    respond({ message: 'Done' })
    const out = await runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm', timeoutMs: 5_000 })
    expect(out.text).toBe('Done')
  })

  it('the answer is the final message, not a tool-calls step message', async () => {
    respond({
      events: [{ type: 'message.completed', data: { finishReason: 'tool-calls', message: 'thinking…' } }],
      message: 'Final',
    })
    const out = await runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm' })
    expect(out.text).toBe('Final')
  })

  it('aborts at the timeout and throws', async () => {
    hoisted.createTaskSession.mockImplementation(
      async (_c: unknown, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    await expect(
      runUtilityTask({ kind: 'email_draft_reply', workspaceId: 'ws', userId: 'u', model: 'm', message: 'm', params: { tone: 't', userName: 'n' }, timeoutMs: 20 }),
    ).rejects.toThrow(/email_draft_reply timed out after 20ms/)
  })

  it('a create that returns AFTER the timeout: the session it started is cancelled', async () => {
    // The server accepted the create (the session exists and is generating)
    // but its response lands after our deadline. The create POST runs on its
    // own later signal, so the response still arrives and names the session.
    let createSignal: AbortSignal | undefined
    hoisted.createTaskSession.mockImplementation(
      async (_c: unknown, opts: { createSignal: AbortSignal }) => {
        createSignal = opts.createSignal
        await new Promise((r) => setTimeout(r, 60))
        return streaming([], { hangAfter: true, sessionId: 'sess-late' })
      },
    )
    await expect(
      runUtilityTask({ kind: 'knowledge_brief', workspaceId: 'ws', userId: null, model: 'm', message: 'm', timeoutMs: 20 }),
    ).rejects.toThrow(/knowledge_brief timed out after 20ms/)
    expect(createSignal?.aborted).toBe(false)
    expect(hoisted.attached).toEqual(['sess-late'])
    expect(hoisted.cancel).toHaveBeenCalledTimes(1)
  })

  it('a create that returns AFTER the timeout: the late session is cancelled, then retired', async () => {
    hoisted.cancel.mockImplementation(async () => {
      hoisted.order.push('cancel')
      return { status: 'accepted' }
    })
    hoisted.createTaskSession.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 60))
      return streaming([], { hangAfter: true, sessionId: 'sess-late' })
    })
    await expect(
      runUtilityTask({ kind: 'knowledge_brief', workspaceId: 'ws', userId: null, model: 'm', message: 'm', timeoutMs: 20 }),
    ).rejects.toThrow(/knowledge_brief timed out after 20ms/)
    expect(hoisted.order).toEqual(['cancel', 'retire'])
    expect(hoisted.retireTaskSession).toHaveBeenCalledTimes(1)
    expect(hoisted.retireTaskSession.mock.calls[0][1]).toBe('sess-late')
  })

  it('a create that never returns: gives up after the cancel budget, aborts the POST, cancels nothing, and says so', async () => {
    vi.useFakeTimers()
    // Like the real fetch: the create honours its signal and rejects on abort.
    // (A mock that ignores the signal would hide an early abort — the rejection
    // would read as a clean failure and the warning would never fire.)
    let createSignal: AbortSignal | undefined
    hoisted.createTaskSession.mockImplementation(
      (_c: unknown, opts: { createSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          createSignal = opts.createSignal
          opts.createSignal.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        }),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let settled = false
    const run = runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm', timeoutMs: 20 })
    run.then(
      () => (settled = true),
      () => (settled = true),
    )
    await vi.advanceTimersByTimeAsync(20)
    // Timed out, now waiting (bounded) for the create to name a session —
    // with the create POST still alive right up to the end of the budget.
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)
    expect(createSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(run).rejects.toThrow(/generate_title timed out after 20ms/)
    expect(createSignal?.aborted).toBe(true)
    expect(hoisted.cancel).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/create had not returned .* was not cancelled/)
    warn.mockRestore()
  })

  it('a late create cancels within what is LEFT of the 5s budget — the whole post-timeout path stays inside it', async () => {
    vi.useFakeTimers()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    hoisted.createTaskSession.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20 + 4_500))
      return streaming([], { hangAfter: true, sessionId: 'sess-very-late' })
    })
    const run = runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm', timeoutMs: 20 })
    run.catch(() => {})
    await vi.advanceTimersByTimeAsync(20 + 4_500)
    await expect(run).rejects.toThrow(/generate_title timed out after 20ms/)
    expect(hoisted.attached).toEqual(['sess-very-late'])
    const budgets = timeoutSpy.mock.calls.map((c) => c[0])
    expect(budgets).toHaveLength(1)
    expect(budgets[0]).toBeGreaterThan(0)
    expect(budgets[0]).toBeLessThanOrEqual(500)
    timeoutSpy.mockRestore()
  })

  it('a create that FAILS after the timeout needs no cancel and no warning', async () => {
    hoisted.createTaskSession.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 40))
      throw new Error('eve task-session create failed (500)')
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm', timeoutMs: 20 }),
    ).rejects.toThrow(/generate_title timed out after 20ms/)
    expect(hoisted.cancel).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('passes UserContent (text + file parts) through as the task message untouched', async () => {
    respond({ data: { ok: true } })
    const message = [
      { type: 'file' as const, data: 'data:application/pdf;base64,JVBERi0=', mediaType: 'application/pdf' },
      { type: 'text' as const, text: 'File name: spec.pdf' },
    ]
    await runUtilityTask({
      kind: 'reference_ingest_outline',
      model: 'claude-sonnet-4-5',
      workspaceId: 'ws',
      userId: 'u',
      message,
      outputSchema: z.object({ ok: z.boolean() }),
    })
    const [, opts] = hoisted.createTaskSession.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(opts.message).toBe(message)
  })

  it('throws before any network when no secret is configured', async () => {
    delete process.env.UTILITY_INTERNAL_SECRET
    await expect(runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm' })).rejects.toThrow(
      /not set/,
    )
    expect(hoisted.createTaskSession).not.toHaveBeenCalled()
  })
})

describe('runUtilityTask — timeouts', () => {
  /** A session that starts, then goes silent — and ignores the abort signal entirely. */
  function stalledIgnoringSignal() {
    return {
      sessionId: 'sess-stalled',
      async *[Symbol.asyncIterator]() {
        yield { type: 'session.started', data: {} }
        await new Promise(() => {})
      },
    }
  }

  it("email_draft_reply uses its kind default when the caller passes none, and it covers a stalled stream read", async () => {
    vi.useFakeTimers()
    hoisted.createTaskSession.mockResolvedValue(stalledIgnoringSignal())
    let settled = false
    const run = runUtilityTask({
      kind: 'email_draft_reply',
      workspaceId: 'ws',
      userId: 'u',
      model: 'deepseek-v4-flash',
      message: 'thread',
      params: { tone: 'brief', userName: 'n' },
    })
    run.then(
      () => (settled = true),
      () => (settled = true),
    )
    await vi.advanceTimersByTimeAsync(EMAIL_DRAFT_REPLY_TIMEOUT_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(run).rejects.toThrow(`email_draft_reply timed out after ${EMAIL_DRAFT_REPLY_TIMEOUT_MS}ms`)
    // The session it created is cancelled so it stops generating (and spending).
    expect(hoisted.attached).toEqual(['sess-stalled'])
    expect(hoisted.cancel).toHaveBeenCalledTimes(1)
  })

  it('a stream that rejects on abort after the create resolved also times out (and is cancelled)', async () => {
    hoisted.createTaskSession.mockImplementation(async (_c: unknown, opts: { signal: AbortSignal }) => ({
      sessionId: 'sess-2',
      async *[Symbol.asyncIterator]() {
        yield { type: 'session.started', data: {} }
        await new Promise((_r, reject) => opts.signal.addEventListener('abort', () => reject(new Error('stream aborted'))))
      },
    }))
    await expect(
      runUtilityTask({ kind: 'knowledge_brief', workspaceId: 'ws', userId: null, model: 'm', message: 'm', timeoutMs: 20 }),
    ).rejects.toThrow(/knowledge_brief timed out after 20ms/)
    expect(hoisted.attached).toEqual(['sess-2'])
  })

  it('a failing cancel never masks the timeout error', async () => {
    hoisted.cancel.mockRejectedValue(new Error('cancel route 500'))
    hoisted.createTaskSession.mockResolvedValue(stalledIgnoringSignal())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      runUtilityTask({ kind: 'generate_title', workspaceId: null, userId: 'u', message: 'm', timeoutMs: 20 }),
    ).rejects.toThrow(/generate_title timed out after 20ms/)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('every kind has a finite, positive timeout; email drafts bound a hang without cutting a measured-healthy draft', () => {
    for (const kind of UTILITY_KINDS) {
      const t = UTILITY_KIND_SPECS[kind].timeoutMs
      expect(Number.isFinite(t) && t > 0, kind).toBe(true)
    }
    expect(UTILITY_KIND_SPECS.email_draft_reply.timeoutMs).toBe(EMAIL_DRAFT_REPLY_TIMEOUT_MS)
    expect(EMAIL_DRAFT_REPLY_TIMEOUT_MS).toBe(45_000)
    // Slowest measured healthy draft (pre-port 40.0s, eve 20.7s) must fit…
    expect(EMAIL_DRAFT_REPLY_TIMEOUT_MS).toBeGreaterThan(40_041)
    // …and three hung drafts must leave most of email-management's 300s.
    expect(3 * EMAIL_DRAFT_REPLY_TIMEOUT_MS).toBeLessThan(300_000 / 2)
    // A reference-ingest segment step must end before its Inngest invocation (300s).
    expect(UTILITY_KIND_SPECS.reference_ingest_segment.timeoutMs).toBeLessThan(300_000)
    // claim_extraction had no timeout before the port (bounded only by its
    // 300s step) and its latency is unmeasured, so it only catches a hang:
    // the same "just short of the step" rule as a reference-ingest segment.
    expect(UTILITY_KIND_SPECS.claim_extraction.timeoutMs).toBe(UTILITY_KIND_SPECS.reference_ingest_segment.timeoutMs)
  })
})

describe('utility kinds keep their pre-port model surface', () => {
  // What each call site hard-coded before the port (its surface, now a fixed
  // model: SURFACE_MODELS). The 'knowledge' and 'drafting' defaults are the same
  // model, so a swap would be invisible anywhere else — pin it here.
  const PRE_PORT_SURFACE = {
    generate_title: 'drafting',
    skill_draft: 'drafting',
    browser_field_text: 'drafting',
    claim_extraction: 'knowledge',
    draft_followup: 'drafting',
    email_draft_reply: 'drafting',
    outreach_draft: 'drafting',
    knowledge_brief: 'knowledge',
    knowledge_weaver_judge: 'knowledge',
    knowledge_weaver_anchor_link: 'knowledge',
    reference_ingest_outline: 'document_ingest',
    reference_ingest_segment: 'document_ingest',
    // /api/ai/complete resolved 'drafting' itself and still does (it passes the model).
    note_continuation: 'drafting',
    // New on eve (row 15), no pre-port call: the knowledge summarisers' surface.
    agent_memory_summary: 'knowledge',
    // The nightly memory pass (one-agent plan Part 3): a background summariser too.
    memory_learn_mail_tone: 'knowledge',
    memory_capture: 'knowledge',
    // The quality layer's reviewer: callers always pass the model
    // (pickReviewerModel); 'drafting' is only the unused fallback.
    draft_review: 'drafting',
    // A coding run's pre-check (P10): the cheap drafting model.
    coding_precheck: 'drafting',
    // The coding reviewer: callers pass the model; 'drafting' is the fallback.
    code_review: 'drafting',
    // A Jev decision on a free user's own ChatGPT plan: only ever on the plan; nominal.
    plan_decision: 'drafting',
    // An eval judge on the run starter's ChatGPT plan: only ever on the plan; nominal.
    eval_judge: 'knowledge',
    // Plan-only too (the web-research agent): nominal.
    plan_web_search: 'knowledge',
    // The look-ahead's extraction: a new kind (no pre-port call), on the Fast surface like a decision.
    look_ahead_extract: 'drafting',
  } as const

  it.each(Object.entries(PRE_PORT_SURFACE))('%s resolves on %s', async (kind, surface) => {
    respond({ message: 'x', data: {} })
    const supabase = { s: true } as never
    await runUtilityTask({
      kind: kind as keyof typeof PRE_PORT_SURFACE,
      supabase,
      workspaceId: 'ws-1',
      userId: 'u',
      message: 'm',
      params: { tone: 't', userName: 'n' },
    })
    expect(hoisted.surfaceModel).toHaveBeenCalledWith(surface)
  })

  it('covers every kind', () => {
    expect(Object.keys(PRE_PORT_SURFACE).sort()).toEqual([...UTILITY_KINDS].sort())
  })
})

describe('caller cancellation and content-free partial usage', () => {
  it('does not resolve a model or create a session for an already cancelled caller', async () => {
    const controller = new AbortController()
    controller.abort()
    const onUsage = vi.fn()
    await expect(runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm', signal: controller.signal, onUsage })).rejects.toThrow('cancelled')
    expect(hoisted.surfaceModel).not.toHaveBeenCalled()
    expect(hoisted.createTaskSession).not.toHaveBeenCalled()
    expect(onUsage).not.toHaveBeenCalled()
  })

  it('cancels during model resolution and never dispatches when the read finishes late', async () => {
    const controller = new AbortController()
    let resolveModel!: (value: string) => void
    hoisted.surfaceModel.mockImplementationOnce(() => new Promise(resolve => { resolveModel = resolve }))
    const pending = runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm', signal: controller.signal })
    const rejection = expect(pending).rejects.toThrow('cancelled')
    controller.abort()
    await rejection
    resolveModel('deepseek-v4-flash')
    await Promise.resolve()
    expect(hoisted.createTaskSession).not.toHaveBeenCalled()
  })

  it('stops a non-cooperative stream, cancels Eve and reports incomplete known subtotals once', async () => {
    const controller = new AbortController()
    const onUsage = vi.fn()
    hoisted.createTaskSession.mockResolvedValue({
      sessionId: 'partial-session',
      async *[Symbol.asyncIterator]() {
        yield stepCompleted(12, 4, 0.001)
        controller.abort()
        await new Promise(() => {})
      },
    })
    await expect(runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm', signal: controller.signal, onUsage })).rejects.toThrow('cancelled')
    expect(hoisted.attached).toEqual(['partial-session'])
    expect(hoisted.cancel).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledWith(expect.objectContaining({ complete: false, inputTokensReported: true, outputTokensReported: true,
      usage: expect.objectContaining({ inputTokens: 12, outputTokens: 4, costUsd: 0.001 }), generationIds: [] }))
  })

  it('reports failed-session usage without treating the missing final generation as complete', async () => {
    const onUsage = vi.fn()
    hoisted.createTaskSession.mockResolvedValue(streaming([stepCompleted(12, 4), { type: 'session.failed', data: { code: 'failed' } }]))
    await expect(runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm', onUsage })).rejects.toThrow('failed')
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage.mock.calls[0][0]).toMatchObject({ complete: false, usage: { inputTokens: 12, outputTokens: 4, costUsd: null } })
  })

  it('distinguishes absent token reporting from reported zeros on a completed session', async () => {
    const onUsage = vi.fn()
    respond({ message: 'x', events: [{ type: 'step.completed', data: { usage: { inputTokens: 0 } } }] })
    await runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm', onUsage })
    expect(onUsage.mock.calls[0][0]).toMatchObject({ complete: true, inputTokensReported: true, outputTokensReported: false })
  })
})

describe('utility teardown after an interrupted transport', () => {
  it.each(['throws', 'closes'])('cancels an active session when its stream %s before a terminal event', async mode => {
    const onUsage = vi.fn()
    hoisted.createTaskSession.mockResolvedValue({
      sessionId: 'interrupted-session',
      async *[Symbol.asyncIterator]() {
        yield stepCompleted(12, 4)
        if (mode === 'throws') throw new Error('transport disconnected')
      },
    })
    await expect(runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm', onUsage })).rejects.toThrow()
    expect(hoisted.attached).toEqual(['interrupted-session'])
    expect(hoisted.cancel).toHaveBeenCalledTimes(1)
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage.mock.calls[0][0]).toMatchObject({ complete: false, usage: { inputTokens: 12, outputTokens: 4 } })
  })

  it.each(['completed', 'failed'])('does not cancel an observed %s session', async status => {
    hoisted.createTaskSession.mockResolvedValue(streaming([stepCompleted(12, 4), { type: `session.${status}`, data: {} }]))
    const promise = runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm' })
    if (status === 'failed') await expect(promise).rejects.toThrow('failed')
    else await promise
    expect(hoisted.cancel).not.toHaveBeenCalled()
  })

  it('bounds teardown even when the cancellation transport ignores its signal', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoisted.cancel.mockImplementation(() => new Promise(() => {}))
    hoisted.createTaskSession.mockResolvedValue(streaming([], { hangAfter: false }))
    const run = runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm' })
    const rejection = expect(run).rejects.toThrow('ended-early')
    await vi.advanceTimersByTimeAsync(5_000)
    await rejection
    expect(hoisted.cancel).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    vi.useRealTimers()
  })
})

describe('utility wall clock when timer callbacks are delayed', () => {
  // The runner reads its own start a moment after the test's, so the clock
  // jumps well past the deadline: start + 8_001 lands short of it on a loaded
  // build machine (the 10-22 prod build), and the deadline checks pass.
  const PAST_DEADLINE_MS = 60_000
  afterEach(() => vi.restoreAllMocks())

  it('does not dispatch if model resolution completes after the deadline before the timer callback runs', async () => {
    const start = Date.now()
    hoisted.surfaceModel.mockImplementationOnce(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(start + PAST_DEADLINE_MS)
      return 'deepseek-v4-flash'
    })
    await expect(runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm', timeoutMs: 8_000 })).rejects.toThrow('timed out')
    expect(hoisted.createTaskSession).not.toHaveBeenCalled()
  })

  it('does not accept a completed response beyond the wall-clock deadline and still reports usage', async () => {
    const start = Date.now()
    const onUsage = vi.fn()
    hoisted.createTaskSession.mockResolvedValue({
      sessionId: 'late-complete',
      async *[Symbol.asyncIterator]() {
        yield stepCompleted(12, 4)
        vi.spyOn(Date, 'now').mockReturnValue(start + PAST_DEADLINE_MS)
        yield { type: 'session.completed' }
      },
    })
    await expect(runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm', timeoutMs: 8_000, onUsage })).rejects.toThrow('timed out')
    expect(hoisted.cancel).not.toHaveBeenCalled()
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage.mock.calls[0][0]).toMatchObject({ complete: false, usage: { inputTokens: 12, outputTokens: 4 } })
  })
})

describe('utility call timeline', () => {
  it('reports eve stamps relative to session.started and app-side spans, leaving out missing stamps', async () => {
    const { utilityEveOffsets } = await import('../run-utility')
    const at = (ms: number) => ({ at: new Date(Date.UTC(2026, 9, 7, 19, 8, 43) + ms).toISOString() })
    const offsets = utilityEveOffsets([
      { type: 'session.started', data: {}, meta: at(0) },
      { type: 'turn.started', data: {}, meta: at(410) },
      { type: 'step.started', data: {}, meta: at(820) },
      { type: 'message.appended', data: {}, meta: at(1300) },
      { type: 'step.completed', data: {}, meta: at(1540) },
    ] as never)
    expect(offsets).toEqual({ turnStarted: 410, stepStarted: 820, firstOutput: 1300, stepCompleted: 1540 })
    // No stamps (or no session.started): nothing to report, and never a throw.
    expect(utilityEveOffsets([{ type: 'step.completed', data: {} }] as never)).toBeUndefined()
    expect(utilityEveOffsets([{ type: 'session.started', data: {}, meta: { at: 'not a date' } }] as never)).toBeUndefined()
  })

  it('still reports usage, with a timeline, when events carry no stamps', async () => {
    const onUsage = vi.fn()
    respond({ message: 'x', events: [{ type: 'step.completed', data: { usage: { inputTokens: 10, outputTokens: 2 } } }] })
    await runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm', onUsage })
    expect(onUsage).toHaveBeenCalledTimes(1)
    expect(onUsage.mock.calls[0][0].timeline).toMatchObject({ modelLookupMs: expect.any(Number), createMs: expect.any(Number), streamMs: expect.any(Number) })
    expect(onUsage.mock.calls[0][0].timeline).not.toHaveProperty('eve')
  })
})

describe('utility session retire (retention 0 purges its data once the run ends)', () => {
  /** Streams `events`, logging each yield to hoisted.order, then hangs open. */
  function logged(events: Array<{ type: string }>, sessionId = 'sess-r') {
    return {
      sessionId,
      async *[Symbol.asyncIterator]() {
        for (const ev of events) {
          hoisted.order.push(`yield:${ev.type}`)
          yield ev
        }
        await new Promise(() => {})
      },
    }
  }

  it('retires the session once, AFTER the boundary has been read, and returns the answer', async () => {
    hoisted.createTaskSession.mockResolvedValue(logged([
      stepCompleted(5, 2),
      { type: 'message.completed', data: { finishReason: 'stop', message: 'hello' } } as never,
      { type: 'session.completed' },
    ]))
    const out = await runUtilityTask({ kind: 'generate_title', workspaceId: 'ws', userId: 'u', message: 'm' })
    expect(out.text).toBe('hello')
    expect(hoisted.retireTaskSession).toHaveBeenCalledTimes(1)
    const [client, sessionId, opts] = hoisted.retireTaskSession.mock.calls[0] as [unknown, string, { timeoutMs: number }]
    expect(client).toBeDefined()
    expect(sessionId).toBe('sess-r')
    expect(opts.timeoutMs).toBe(1_500)
    expect(hoisted.order).toEqual(['yield:step.completed', 'yield:message.completed', 'yield:session.completed', 'retire'])
  })

  it('retires a failed session after its failure was read, and the error is unchanged', async () => {
    hoisted.createTaskSession.mockResolvedValue(logged([{ type: 'session.failed', data: { code: 'failed' } } as never]))
    await expect(runUtilityTask({ kind: 'generate_title', workspaceId: 'ws', userId: 'u', message: 'm' }))
      .rejects.toThrow('[utility] generate_title session failed')
    expect(hoisted.order).toEqual(['yield:session.failed', 'retire'])
  })

  it('on caller cancel: cancels the turn first, then retires', async () => {
    const controller = new AbortController()
    hoisted.cancel.mockImplementation(async () => {
      hoisted.order.push('cancel')
      return { status: 'accepted' }
    })
    hoisted.createTaskSession.mockResolvedValue({
      sessionId: 'sess-c',
      async *[Symbol.asyncIterator]() {
        yield stepCompleted(1, 1)
        controller.abort()
        await new Promise(() => {})
      },
    })
    await expect(runUtilityTask({ kind: 'generate_title', workspaceId: 'ws', userId: 'u', message: 'm', signal: controller.signal }))
      .rejects.toThrow('cancelled')
    expect(hoisted.order).toEqual(['cancel', 'retire'])
    expect(hoisted.retireTaskSession.mock.calls[0][1]).toBe('sess-c')
  })

  it('on timeout: cancels, then retires', async () => {
    hoisted.cancel.mockImplementation(async () => {
      hoisted.order.push('cancel')
      return { status: 'accepted' }
    })
    hoisted.createTaskSession.mockResolvedValue(logged([stepCompleted(1, 1)], 'sess-t'))
    await expect(runUtilityTask({ kind: 'generate_title', workspaceId: 'ws', userId: 'u', message: 'm', timeoutMs: 20 }))
      .rejects.toThrow('timed out after 20ms')
    expect(hoisted.order).toEqual(['yield:step.completed', 'cancel', 'retire'])
  })

  it('a create that never named a session retires nothing', async () => {
    hoisted.createTaskSession.mockRejectedValue(new Error('eve task-session create failed (503)'))
    await expect(runUtilityTask({ kind: 'generate_title', workspaceId: 'ws', userId: 'u', message: 'm' })).rejects.toThrow('503')
    expect(hoisted.retireTaskSession).not.toHaveBeenCalled()
  })

  it.each([
    ['throws', () => Promise.reject(new Error('reset 500'))],
    ['reports false', () => Promise.resolve(false)],
  ])('a retire that %s logs one line and never changes the result', async (_label, impl) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoisted.retireTaskSession.mockImplementation(impl as never)
    respond({ message: 'kept' })
    const out = await runUtilityTask({ kind: 'generate_title', workspaceId: 'ws', userId: 'u', message: 'm' })
    expect(out.text).toBe('kept')
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1))
    expect(String(warn.mock.calls[0][0])).toMatch(/generate_title retiring session sess-1 failed/)
    warn.mockRestore()
  })

  it('the result never waits on the retire: a retire that never settles does not delay it', async () => {
    let started = false
    hoisted.retireTaskSession.mockImplementation(() => {
      started = true
      return new Promise<boolean>(() => {})
    })
    respond({ message: 'kept' })
    // No timers advanced: a result held for the retire (or its 1.5 s bound) would hang here.
    await expect(runUtilityTask({ kind: 'browser_field_text', workspaceId: 'ws', userId: 'u', message: 'm' }))
      .resolves.toMatchObject({ text: 'kept' })
    expect(started).toBe(true)
  })

  it('inside a request scope the retire is handed to after(), which holds it until it settles', async () => {
    const handed: Promise<unknown>[] = []
    hoisted.after.mockImplementation((work: unknown) => { handed.push(work as Promise<unknown>) })
    let finish!: (v: boolean) => void
    hoisted.retireTaskSession.mockImplementation(() => new Promise<boolean>((r) => (finish = r)))
    respond({ message: 'kept' })
    const out = await runUtilityTask({ kind: 'generate_title', workspaceId: 'ws', userId: 'u', message: 'm' })
    expect(out.text).toBe('kept')
    expect(hoisted.after).toHaveBeenCalledTimes(1)
    let settled = false
    void handed[0].then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    finish(true)
    await handed[0]
    expect(settled).toBe(true)
  })

  it('outside a request scope (after() throws) the retire still runs, floating, and nothing throws', async () => {
    respond({ message: 'kept' })
    const out = await runUtilityTask({ kind: 'generate_title', workspaceId: 'ws', userId: 'u', message: 'm' })
    expect(out.text).toBe('kept')
    expect(hoisted.after).toHaveBeenCalledTimes(1)
    expect(hoisted.retireTaskSession).toHaveBeenCalledTimes(1)
  })

  it('a retire that hangs is abandoned at 1.5 s, logging once', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const handed: Promise<unknown>[] = []
    hoisted.after.mockImplementation((work: unknown) => { handed.push(work as Promise<unknown>) })
    hoisted.retireTaskSession.mockImplementation(() => new Promise(() => {}))
    respond({ message: 'kept' })
    await expect(runUtilityTask({ kind: 'generate_title', workspaceId: 'ws', userId: 'u', message: 'm' }))
      .resolves.toMatchObject({ text: 'kept' })
    expect(warn).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1_500)
    await handed[0]
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    vi.useRealTimers()
  })
})
