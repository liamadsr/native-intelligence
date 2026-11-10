/**
 * /api/device/ask's eve dispatch (src/lib/chat/device-ask-eve.ts).
 *
 * eve/client + the task-session helper + the service client are mocked (the
 * run-utility / run-skill-eve pattern). Pinned:
 *   - the session is a TASK session on the chat-agent mount, the question as its
 *     message;
 *   - auth is the CALLER'S OWN credential relayed (device token / JWT as bearer,
 *     or the cookie) — never a server secret — plus a chat-run token with the
 *     device surface, the route's tenancy and the ownership row's id;
 *   - ownership: a chat_conversations row is created for (user, workspace), the
 *     eve session id is registered on it BEFORE the stream is read, and the row
 *     is deleted when the ask ends (every outcome) — after any cancel;
 *   - the 12-step cap: the 13th step.started ends the read, cancels the session
 *     and answers with the 12th step's text;
 *   - usage: tokens (+ cache) SUMMED over every step, eve's cost per the rule
 *     (partial / 0 / Exa → null), steps + tool calls, the web-search spend;
 *   - every failure after dispatch cancels the session and carries the partial
 *     usage; the token outlives the budget only by the cancel + a grace.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { MessageStreamEvent } from 'eve/client'

const SECRET = 'test-chat-internal-secret-abcdefghij'

const h = vi.hoisted(() => {
  const order: string[] = []
  const cancelMock = vi.fn(async (..._a: unknown[]) => {
    order.push('cancel')
    return { status: 'accepted' }
  })
  const resetMock = vi.fn(async (..._a: unknown[]) => {
    order.push('reset')
    return { status: 'reset' }
  })
  const attachMock = vi.fn((..._a: unknown[]) => ({ cancel: cancelMock, reset: resetMock }))
  const clients: Array<Record<string, unknown>> = []
  const db = {
    insertResult: { data: { id: 'conv-dev-1' } as { id: string } | null, error: null as { message: string } | null },
    updateResult: { error: null as { message: string } | null, count: 1 as number | null },
    inserts: [] as unknown[],
    updates: [] as Array<{ values: unknown; eqs: Array<[string, unknown]> }>,
    deletes: [] as Array<Array<[string, unknown]>>,
    memberResult: { data: { workspace_id: 'ws-1' } as { workspace_id: string } | null, error: null as { message: string } | null },
    memberProbes: [] as Array<Array<[string, unknown]>>,
  }
  return { order, cancelMock, resetMock, attachMock, clients, db, createTaskSessionMock: vi.fn() }
})

vi.mock('eve/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('eve/client')>()),
  Client: class {
    sessions = { attach: h.attachMock }
    constructor(opts: Record<string, unknown>) {
      h.clients.push(opts)
    }
  },
}))
// The REAL cancelTaskSession (it drives the mocked Client's sessions.attach),
// only the create is stubbed.
vi.mock('@/lib/eve/task-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/eve/task-session')>()),
  createTaskSession: h.createTaskSessionMock,
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'member') {
        const eqs: Array<[string, unknown]> = []
        h.db.memberProbes.push(eqs)
        h.order.push('member')
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: (col: string, v: unknown) => {
            eqs.push([col, v])
            return chain
          },
          maybeSingle: async () => h.db.memberResult,
        }
        return chain
      }
      if (table !== 'chat_conversations') throw new Error(`unexpected table ${table}`)
      return {
        insert: (values: unknown) => {
          h.db.inserts.push(values)
          h.order.push('insert')
          return { select: () => ({ single: async () => h.db.insertResult }) }
        },
        update: (values: unknown) => {
          const eqs: Array<[string, unknown]> = []
          h.db.updates.push({ values, eqs })
          h.order.push('register')
          const chain = {
            eq: (col: string, v: unknown) => {
              eqs.push([col, v])
              return chain
            },
            then: (resolve: (v: unknown) => void) => resolve(h.db.updateResult),
          }
          return chain
        },
        delete: () => {
          const eqs: Array<[string, unknown]> = []
          h.db.deletes.push(eqs)
          h.order.push('delete')
          const chain = {
            eq: (col: string, v: unknown) => {
              eqs.push([col, v])
              return chain
            },
            then: (resolve: (v: unknown) => void) => resolve({ error: null }),
          }
          return chain
        },
      }
    },
  }),
}))

import {
  runDeviceAskViaEve,
  DeviceAskNotMemberError,
  DeviceAskMembershipLookupError,
  deviceAskBilledModel,
  deviceAskAppBaseUrl,
  deviceAskCredential,
  DeviceAskEveError,
  deviceAskEveBudgetMs,
  RETIRE_TIMEOUT_MS,
  deviceAskTokenTtlMs,
  summarizeDeviceAskUsage,
  CANCEL_TIMEOUT_MS,
  DEVICE_ASK_LOG_MARGIN_MS,
  DEVICE_ASK_MIN_EVE_BUDGET_MS,
  DEVICE_ASK_TOKEN_GRACE_MS,
  DEVICE_ASK_MAX_STEPS,
  DEVICE_ASK_CONVERSATION_TITLE,
} from '../device-ask-eve'
import { verifyChatRunToken } from '../chat-run-token'
import { openRunCredential } from '../chat-run-credential'

// ── event builders ───────────────────────────────────────────────────────────
const ev = (e: unknown) => e as MessageStreamEvent
const stepStarted = (i: number, modelId = 'm') => ev({ type: 'step.started', data: { modelId, sequence: i, stepIndex: i, turnId: 't' } })
const stepCompleted = (input: number, output: number, costUsd?: number) =>
  ev({
    type: 'step.completed',
    data: {
      finishReason: 'stop',
      sequence: 0,
      stepIndex: 0,
      turnId: 't',
      usage: { inputTokens: input, outputTokens: output, ...(costUsd != null ? { costUsd } : {}) },
    },
  })
const toolCalls = (n: number) =>
  ev({ type: 'actions.requested', data: { actions: Array.from({ length: n }, () => ({ toolName: 'list_actions' })) } })
const messageCompleted = (message: string, finishReason = 'stop') =>
  ev({ type: 'message.completed', data: { finishReason, message, sequence: 0, stepIndex: 0, turnId: 't' } })
const toolResult = (toolName: string, output: unknown) =>
  ev({ type: 'action.result', data: { result: { kind: 'tool-result', callId: 'c', toolName, output } } })
const boundary = (type: 'session.completed' | 'session.failed' | 'session.waiting') => ev({ type, data: {} })

/** A MessageResponse stand-in: iterable over `events`, then (optionally) hanging or throwing. */
function fakeResponse(events: MessageStreamEvent[], opts: { throwAfter?: Error; hang?: boolean } = {}) {
  return {
    sessionId: 'sess-1',
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: async () => {
          if (i < events.length) {
            h.order.push(`read:${events[i].type}`)
            return { done: false, value: events[i++] }
          }
          if (opts.throwAfter) throw opts.throwAfter
          if (opts.hang) return new Promise<IteratorResult<MessageStreamEvent>>(() => {})
          return { done: true, value: undefined }
        },
        return: async () => ({ done: true, value: undefined }),
      }
    },
  }
}

function mockSession(events: MessageStreamEvent[], opts: { throwAfter?: Error; hang?: boolean } = {}) {
  h.createTaskSessionMock.mockImplementation(async () => {
    h.order.push('create')
    return fakeResponse(events, opts)
  })
}

const ARGS = {
  userId: 'user-1',
  workspaceId: 'ws-1',
  question: 'what is on my plate today?',
  model: 'deepseek-v4-flash',
  timeoutMs: 55_000,
  credential: { bearer: 'nid_device_token' } as const,
  appBaseUrl: 'https://app.test',
}

type ClientOpts = { host: string; auth?: { bearer: string }; headers: Record<string, string>; redirect: string }
const clientOpts = () => h.clients[0] as unknown as ClientOpts

beforeEach(() => {
  vi.clearAllMocks()
  h.order.length = 0
  h.clients.length = 0
  h.db.inserts.length = 0
  h.db.updates.length = 0
  h.db.deletes.length = 0
  h.db.insertResult = { data: { id: 'conv-dev-1' }, error: null }
  h.db.updateResult = { error: null, count: 1 }
  h.db.memberResult = { data: { workspace_id: 'ws-1' }, error: null }
  h.db.memberProbes.length = 0
  process.env.CHAT_INTERNAL_SECRET = SECRET
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('runDeviceAskViaEve — dispatch', () => {
  it('runs a TASK session on the chat-agent mount with the question as the message', async () => {
    mockSession([messageCompleted('Three actions due today.'), boundary('session.completed')])
    const out = await runDeviceAskViaEve(ARGS)
    expect(clientOpts().host).toBe('https://app.test/eve/chat-agent')
    expect(clientOpts().redirect).toBe('error')
    const [, opts] = h.createTaskSessionMock.mock.calls[0] as [
      unknown,
      { message: string; signal: AbortSignal; createSignal: AbortSignal },
    ]
    expect(opts.message).toBe('what is on my plate today?')
    expect(opts.signal).toBeInstanceOf(AbortSignal)
    // The create POST has its OWN signal, so the wall does not abort it (a late
    // create's id is still learned and cancelled).
    expect(opts.createSignal).toBeInstanceOf(AbortSignal)
    expect(opts.createSignal).not.toBe(opts.signal)
    expect(out).toMatchObject({ text: 'Three actions due today.', outcome: 'completed' })
  })

  it('relays the CALLER’S credential (never a server secret) + a device-surface token for the owned row', async () => {
    mockSession([messageCompleted('ok'), boundary('session.completed')])
    await runDeviceAskViaEve(ARGS)
    const { auth, headers } = clientOpts()
    expect(auth).toEqual({ bearer: 'nid_device_token' })
    expect(JSON.stringify(clientOpts())).not.toContain(SECRET)
    expect(headers['x-workspace-id']).toBe('ws-1')
    const claims = verifyChatRunToken(headers['x-chat-run-token'])
    expect(claims).toMatchObject({
      conversationId: 'conv-dev-1',
      userId: 'user-1',
      workspaceId: 'ws-1',
      surface: 'device_ask',
    })
    expect(claims!.agentId).toBeUndefined()
    // A nid_ device token is never sealed into the run token: the endpoints the
    // email-draft tools call never accepted it (the old route gained nothing).
    expect(claims!.cred).toBeUndefined()
  })

  it('relays a cookie credential as the Cookie header (no bearer), and seals nothing', async () => {
    mockSession([messageCompleted('ok'), boundary('session.completed')])
    await runDeviceAskViaEve({ ...ARGS, credential: { cookie: 'sb-access=abc' } })
    expect(clientOpts().auth).toBeUndefined()
    expect(clientOpts().headers.cookie).toBe('sb-access=abc')
    expect(verifyChatRunToken(clientOpts().headers['x-chat-run-token'])!.cred).toBeUndefined()
  })

  it('a Supabase JWT caller: the JWT is SEALED into the run token for the email-draft tools (never in the clear), bound to this ask', async () => {
    const jwt = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ sub: 'user-1' })).toString('base64url')}.c2ln`
    mockSession([messageCompleted('ok'), boundary('session.completed')])
    await runDeviceAskViaEve({ ...ARGS, credential: { bearer: jwt } })
    const token = clientOpts().headers['x-chat-run-token']
    const claims = verifyChatRunToken(token)!
    expect(typeof claims.cred).toBe('string')
    expect(token).not.toContain(jwt.split('.')[1])
    expect(openRunCredential(claims.cred!, claims)).toBe(jwt)
    expect(openRunCredential(claims.cred!, { ...claims, conversationId: 'another-ask' })).toBeNull()
  })

  it('sends an empty per-turn ctx: the device\'s model is fixed (routeChatTurn\'s device kind), never picked', async () => {
    mockSession([messageCompleted('ok'), boundary('session.completed')])
    await runDeviceAskViaEve(ARGS)
    const ctx = JSON.parse(Buffer.from(clientOpts().headers['x-chat-run-ctx'], 'base64url').toString('utf8'))
    expect(ctx).toEqual({})
  })

  it('mints the token with a SHORT lifetime — the ask’s budget + cancel + grace, not the chat’s 60 min', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    mockSession([messageCompleted('ok'), boundary('session.completed')])
    await runDeviceAskViaEve({ ...ARGS, timeoutMs: 40_000 })
    const token = clientOpts().headers['x-chat-run-token']
    expect(verifyChatRunToken(token)!.exp - Date.now()).toBe(40_000 + CANCEL_TIMEOUT_MS + DEVICE_ASK_TOKEN_GRACE_MS)
    expect(deviceAskTokenTtlMs(40_000)).toBe(40_000 + CANCEL_TIMEOUT_MS + DEVICE_ASK_TOKEN_GRACE_MS)
    vi.setSystemTime(Date.now() + deviceAskTokenTtlMs(40_000) + 1)
    expect(verifyChatRunToken(token)).toBeNull()
  })

  it('forwards the Vercel protection bypass when configured', async () => {
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'bypass-1')
    mockSession([messageCompleted('ok'), boundary('session.completed')])
    await runDeviceAskViaEve(ARGS)
    expect(clientOpts().headers['x-vercel-protection-bypass']).toBe('bypass-1')
  })

  it('throws before anything is written or dispatched when the internal secret is unset', async () => {
    delete process.env.CHAT_INTERNAL_SECRET
    await expect(runDeviceAskViaEve(ARGS)).rejects.toThrow(/CHAT_INTERNAL_SECRET/)
    expect(h.db.inserts).toHaveLength(0)
    expect(h.createTaskSessionMock).not.toHaveBeenCalled()
  })
})

describe('runDeviceAskViaEve — the parked session is retired (eve 0.67+ has no task mode)', () => {
  it('a completed turn parks its session: it is reset after the read, while the registration still stands', async () => {
    mockSession([messageCompleted('ok'), ev({ type: 'turn.completed', data: { turnId: 't', sequence: 1 } }), boundary('session.waiting')])
    await expect(runDeviceAskViaEve(ARGS)).resolves.toMatchObject({ outcome: 'completed', text: 'ok' })
    expect(h.resetMock).toHaveBeenCalledTimes(1)
    expect(h.order.indexOf('reset')).toBeLessThan(h.order.indexOf('delete'))
  })

  it('a failed ask is cancelled, then reset too', async () => {
    mockSession([boundary('session.failed')])
    await runDeviceAskViaEve(ARGS).catch(() => {})
    expect(h.order.indexOf('cancel')).toBeLessThan(h.order.indexOf('reset'))
    expect(h.order.indexOf('reset')).toBeLessThan(h.order.indexOf('delete'))
  })
})

describe('runDeviceAskViaEve — session ownership (the chat-agent ACL’s record)', () => {
  it('owner row for (user, workspace) → create → register the session id → read → delete the row', async () => {
    mockSession([messageCompleted('ok'), boundary('session.completed')])
    await runDeviceAskViaEve(ARGS)
    expect(h.db.inserts).toEqual([{ user_id: 'user-1', workspace_id: 'ws-1', title: DEVICE_ASK_CONVERSATION_TITLE }])
    expect(h.db.updates).toEqual([
      {
        values: { eve_session_id: 'sess-1' },
        eqs: [
          ['id', 'conv-dev-1'],
          ['user_id', 'user-1'],
          ['workspace_id', 'ws-1'],
        ],
      },
    ])
    // Registered BEFORE the first stream read (the stream is ACL'd on it), and
    // the row is released only at the end.
    // The membership check runs FIRST — owner derivation before any service-role write.
    expect(h.order.slice(0, 2)).toEqual(['member', 'insert'])
    expect(h.db.memberProbes).toEqual([
      [
        ['user_id', 'user-1'],
        ['workspace_id', 'ws-1'],
      ],
    ])
    expect(h.order.indexOf('create')).toBeLessThan(h.order.indexOf('register'))
    expect(h.order.indexOf('register')).toBeLessThan(h.order.findIndex((o) => o.startsWith('read:')))
    expect(h.order.at(-1)).toBe('delete')
    expect(h.db.deletes).toEqual([
      [
        ['id', 'conv-dev-1'],
        ['user_id', 'user-1'],
      ],
    ])
  })

  it.each([
    ['not a member → DeviceAskNotMemberError (the route’s 403)', { data: null, error: null }, DeviceAskNotMemberError],
    [
      'a membership lookup ERROR → DeviceAskMembershipLookupError (the route’s 500), never "not a member"',
      { data: null, error: { message: 'db down' } },
      DeviceAskMembershipLookupError,
    ],
  ] as const)('%s: refused BEFORE anything is written, minted or run', async (_label, result, errorClass) => {
    h.db.memberResult = result as typeof h.db.memberResult
    const err = await runDeviceAskViaEve(ARGS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(errorClass)
    if (errorClass === DeviceAskMembershipLookupError) expect(err).not.toBeInstanceOf(DeviceAskNotMemberError)
    expect(h.db.inserts).toHaveLength(0)
    expect(h.clients).toHaveLength(0)
    expect(h.createTaskSessionMock).not.toHaveBeenCalled()
    expect(h.db.deletes).toHaveLength(0)
  })

  it('a registration that does not land fails the ask (never streams an unowned session), cancels, releases', async () => {
    h.db.updateResult = { error: null, count: 0 }
    mockSession([messageCompleted('ok'), boundary('session.completed')])
    const err = await runDeviceAskViaEve(ARGS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeviceAskEveError)
    expect(h.order.some((o) => o.startsWith('read:'))).toBe(false)
    expect(h.cancelMock).toHaveBeenCalledTimes(1)
    expect(h.order.at(-1)).toBe('delete')
  })

  it('an owner row that cannot be created throws before any dispatch', async () => {
    h.db.insertResult = { data: null, error: { message: 'insert failed' } }
    await expect(runDeviceAskViaEve(ARGS)).rejects.toThrow(/owner row/)
    expect(h.createTaskSessionMock).not.toHaveBeenCalled()
  })

  it('on failure the cancel runs while the session is still registered — the row goes after it', async () => {
    mockSession([boundary('session.failed')])
    await runDeviceAskViaEve(ARGS).catch(() => {})
    expect(h.order.indexOf('cancel')).toBeGreaterThan(-1)
    expect(h.order.indexOf('cancel')).toBeLessThan(h.order.indexOf('delete'))
  })
})

/** n full tool-calling steps (step.started → tool call → message → step.completed). */
function steps(n: number, finalMessage?: string) {
  const out: MessageStreamEvent[] = []
  for (let i = 0; i < n; i++) {
    out.push(stepStarted(i), toolCalls(1), messageCompleted(i === n - 1 && finalMessage ? finalMessage : `step ${i}`, 'tool-calls'), stepCompleted(100 + i, 10))
  }
  return out
}

describe('runDeviceAskViaEve — the 12-step cap', () => {

  it('is 12', () => {
    expect(DEVICE_ASK_MAX_STEPS).toBe(12)
  })

  it('the 13th step.started ends the ask: session cancelled, answer = the 12th step’s text, billed as a success', async () => {
    // 12 full steps, then a 13th model call starts (and would go on forever).
    mockSession([...steps(12, 'twelfth'), stepStarted(12), messageCompleted('never read')], { hang: true })
    const out = await runDeviceAskViaEve(ARGS)
    expect(out.outcome).toBe('step-cap')
    expect(out.text).toBe('twelfth')
    expect(h.attachMock).toHaveBeenCalledWith('sess-1')
    expect(h.cancelMock).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    // Every completed step is billed: Σ(100..111) input, 12 × 10 output.
    expect(out.usage).toMatchObject({ steps: 12, toolCalls: 12, inputTokens: 1266, outputTokens: 120 })
    expect(h.order).not.toContain('read:never read')
    expect(h.order.at(-1)).toBe('delete')
  })

  it('eve’s real shape — a 12th step that ONLY calls tools emits no message.completed: the answer is "", never an earlier step’s narration', async () => {
    // eve 0.66.3 (harness/emission.js) emits message.completed only for a step
    // with non-empty text. Step 3 narrates; every other step (incl. the 12th)
    // just calls tools. generateText's final-step `result.text` here is ''.
    const out: MessageStreamEvent[] = []
    for (let i = 0; i < 12; i++) {
      out.push(stepStarted(i), toolCalls(1))
      if (i === 3) out.push(messageCompleted('Let me check your calendar…', 'tool-calls'))
      out.push(stepCompleted(100 + i, 10))
    }
    mockSession([...out, stepStarted(12)], { hang: true })
    const res = await runDeviceAskViaEve(ARGS)
    expect(res.outcome).toBe('step-cap')
    expect(res.text).toBe('')
    expect(h.cancelMock).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('a 12th step with text answers with THAT text, not an earlier one', async () => {
    const out: MessageStreamEvent[] = []
    for (let i = 0; i < 12; i++) {
      out.push(stepStarted(i), toolCalls(1))
      if (i === 3) out.push(messageCompleted('early narration', 'tool-calls'))
      if (i === 11) out.push(messageCompleted('the twelfth step', 'tool-calls'))
      out.push(stepCompleted(1, 1))
    }
    mockSession([...out, stepStarted(12)], { hang: true })
    expect((await runDeviceAskViaEve(ARGS)).text).toBe('the twelfth step')
  })

  it('a run that finishes ON its 12th step is a normal completion (no cancel)', async () => {
    mockSession([...steps(11), stepStarted(11), messageCompleted('done'), stepCompleted(50, 5), boundary('session.completed')])
    const out = await runDeviceAskViaEve(ARGS)
    expect(out).toMatchObject({ outcome: 'completed', text: 'done' })
    expect(out.usage.steps).toBe(12)
    expect(h.cancelMock).not.toHaveBeenCalled()
  })
})

describe('runDeviceAskViaEve — answers, failures, timeout', () => {
  it('the answer is the last message that is not a tool-call hand-off; none → ""', async () => {
    mockSession([messageCompleted('let me check', 'tool-calls'), messageCompleted('final'), boundary('session.completed')])
    expect((await runDeviceAskViaEve(ARGS)).text).toBe('final')
    mockSession([boundary('session.completed')])
    expect((await runDeviceAskViaEve(ARGS)).text).toBe('')
  })

  it('stops reading at session.completed (the live stream stays open after it)', async () => {
    mockSession([messageCompleted('ok'), boundary('session.completed')], { hang: true })
    await expect(runDeviceAskViaEve(ARGS)).resolves.toMatchObject({ text: 'ok' })
    expect(h.cancelMock).not.toHaveBeenCalled()
  })

  it.each(['failed', 'waiting'] as const)('throws on a %s session, and cancels it', async (status) => {
    mockSession([boundary(`session.${status}`)])
    const err = await runDeviceAskViaEve(ARGS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeviceAskEveError)
    expect((err as Error).message).toContain(status)
    expect(h.cancelMock).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('a stream that ends with NO boundary is a failure, never a completed answer', async () => {
    mockSession([messageCompleted('half an answer')])
    await expect(runDeviceAskViaEve(ARGS)).rejects.toThrow(/incomplete/)
    expect(h.cancelMock).toHaveBeenCalledTimes(1)
  })

  it('at the timeout: stops reading (even a stream that ignores the signal), cancels, carries the partial usage', async () => {
    vi.useFakeTimers()
    mockSession([stepStarted(0), toolCalls(1), stepCompleted(400, 30, 0)], { hang: true })
    const pending = runDeviceAskViaEve({ ...ARGS, timeoutMs: 1_000 }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_000)
    const err = await pending
    expect(err).toBeInstanceOf(DeviceAskEveError)
    expect((err as Error).message).toMatch(/timed out/)
    expect(h.cancelMock).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect((err as DeviceAskEveError).usage).toMatchObject({ inputTokens: 400, outputTokens: 30, toolCalls: 1, steps: 1, costUsd: null })
    expect(h.order.at(-1)).toBe('delete')
  })

  it('every cancel is bounded by the route’s CANCEL_TIMEOUT_MS slice (not the helper’s 5s default)', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    try {
      // A failed session → cancel.
      mockSession([boundary('session.failed')])
      await runDeviceAskViaEve(ARGS).catch(() => {})
      expect(timeoutSpy).toHaveBeenCalledWith(CANCEL_TIMEOUT_MS)

      // The step cap → cancel.
      timeoutSpy.mockClear()
      mockSession([...steps(12), stepStarted(12)], { hang: true })
      await expect(runDeviceAskViaEve(ARGS)).resolves.toMatchObject({ outcome: 'step-cap' })
      expect(timeoutSpy).toHaveBeenCalledWith(CANCEL_TIMEOUT_MS)
      // …and the only other bound is the session retire's own short slice.
      expect(timeoutSpy.mock.calls.every(([ms]) => ms === CANCEL_TIMEOUT_MS || ms === RETIRE_TIMEOUT_MS)).toBe(true)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it('a stream error mid-run cancels the session and still reports the usage so far', async () => {
    mockSession([stepCompleted(90, 5, 0)], { throwAfter: new Error('stream reset') })
    const err = await runDeviceAskViaEve(ARGS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeviceAskEveError)
    expect(h.cancelMock).toHaveBeenCalledTimes(1)
    expect((err as DeviceAskEveError).usage).toMatchObject({ inputTokens: 90, outputTokens: 5 })
  })

  it('a cancel that itself fails never masks the original error', async () => {
    h.cancelMock.mockRejectedValueOnce(new Error('cancel 503'))
    mockSession([boundary('session.failed')])
    await expect(runDeviceAskViaEve(ARGS)).rejects.toThrow(/eve session failed/)
  })

  it('a create that answers AFTER the wall is registered on the still-live row, cancelled, then the row goes', async () => {
    vi.useFakeTimers()
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    h.createTaskSessionMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          h.order.push('create')
          setTimeout(() => resolve(fakeResponse([], { hang: true })), 1_500)
        }),
    )
    const pending = runDeviceAskViaEve({ ...ARGS, timeoutMs: 1_000 }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_500)
    const err = await pending
    expect(err).toBeInstanceOf(DeviceAskEveError)
    expect((err as Error).message).toMatch(/timed out/)
    expect((err as DeviceAskEveError).usage).toBeNull()
    expect(h.db.updates).toEqual([
      {
        values: { eve_session_id: 'sess-1' },
        eqs: [
          ['id', 'conv-dev-1'],
          ['user_id', 'user-1'],
          ['workspace_id', 'ws-1'],
        ],
      },
    ])
    expect(h.attachMock).toHaveBeenCalledWith('sess-1')
    expect(h.cancelMock).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    // The late cancel gets only what is LEFT of the cancel slice (the create
    // already ate 500ms of it): ≤ CANCEL_TIMEOUT_MS, never the 5s default.
    const lateMs = timeoutSpy.mock.calls.map(([ms]) => ms)
    expect(lateMs).toHaveLength(1)
    expect(lateMs[0]).toBeLessThanOrEqual(CANCEL_TIMEOUT_MS - 500)
    expect(lateMs[0]).toBeGreaterThanOrEqual(250)
    timeoutSpy.mockRestore()
    // register → cancel → delete: the cancel is ACL'd on the registration.
    expect(h.order.indexOf('register')).toBeLessThan(h.order.indexOf('cancel'))
    expect(h.order.indexOf('cancel')).toBeLessThan(h.order.indexOf('delete'))
    expect(h.order.some((o) => o.startsWith('read:'))).toBe(false)
  })

  it('a create that never answers within the cancel slice is aborted (the row delete revokes its token)', async () => {
    vi.useFakeTimers()
    let createSignal: AbortSignal | undefined
    h.createTaskSessionMock.mockImplementation((_c: unknown, opts: { createSignal: AbortSignal }) => {
      createSignal = opts.createSignal
      return new Promise(() => {})
    })
    const pending = runDeviceAskViaEve({ ...ARGS, timeoutMs: 1_000 }).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(1_000 + CANCEL_TIMEOUT_MS)
    const err = await pending
    expect(err).toBeInstanceOf(DeviceAskEveError)
    expect(createSignal!.aborted).toBe(true)
    expect(h.cancelMock).not.toHaveBeenCalled()
    expect(h.db.updates).toHaveLength(0)
    expect(h.order.at(-1)).toBe('delete')
  })

  it('a create failure (no session) throws with null usage, nothing to cancel, and releases the row', async () => {
    h.createTaskSessionMock.mockRejectedValue(new Error('eve task-session create failed (502)'))
    const err = await runDeviceAskViaEve(ARGS).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DeviceAskEveError)
    expect((err as DeviceAskEveError).usage).toBeNull()
    expect(h.attachMock).not.toHaveBeenCalled()
    expect(h.db.deletes).toHaveLength(1)
  })
})

describe('summarizeDeviceAskUsage — the eve billing basis (mapEveTurnUsage), from eve events', () => {
  it('bills tokens SUMMED over every step (a multi-step ask is not under-billed); counts every step and tool call', () => {
    const u = summarizeDeviceAskUsage([toolCalls(2), stepCompleted(100, 20), toolCalls(1), stepCompleted(300, 40)])
    expect(u).toEqual({
      inputTokens: 400,
      outputTokens: 60,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: null,
      modelId: null,
      steps: 2,
      toolCalls: 3,
      webSearchCostUsd: null,
      generationIds: [],
    })
  })

  it('carries every step’s Gateway generation id (reconciliation)', () => {
    const gidStep = (input: number, output: number, generationId: string) =>
      ev({
        type: 'step.completed',
        data: {
          finishReason: 'stop',
          sequence: 0,
          stepIndex: 0,
          turnId: 't',
          usage: { inputTokens: input, outputTokens: output },
          providerMetadata: { gateway: { generationId } },
        },
      })
    const u = summarizeDeviceAskUsage([gidStep(100, 20, 'gen_1'), gidStep(300, 40, 'gen_2')])
    expect(u.generationIds).toEqual(['gen_1', 'gen_2'])
    expect(u).toMatchObject({ inputTokens: 400, outputTokens: 60 })
  })

  it('sums the cached share of input (reads / writes) for log_ai_usage’s cache keys', () => {
    const cached = (input: number, cacheReadTokens: number, cacheWriteTokens: number) =>
      ev({
        type: 'step.completed',
        data: {
          finishReason: 'stop',
          sequence: 0,
          stepIndex: 0,
          turnId: 't',
          usage: { inputTokens: input, outputTokens: 5, cacheReadTokens, cacheWriteTokens },
        },
      })
    const u = summarizeDeviceAskUsage([cached(5000, 0, 4000), cached(6000, 4000, 0)])
    expect(u).toMatchObject({ inputTokens: 11000, cacheReadTokens: 4000, cacheWriteTokens: 4000 })
  })

  it('eve cost rule over the WHOLE run: any uncosted token step or a 0 total → null; all costed → the sum', () => {
    expect(summarizeDeviceAskUsage([stepCompleted(1, 1, 0)]).costUsd).toBeNull()
    expect(summarizeDeviceAskUsage([stepCompleted(1, 1)]).costUsd).toBeNull()
    // BYOK / partial: one token step carried no cost → the sum would under-state it → null.
    expect(summarizeDeviceAskUsage([stepCompleted(1, 1, 5), stepCompleted(1, 1, 0)]).costUsd).toBeNull()
    expect(summarizeDeviceAskUsage([stepCompleted(1, 1, 5), stepCompleted(1, 1, 0.02)]).costUsd).toBeCloseTo(5.02)
  })

  it('harvests the Exa spend from web-search tool results (output.costDollars.total)', () => {
    const u = summarizeDeviceAskUsage([
      toolResult('web_search', { results: [], costDollars: { total: 0.005 } }),
      toolResult('web_search', { results: [], costDollars: { total: 0.01 } }),
      toolResult('list_actions', { rows: [] }),
      stepCompleted(10, 1),
    ])
    expect(u.webSearchCostUsd).toBeCloseTo(0.015)
  })

  it('an Exa-contaminated ask drops eve’s cost (it includes the search) — tokens list-priced, Exa in webSearchCostUsd', () => {
    // eve 0.66.3 measured: BYOK step cost 0.007 == the search's costDollars 0.007.
    const u = summarizeDeviceAskUsage([
      toolResult('web_search', { results: [], costDollars: { total: 0.007 } }),
      stepCompleted(8100, 200, 0.007),
    ])
    expect(u.costUsd).toBeNull()
    expect(u.webSearchCostUsd).toBeCloseTo(0.007)
    expect(u).toMatchObject({ inputTokens: 8100, outputTokens: 200 })
  })

  it('a web_search ask (step 1 searches, step 2 answers) bills BOTH steps’ tokens at list price, not only the answer’s', () => {
    const u = summarizeDeviceAskUsage([
      toolCalls(1),
      stepCompleted(8100, 40, 0.009),
      toolResult('web_search', { results: [], costDollars: { total: 0.007 } }),
      stepCompleted(9300, 210, 0.004),
    ])
    expect(u).toMatchObject({ inputTokens: 17400, outputTokens: 250, costUsd: null, steps: 2 })
    expect(u.webSearchCostUsd).toBeCloseTo(0.007)
  })

  it('no steps → zero tokens (never undefined)', () => {
    expect(summarizeDeviceAskUsage([])).toMatchObject({ inputTokens: 0, outputTokens: 0, steps: 0, toolCalls: 0, modelId: null })
  })

  it('an Exa-billed run drops eve’s cost (it includes the Exa charge): the RPC list-prices the tokens, Exa stays in webSearchCostUsd', () => {
    const u = summarizeDeviceAskUsage([
      toolResult('web_search', { results: [], costDollars: { total: 0.007 } }),
      stepCompleted(8_000, 50, 0.007),
    ])
    expect(u.costUsd).toBeNull()
    expect(u.webSearchCostUsd).toBeCloseTo(0.007)
    // No Exa result → a real eve cost still passes through.
    expect(summarizeDeviceAskUsage([toolResult('list_actions', { rows: [] }), stepCompleted(10, 1, 0.02)]).costUsd).toBe(0.02)
  })

  it('records the model the FINAL completed step ran on (step.started.data.modelId), not an earlier or an uncompleted one', () => {
    expect(
      summarizeDeviceAskUsage([
        stepStarted(0, 'anthropic/claude-haiku-4.5'),
        stepCompleted(10, 1),
        stepStarted(1, 'deepseek/deepseek-v4-flash'),
        stepCompleted(20, 2),
      ]).modelId,
    ).toBe('deepseek/deepseek-v4-flash')
    // A step that started but never completed is not what the billed tokens ran on.
    expect(
      summarizeDeviceAskUsage([stepStarted(0, 'anthropic/claude-haiku-4.5'), stepCompleted(10, 1), stepStarted(1, 'moonshotai/kimi-k3')])
        .modelId,
    ).toBe('anthropic/claude-haiku-4.5')
  })
})

describe('deviceAskBilledModel — bill the model that ACTUALLY ran', () => {
  const usage = (modelId: string | null) => ({ ...summarizeDeviceAskUsage([]), modelId })

  it('the chat-agent fell back to its FALLBACK_SELECTION (spec unavailable): bill DeepSeek V4 Flash, not the requested Haiku', () => {
    expect(deviceAskBilledModel('claude-haiku-4-5-20251001', usage('deepseek/deepseek-v4-flash'))).toBe('deepseek-v4-flash')
  })

  it('the requested model ran: the same app id', () => {
    expect(deviceAskBilledModel('claude-haiku-4-5-20251001', usage('anthropic/claude-haiku-4.5'))).toBe('claude-haiku-4-5-20251001')
    expect(deviceAskBilledModel('kimi-k3', usage('moonshotai/kimi-k3'))).toBe('kimi-k3')
  })

  it('no completed step, or a slug outside the catalog: the requested model', () => {
    expect(deviceAskBilledModel('kimi-k3', usage(null))).toBe('kimi-k3')
    expect(deviceAskBilledModel('kimi-k3', usage('someprovider/unknown-model'))).toBe('kimi-k3')
  })
})

describe('deviceAskCredential — relays the credential that AUTHENTICATED', () => {
  const r = (headers: Record<string, string>) => new Request('https://x/api/device/ask', { method: 'POST', headers })
  it('device / jwt → the bearer; cookie → the cookie', () => {
    expect(deviceAskCredential(r({ authorization: 'Bearer nid_x', cookie: 'a=b' }), 'device')).toEqual({ bearer: 'nid_x' })
    expect(deviceAskCredential(r({ authorization: 'Bearer eyJ.jwt', cookie: 'a=b' }), 'jwt')).toEqual({ bearer: 'eyJ.jwt' })
    expect(deviceAskCredential(r({ cookie: 'a=b' }), 'cookie')).toEqual({ cookie: 'a=b' })
  })
  it('a stale bearer that fell through to the cookie relays the COOKIE, never the dead bearer', () => {
    expect(deviceAskCredential(r({ authorization: 'Bearer nid_expired', cookie: 'a=b' }), 'cookie')).toEqual({ cookie: 'a=b' })
    expect(deviceAskCredential(r({ authorization: 'Bearer eyJ.stale', cookie: 'a=b' }), 'cookie')).toEqual({ cookie: 'a=b' })
  })
  it('null when the named credential is not on the request', () => {
    expect(deviceAskCredential(r({}), 'cookie')).toBeNull()
    expect(deviceAskCredential(r({ cookie: 'a=b' }), 'jwt')).toBeNull()
  })
})

describe('deviceAskEveBudgetMs — the eve budget is what is LEFT of maxDuration', () => {
  const MAX = 60_000
  it('with an instant prelude: maxDuration minus the cancel and the log margin', () => {
    expect(deviceAskEveBudgetMs({ startTime: 1_000, maxDurationMs: MAX, now: 1_000 })).toBe(
      MAX - CANCEL_TIMEOUT_MS - DEVICE_ASK_LOG_MARGIN_MS,
    )
  })
  it('a slow prelude shrinks the budget one-for-one', () => {
    for (const elapsed of [0, 250, 4_000, 20_000, 50_000]) {
      const budget = deviceAskEveBudgetMs({ startTime: 0, maxDurationMs: MAX, now: elapsed })
      expect(elapsed + budget + CANCEL_TIMEOUT_MS + DEVICE_ASK_LOG_MARGIN_MS).toBe(MAX)
    }
  })
  it('floors at the minimum when the prelude ate (almost) everything', () => {
    expect(deviceAskEveBudgetMs({ startTime: 0, maxDurationMs: MAX, now: 59_000 })).toBe(DEVICE_ASK_MIN_EVE_BUDGET_MS)
  })
})

describe('deviceAskAppBaseUrl — never from the request', () => {
  it('prefers the exact deployment (VERCEL_URL), then NEXT_PUBLIC_APP_URL, then local dev', () => {
    vi.stubEnv('VERCEL_URL', 'dial8-abc.vercel.app')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev')
    expect(deviceAskAppBaseUrl()).toBe('https://dial8-abc.vercel.app')
    vi.stubEnv('VERCEL_URL', '')
    expect(deviceAskAppBaseUrl()).toBe('https://nativeintelligence.dev')
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    expect(deviceAskAppBaseUrl()).toBe('http://localhost:3000')
  })
})
