import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MessageStreamEvent } from 'eve/client'

/**
 * POST /api/device/ask — the ESP32 one-shot, on the eve chat-agent as a TASK
 * session. The eve client + task-session helper + service client are mocked
 * (the run-utility / eve chat test pattern); the route and its dispatcher
 * (src/lib/chat/device-ask-eve.ts) run for real.
 *
 * Pins:
 *   - the HTTP contract is unchanged: { ok, text, tool_calls, duration_ms }; 400
 *     { error: 'question is required' } / { error: 'No workspace found' }; auth
 *     and usage-gate Responses pass through; any agent failure is 500
 *     { error: 'Agent request failed' };
 *   - the session runs as the caller: the device token is relayed, the run
 *     token carries the device's workspace + the device_ask surface;
 *   - the usage row: feature 'device_ask', every step's tokens summed, costUsd null
 *     (eve rule → RPC list price), metadata { toolCalls, steps } +
 *     webSearchCostUsd when present; a failed ask still meters its partial spend;
 *   - the 12-step cap answers 200 with the 12th step's text and cancels the session;
 *   - the in-process generateText path is gone.
 */

const SECRET = 'test-chat-internal-secret-abcdefghij'

const h = vi.hoisted(() => ({
  logUsage: vi.fn(async (..._a: unknown[]) => undefined),
  resolveDeviceToken: vi.fn(),
  checkUsageLimits: vi.fn(async (..._a: unknown[]): Promise<unknown> => ({ is_paid_plan: true })),
  authenticateUser: vi.fn(),
  createTaskSession: vi.fn(),
  cancel: vi.fn(async (..._a: unknown[]) => ({ status: 'accepted' })),
  clients: [] as Array<Record<string, unknown>>,
  /** The runDeviceAskViaEve membership probe's answer (service role). */
  isMember: true,
  /** When set, the membership probe ERRORS (a DB blip) instead of answering. */
  memberError: null as { message: string } | null,
  memberProbes: [] as Array<Array<[string, unknown]>>,
}))

vi.mock('eve/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('eve/client')>()),
  Client: class {
    sessions = { attach: () => ({ cancel: h.cancel }) }
    constructor(opts: Record<string, unknown>) {
      h.clients.push(opts)
    }
  },
}))
vi.mock('@/lib/eve/task-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/eve/task-session')>()),
  createTaskSession: h.createTaskSession,
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const eqs: Array<[string, unknown]> = []
      if (table === 'member') h.memberProbes.push(eqs)
      const chain: Record<string, unknown> = {
        insert: () => chain,
        select: () => chain,
        single: async () => ({ data: { id: 'conv-dev' }, error: null }),
        maybeSingle: async () =>
          h.memberError ? { data: null, error: h.memberError } : { data: h.isMember ? { workspace_id: 'ws' } : null, error: null },
        update: () => chain,
        delete: () => chain,
        eq: (c: string, v: unknown) => {
          eqs.push([c, v])
          return chain
        },
        then: (resolve: (v: unknown) => void) => resolve({ error: null, count: 1 }),
      }
      return chain
    },
  }),
}))
vi.mock('@/lib/device-tokens', () => ({
  isDeviceToken: (t: string) => t.startsWith('d8d_'),
  resolveDeviceToken: h.resolveDeviceToken,
}))

function memberChain(workspaceId: string | null = 'ws-oldest') {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'order', 'limit']) c[m] = () => c
  c.maybeSingle = async () => ({ data: workspaceId ? { workspace_id: workspaceId } : null, error: null })
  return c
}
const supabase = { from: vi.fn(() => memberChain()) }

vi.mock('@/lib/ai/auth', () => ({
  authenticateUser: h.authenticateUser,
  checkUsageLimits: h.checkUsageLimits,
  logUsage: h.logUsage,
}))

import { POST } from '../route'
import { verifyChatRunToken } from '@/lib/chat/chat-run-token'
import { deviceAskTokenTtlMs, CANCEL_TIMEOUT_MS, DEVICE_ASK_LOG_MARGIN_MS } from '@/lib/chat/device-ask-eve'

function req(body: unknown, headers: Record<string, string> = { authorization: 'Bearer d8d_abc' }) {
  return new Request('https://dial8.ai/api/device/ask', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

const ev = (e: unknown) => e as MessageStreamEvent
const stepStarted = (i: number) => ev({ type: 'step.started', data: { stepIndex: i } })
const stepCompleted = (input: number, output: number, costUsd = 0) =>
  ev({ type: 'step.completed', data: { finishReason: 'stop', usage: { inputTokens: input, outputTokens: output, costUsd } } })
const toolCall = (name: string) => ev({ type: 'actions.requested', data: { actions: [{ toolName: name }] } })
const message = (text: string, finishReason = 'stop') => ev({ type: 'message.completed', data: { finishReason, message: text } })
const webSearchResult = (total: number) =>
  ev({ type: 'action.result', data: { result: { kind: 'tool-result', toolName: 'web_search', output: { results: [], costDollars: { total } } } } })

function session(events: MessageStreamEvent[], opts: { hang?: boolean } = {}) {
  h.createTaskSession.mockResolvedValue({
    sessionId: 'sess-1',
    [Symbol.asyncIterator]() {
      let i = 0
      return {
        next: async () =>
          i < events.length
            ? { done: false, value: events[i++] }
            : opts.hang
              ? new Promise<never>(() => {})
              : { done: true, value: undefined },
        return: async () => ({ done: true, value: undefined }),
      }
    },
  })
}

/** Two steps: a list_actions call, then the answer. */
const ANSWERED = [
  stepStarted(0),
  toolCall('list_actions'),
  message('checking', 'tool-calls'),
  stepCompleted(120, 15),
  stepStarted(1),
  message('You have three actions due today.'),
  stepCompleted(300, 40),
  ev({ type: 'session.completed', data: {} }),
]

beforeEach(() => {
  vi.clearAllMocks()
  h.clients.length = 0
  h.isMember = true
  h.memberError = null
  h.memberProbes.length = 0
  process.env.CHAT_INTERNAL_SECRET = SECRET
  h.authenticateUser.mockResolvedValue({ user: { id: 'user-1' }, supabase, via: 'device' })
  h.checkUsageLimits.mockResolvedValue({ is_paid_plan: true })
  h.resolveDeviceToken.mockResolvedValue({ userId: 'user-1', workspaceId: 'ws-device' })
  session(ANSWERED)
})
afterEach(() => {
  delete process.env.CHAT_INTERNAL_SECRET
  vi.useRealTimers()
})

describe('POST /api/device/ask — HTTP contract', () => {
  it('answers { ok, text, tool_calls, duration_ms } — nothing more', async () => {
    const res = await POST(req({ question: 'what is due?' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['duration_ms', 'ok', 'text', 'tool_calls'])
    expect(body).toMatchObject({ ok: true, text: 'You have three actions due today.', tool_calls: 1 })
    expect(typeof body.duration_ms).toBe('number')
  })

  it('400s an empty question before any eve work', async () => {
    const res = await POST(req({ question: '   ' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'question is required' })
    expect(h.createTaskSession).not.toHaveBeenCalled()
  })

  it('400s when the user has no workspace', async () => {
    h.resolveDeviceToken.mockResolvedValue({ userId: 'user-1', workspaceId: null })
    supabase.from.mockReturnValueOnce(memberChain(null))
    const res = await POST(req({ question: 'q' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'No workspace found' })
  })

  it('passes the auth / usage-gate Responses through verbatim', async () => {
    h.checkUsageLimits.mockRejectedValueOnce(new Response(JSON.stringify({ error: 'Usage limit exceeded' }), { status: 429 }))
    const res = await POST(req({ question: 'q' }))
    expect(res.status).toBe(429)
    expect(h.createTaskSession).not.toHaveBeenCalled()
  })

  it('any agent failure is 500 { error: "Agent request failed" }', async () => {
    session([ev({ type: 'session.failed', data: { code: 'X' } })])
    const res = await POST(req({ question: 'q' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Agent request failed' })
  })
})

describe('POST /api/device/ask — the eve session runs as the device', () => {
  it('relays the device token and scopes the run token to the device’s workspace + the device_ask surface', async () => {
    await POST(req({ question: 'what is due?' }))
    const opts = h.clients[0] as { auth: { bearer: string }; headers: Record<string, string> }
    expect(opts.auth).toEqual({ bearer: 'd8d_abc' })
    expect(verifyChatRunToken(opts.headers['x-chat-run-token'])).toMatchObject({
      userId: 'user-1',
      workspaceId: 'ws-device',
      surface: 'device_ask',
    })
    const [, taskOpts] = h.createTaskSession.mock.calls[0] as [unknown, { message: string }]
    expect(taskOpts.message).toBe('what is due?')
  })

  it("on the person's own ChatGPT plan: the check opts in, the run token says so, and it's billed to the plan", async () => {
    h.checkUsageLimits.mockResolvedValue({ allowed: true, reason: 'chatgpt_plan', is_paid_plan: false })
    await POST(req({ question: 'what is due?' }))
    expect(h.checkUsageLimits).toHaveBeenCalledWith('user-1', undefined, { chatgptPlan: true })
    const opts = h.clients[0] as { headers: Record<string, string> }
    expect(verifyChatRunToken(opts.headers['x-chat-run-token'])).toMatchObject({ surface: 'device_ask', chatgptPlan: true })
    const [, row] = h.logUsage.mock.calls[0] as [string, { model: string; provider: string }]
    // The fixture's steps name no model, so the ask is billed as asked: the plan's (nothing to Dial8).
    expect(row).toMatchObject({ model: 'chatgpt-plan/gpt-6.1-sol', provider: 'chatgpt-plan' })
  })

  it('a paid person\'s run token never carries the plan claim', async () => {
    await POST(req({ question: 'what is due?' }))
    const opts = h.clients[0] as { headers: Record<string, string> }
    expect(verifyChatRunToken(opts.headers['x-chat-run-token'])!.chatgptPlan).toBeUndefined()
  })

  it('cookie / JWT callers run in their oldest workspace', async () => {
    h.authenticateUser.mockResolvedValue({ user: { id: 'user-1' }, supabase, via: 'jwt' })
    await POST(req({ question: 'q' }, { authorization: 'Bearer eyJ.jwt.sig' }))
    const opts = h.clients[0] as { headers: Record<string, string> }
    expect(verifyChatRunToken(opts.headers['x-chat-run-token'])!.workspaceId).toBe('ws-oldest')
    expect(h.resolveDeviceToken).not.toHaveBeenCalled()
  })

  it('a stale bearer next to a valid cookie (auth fell through to the cookie) relays the COOKIE, not the dead bearer', async () => {
    h.authenticateUser.mockResolvedValue({ user: { id: 'user-1' }, supabase, via: 'cookie' })
    h.resolveDeviceToken.mockResolvedValue(null)
    const res = await POST(req({ question: 'q' }, { authorization: 'Bearer d8d_expired', cookie: 'sb-access=live' }))
    expect(res.status).toBe(200)
    const opts = h.clients[0] as { auth?: unknown; headers: Record<string, string> }
    expect(opts.auth).toBeUndefined()
    expect(opts.headers.cookie).toBe('sb-access=live')
    expect(verifyChatRunToken(opts.headers['x-chat-run-token'])!.workspaceId).toBe('ws-oldest')
  })

  it('a stale d8d_ bearer that still RESOLVES next to a cookie that authenticated: the device path is not taken (workspace from the cookie user)', async () => {
    // authenticateUser fell through to the cookie (e.g. a transient getUserById
    // miss) — via says 'cookie', so the device token must not pick the workspace.
    h.authenticateUser.mockResolvedValue({ user: { id: 'user-1' }, supabase, via: 'cookie' })
    h.resolveDeviceToken.mockResolvedValue({ userId: 'someone-else', workspaceId: 'ws-device' })
    const res = await POST(req({ question: 'q' }, { authorization: 'Bearer d8d_other', cookie: 'sb-access=live' }))
    expect(res.status).toBe(200)
    expect(h.resolveDeviceToken).not.toHaveBeenCalled()
    const opts = h.clients[0] as { headers: Record<string, string> }
    expect(verifyChatRunToken(opts.headers['x-chat-run-token'])!.workspaceId).toBe('ws-oldest')
  })

  it('the resolved workspace is membership-checked for the authenticated user before anything runs; a non-member is 403 with no session', async () => {
    await POST(req({ question: 'q' }))
    expect(h.memberProbes[0]).toEqual([
      ['user_id', 'user-1'],
      ['workspace_id', 'ws-device'],
    ])

    h.isMember = false
    h.createTaskSession.mockClear()
    h.clients.length = 0
    const res = await POST(req({ question: 'q' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Not a member of the selected workspace' })
    expect(h.createTaskSession).not.toHaveBeenCalled()
    expect(h.clients).toHaveLength(0)
    expect(h.logUsage).toHaveBeenCalledTimes(1) // only the first (member) ask metered
  })

  it('a membership LOOKUP ERROR is a 500 MEMBERSHIP_LOOKUP_FAILED (retryable), never the 403 "not a member" — and nothing runs', async () => {
    h.memberError = { message: 'connection reset' }
    const res = await POST(req({ question: 'q' }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body).toEqual({ error: 'Could not verify workspace membership', code: 'MEMBERSHIP_LOOKUP_FAILED' })
    expect(body.error).not.toMatch(/member of the selected workspace/)
    expect(h.createTaskSession).not.toHaveBeenCalled()
    expect(h.clients).toHaveLength(0)
    expect(h.logUsage).not.toHaveBeenCalled()
  })

  it('membership is checked BEFORE anything runs: a non-member or a lookup error starts no session', async () => {
    h.isMember = false
    expect((await POST(req({ question: 'q' }))).status).toBe(403)
    expect(h.clients).toHaveLength(0)
    expect(h.memberProbes).toHaveLength(1) // refused by the route's own check

    h.isMember = true
    h.memberError = { message: 'connection reset' }
    h.memberProbes.length = 0
    expect((await POST(req({ question: 'q' }))).status).toBe(500)
    expect(h.clients).toHaveLength(0)
    expect(h.memberProbes).toHaveLength(1)
  })

  it('a member ask is probed twice — the route, then runDeviceAskViaEve before it writes anything', async () => {
    await POST(req({ question: 'q' }))
    expect(h.memberProbes).toHaveLength(2)
    for (const probe of h.memberProbes) {
      expect(probe).toEqual([
        ['user_id', 'user-1'],
        ['workspace_id', 'ws-device'],
      ])
    }
  })

  it('the model is fixed (Flash): an old device\'s `model` is ignored, and the per-turn ctx carries none', async () => {
    await POST(req({ question: 'q', model: 'claude-sonnet-4-5-20250929' }))
    const ctx = (h.clients[0] as { headers: Record<string, string> }).headers['x-chat-run-ctx']
    expect(JSON.parse(Buffer.from(ctx, 'base64url').toString('utf8'))).toEqual({})
    const [, row] = h.logUsage.mock.calls[0] as [string, { model: string }]
    expect(row.model).toBe('deepseek-v4-flash')
  })

  it('the eve budget is what is left of maxDuration (60s) minus the cancel + log margin — the run token’s lifetime pins it', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    await POST(req({ question: 'q' }))
    const token = (h.clients[0] as { headers: Record<string, string> }).headers['x-chat-run-token']
    expect(verifyChatRunToken(token)!.exp - Date.now()).toBe(
      deviceAskTokenTtlMs(60_000 - CANCEL_TIMEOUT_MS - DEVICE_ASK_LOG_MARGIN_MS),
    )
  })

  it('the budget is charged from the REQUEST start: a 5s prelude (auth) comes off the eve budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'))
    h.authenticateUser.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 5_000) // a slow auth round-trip
      return { user: { id: 'user-1' }, supabase, via: 'device' }
    })
    await POST(req({ question: 'q' }))
    const dispatchedAt = Date.now() // the clock only moved in the prelude
    const token = (h.clients[0] as { headers: Record<string, string> }).headers['x-chat-run-token']
    expect(verifyChatRunToken(token)!.exp - dispatchedAt).toBe(
      deviceAskTokenTtlMs(60_000 - 5_000 - CANCEL_TIMEOUT_MS - DEVICE_ASK_LOG_MARGIN_MS),
    )
  })

})

describe('POST /api/device/ask — usage row', () => {
  it('feature device_ask, tokens SUMMED over every step, null cost, metadata { toolCalls, steps }', async () => {
    await POST(req({ question: 'what is due?' }))
    expect(h.logUsage).toHaveBeenCalledTimes(1)
    const [userId, row] = h.logUsage.mock.calls[0] as [string, Record<string, unknown>]
    expect(userId).toBe('user-1')
    // Steps of 120/15 and 300/40: both billed (the legacy final-step basis under-billed the first).
    expect(row).toMatchObject({ feature: 'device_ask', model: 'deepseek-v4-flash', inputTokens: 420, outputTokens: 55 })
    expect(row.costUsd ?? null).toBeNull()
    expect(row.metadata).toEqual({ toolCalls: 1, steps: 2 })
  })

  it('adds the Gateway generationIds of every step (reconciliation key)', async () => {
    const withGid = (input: number, output: number, gid: string) =>
      ev({
        type: 'step.completed',
        data: { finishReason: 'stop', usage: { inputTokens: input, outputTokens: output }, providerMetadata: { gateway: { generationId: gid } } },
      })
    session([
      stepStarted(0),
      toolCall('list_actions'),
      withGid(120, 15, 'gen_a'),
      stepStarted(1),
      message('done'),
      withGid(300, 40, 'gen_b'),
      ev({ type: 'session.completed', data: {} }),
    ])
    await POST(req({ question: 'q' }))
    const [, row] = h.logUsage.mock.calls[0] as [string, { inputTokens: number; outputTokens: number; metadata: Record<string, unknown> }]
    expect(row).toMatchObject({ inputTokens: 420, outputTokens: 55 })
    expect(row.metadata).toEqual({ toolCalls: 1, steps: 2, generationIds: ['gen_a', 'gen_b'] })
  })

  it('a cached run carries log_ai_usage’s cache keys (only when present)', async () => {
    const cached = (input: number, cacheReadTokens: number, cacheWriteTokens: number) =>
      ev({
        type: 'step.completed',
        data: { finishReason: 'stop', usage: { inputTokens: input, outputTokens: 5, cacheReadTokens, cacheWriteTokens } },
      })
    session([stepStarted(0), cached(5000, 0, 4000), stepStarted(1), message('ok'), cached(6000, 4000, 0), ev({ type: 'session.completed', data: {} })])
    await POST(req({ question: 'q' }))
    const [, row] = h.logUsage.mock.calls[0] as [string, { inputTokens: number; metadata: Record<string, unknown> }]
    expect(row.inputTokens).toBe(11000)
    expect(row.metadata).toEqual({ toolCalls: 0, steps: 2, cache_read_input_tokens: 4000, cache_creation_input_tokens: 4000 })
  })

  it('adds webSearchCostUsd when the run searched the web', async () => {
    session([stepStarted(0), toolCall('web_search'), webSearchResult(0.005), stepCompleted(10, 1), message('ok'), ev({ type: 'session.completed', data: {} })])
    await POST(req({ question: 'news?' }))
    const [, row] = h.logUsage.mock.calls[0] as [string, { metadata: Record<string, unknown> }]
    expect(row.metadata).toEqual({ toolCalls: 1, steps: 1, webSearchCostUsd: 0.005 })
  })

  it('a step that ran on another model than the fixed one: the row bills the model that ran, read off the stream', async () => {
    const started = (i: number, modelId: string) => ev({ type: 'step.started', data: { stepIndex: i, modelId } })
    session([started(0, 'anthropic/claude-haiku-4.5'), message('ok'), stepCompleted(50, 5), ev({ type: 'session.completed', data: {} })])
    await POST(req({ question: 'q' }))
    const [, row] = h.logUsage.mock.calls[0] as [string, { model: string; provider: string; metadata: Record<string, unknown> }]
    expect(row).toMatchObject({ model: 'claude-haiku-4-5-20251001', provider: 'claude' })
    expect(row.metadata).toEqual({ toolCalls: 0, steps: 1, requestedModel: 'deepseek-v4-flash' })

    // The fixed model ran (the usual case, the chat-agent's fallback too): no requestedModel key.
    h.logUsage.mockClear()
    session([started(0, 'deepseek/deepseek-v4-flash'), message('ok'), stepCompleted(50, 5), ev({ type: 'session.completed', data: {} })])
    await POST(req({ question: 'q' }))
    const [, row2] = h.logUsage.mock.calls[0] as [string, { model: string; provider: string; metadata: Record<string, unknown> }]
    expect(row2).toMatchObject({ model: 'deepseek-v4-flash', provider: 'deepseek' })
    expect(row2.metadata).toEqual({ toolCalls: 0, steps: 1 })
  })

  it('a failed ask is metered on the model its steps ran', async () => {
    session([ev({ type: 'step.started', data: { stepIndex: 0, modelId: 'anthropic/claude-haiku-4.5' } }), stepCompleted(90, 5), ev({ type: 'session.failed', data: {} })])
    await POST(req({ question: 'q' }))
    const [, row] = h.logUsage.mock.calls[0] as [string, { model: string; metadata: Record<string, unknown> }]
    expect(row.model).toBe('claude-haiku-4-5-20251001')
    expect(row.metadata).toMatchObject({ outcome: 'failed', requestedModel: 'deepseek-v4-flash' })
  })

  it('an Exa-billed run never trusts eve’s step cost (it includes the Exa charge)', async () => {
    session([stepStarted(0), toolCall('web_search'), webSearchResult(0.007), stepCompleted(8_000, 50, 0.007), message('ok'), ev({ type: 'session.completed', data: {} })])
    await POST(req({ question: 'news?' }))
    const [, row] = h.logUsage.mock.calls[0] as [string, Record<string, unknown>]
    expect(row.costUsd ?? null).toBeNull()
    expect((row.metadata as Record<string, unknown>).webSearchCostUsd).toBe(0.007)
  })

  it('a failed ask still meters its partial spend (outcome: failed); a no-step failure logs nothing', async () => {
    session([stepStarted(0), stepCompleted(90, 5), ev({ type: 'session.failed', data: {} })])
    await POST(req({ question: 'q' }))
    const [, row] = h.logUsage.mock.calls[0] as [string, { feature: string; inputTokens: number; metadata: Record<string, unknown> }]
    expect(row).toMatchObject({ feature: 'device_ask', inputTokens: 90 })
    expect(row.metadata).toEqual({ toolCalls: 0, steps: 1, outcome: 'failed' })

    h.logUsage.mockClear()
    session([ev({ type: 'session.failed', data: {} })])
    await POST(req({ question: 'q' }))
    expect(h.logUsage).not.toHaveBeenCalled()
  })
})

describe('POST /api/device/ask — 12-step cap', () => {
  it('eve’s real shape: a 12th step that only calls tools (no message.completed) answers "" — not an earlier step’s text', async () => {
    const events: MessageStreamEvent[] = []
    for (let i = 0; i < 12; i++) {
      events.push(stepStarted(i), toolCall('list_actions'))
      if (i === 2) events.push(message('Let me check…', 'tool-calls'))
      events.push(stepCompleted(100, 10))
    }
    events.push(stepStarted(12))
    session(events, { hang: true })
    const res = await POST(req({ question: 'loop forever' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, text: '', tool_calls: 12 })
    expect(h.cancel).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
  })

  it('a run still going at its 13th model call is cancelled and answered with the 12th step’s text', async () => {
    const events: MessageStreamEvent[] = []
    for (let i = 0; i < 12; i++) {
      events.push(stepStarted(i), toolCall('list_actions'), message(i === 11 ? 'partial answer' : `s${i}`, 'tool-calls'), stepCompleted(100, 10))
    }
    events.push(stepStarted(12))
    session(events, { hang: true })

    const res = await POST(req({ question: 'loop forever' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, text: 'partial answer', tool_calls: 12 })
    expect(h.cancel).toHaveBeenCalledWith(expect.objectContaining({ signal: expect.any(AbortSignal) }))
    const [, row] = h.logUsage.mock.calls[0] as [string, { metadata: Record<string, unknown> }]
    expect(row.metadata).toEqual({ toolCalls: 12, steps: 12 })
  })
})

describe('POST /api/device/ask — the in-process path is gone', () => {
  it('no generateText, no in-route tool map; the eve dispatcher is the only model path', () => {
    const src = readFileSync(join(__dirname, '../route.ts'), 'utf8')
    expect(src).not.toMatch(/generateText|streamText|from 'ai'|createTools|pickPermittedTools|aiModel/)
    expect(src).toMatch(/runDeviceAskViaEve\(/)
  })
})
