/**
 * The orphan-steer race (always-on-agent §4, A4 slice 4; steer-ledger.ts): a
 * steer that reaches eve just after a helper's turn settled starts the NEXT
 * turn. watchWorkEveSession, at the boundary, marks the steers the turn saw
 * applied and drains an unseen one's turn as a continuation, so it is read,
 * billed and classified. A turn that never comes costs one bounded wait.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'

const h = vi.hoisted(() => ({
  ClientMock: vi.fn(),
  readSessionSnapshot: vi.fn(() => null),
  appendLog: vi.fn(async () => ({ canceling: false })),
  readCanceling: vi.fn(async () => false),
  usage: vi.fn(async () => 0),
  settle: vi.fn(),
  mark: vi.fn(async (_s: unknown, a: { ids: string[] }) => a.ids),
  create: vi.fn(),
}))

vi.mock('eve/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('eve/client')>()), Client: h.ClientMock }))
vi.mock('@/lib/eve/conversation-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/eve/conversation-session')>()),
  readSessionSnapshot: h.readSessionSnapshot,
  createConversationSession: h.create,
}))
vi.mock('../agent-run-token', () => ({
  mintAgentRunToken: vi.fn(() => 'signed.token'),
  internalSecret: vi.fn(() => 'secret-abcdefghijklmnopqrstuvwxyz'),
  AGENT_RUN_SECRET_HEADER: 'x-agent-run-secret',
  AGENT_RUN_TOKEN_HEADER: 'x-agent-run-token',
  AGENT_RUN_WORKSPACE_HEADER: 'x-agent-run-workspace',
  AGENT_RUN_USER_HEADER: 'x-agent-run-user',
}))
vi.mock('../run-agent-eve', () => ({ EVE_SANDBOX_PREFIX: 'eve:', stampEveSession: vi.fn(async () => true) }))
vi.mock('../log-tail', () => ({ appendAgentRunLog: h.appendLog, readAgentRunCanceling: h.readCanceling }))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn() }))
vi.mock('../work-run-usage', () => ({ logWorkRunUsage: h.usage }))
vi.mock('../steer-ledger', () => ({ settleSteersAtBoundary: h.settle, markSteersApplied: h.mark }))

import { runWorkViaEve, watchWorkEveSession } from '../run-work-eve'

const ev = {
  received: (message: string) => ({ type: 'message.received', data: { message, parts: [], sequence: 1, turnId: 'turn_1' } }) as unknown as HandleMessageStreamEvent,
  text: (t: string) => ({ type: 'message.appended', data: { messageDelta: t, sequence: 0, stepIndex: 0, turnId: 't' } }) as unknown as HandleMessageStreamEvent,
  waiting: () => ({ type: 'session.waiting', data: { wait: 'next-user-message' } }) as unknown as HandleMessageStreamEvent,
}

/** The run row: settled by finish_work (case 2), so the classifier persists the cursor and stops. */
function makeSupabase(status = 'completed') {
  const row: Record<string, unknown> = { status, kind: 'workspace', triggered_by: 'user-1' }
  const updates: Array<Record<string, unknown>> = []
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: async () => ({ data: { ...row }, error: null }),
    update: (patch: Record<string, unknown>) => {
      updates.push(patch)
      const w: Record<string, unknown> = { eq: () => w, select: () => w, maybeSingle: async () => ({ data: null, error: null }), then: (r: (x: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r) }
      return w
    },
  }
  return { supabase: { from: vi.fn(() => chain) }, updates }
}

/** Each stream() call takes the next turn's events; `null` is a stream with nothing to say (hangs until aborted). */
function mockSession(turns: Array<HandleMessageStreamEvent[] | null>) {
  const calls: Array<{ startIndex?: number }> = []
  const session = {
    state: { sessionId: 'sess-1', streamIndex: 0 },
    respond: vi.fn(),
    stream: vi.fn((opts: { signal?: AbortSignal; startIndex?: number } = {}) => {
      calls.push({ startIndex: opts.startIndex })
      const events = turns.shift()
      async function* gen() {
        for (const e of events ?? []) yield e
        // An attached durable stream never closes by itself.
        await new Promise<void>((_, reject) => opts.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
      }
      return gen()
    }),
  }
  h.ClientMock.mockImplementation(() => ({ sessions: { attach: () => session } }))
  return { session, calls }
}

const watch = (supabase: unknown, extra: Record<string, unknown> = {}) =>
  watchWorkEveSession({ agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1', sessionId: 'sess-1', fromIndex: 10, budgetMs: 5_000, steerWaitMs: 50, supabase: supabase as never, ...extra })

beforeEach(() => {
  vi.clearAllMocks()
  h.mark.mockImplementation(async (_s: unknown, a: { ids: string[] }) => a.ids)
  h.appendLog.mockResolvedValue({ canceling: false })
  h.readCanceling.mockResolvedValue(false)
  h.readSessionSnapshot.mockReturnValue(null)
})

describe('watchWorkEveSession: steers at the boundary', () => {
  it('passes the turn its received messages, and with no orphan reads one turn only', async () => {
    h.settle.mockResolvedValue([])
    const { supabase, updates } = makeSupabase()
    const { calls } = mockSession([[ev.received('Your agent, for you → fintech only'), ev.text('ok'), ev.waiting()]])
    const res = await watch(supabase)
    expect(res.settled).toBeNull()
    expect(h.settle).toHaveBeenCalledWith(supabase, { agentRunId: 'run-1', workspaceId: 'ws-1', receivedMessages: ['Your agent, for you → fintech only'] })
    expect(calls).toHaveLength(1)
    expect(h.mark).not.toHaveBeenCalled()
    expect(updates.find((u) => u.session_state)?.session_state).toMatchObject({ streamIndex: 13 })
  })

  it('an orphan steer: claimed first, its turn drained as a continuation from where the read stopped, billed, then classified', async () => {
    h.settle.mockResolvedValueOnce([{ id: 'relay-1', message: 'fintech only' }]).mockResolvedValueOnce([])
    const { supabase, updates } = makeSupabase()
    const { calls, session } = mockSession([
      [ev.text('done'), ev.waiting()],
      [ev.received('Your agent, for you → fintech only'), ev.text('Narrowed.'), ev.waiting()],
    ])
    const res = await watch(supabase)
    expect(res.settled).toBeNull()
    expect(h.mark).toHaveBeenCalledWith(supabase, { agentRunId: 'run-1', workspaceId: 'ws-1', ids: ['relay-1'] })
    // Claimed BEFORE the continuation is read, so a turn that never comes can't loop.
    expect(h.mark.mock.invocationCallOrder[0]).toBeLessThan(session.stream.mock.invocationCallOrder[1])
    expect(calls).toEqual([{ startIndex: undefined }, { startIndex: 12 }])
    // Each drain bills what it read (the dispatcher's own usage rows).
    expect(h.usage).toHaveBeenCalledTimes(2)
    // The continuation's received messages go to the next boundary check.
    expect(h.settle).toHaveBeenLastCalledWith(supabase, expect.objectContaining({ receivedMessages: ['Your agent, for you → fintech only'] }))
    // The cursor counts both turns: 10 + 2 + 3.
    expect(updates.find((u) => u.session_state)?.session_state).toMatchObject({ streamIndex: 15 })
  })

  it('a turn that never comes: one bounded wait, then the original disposition stands', async () => {
    h.settle.mockResolvedValue([{ id: 'relay-1', message: 'fintech only' }])
    const { supabase, updates } = makeSupabase()
    const { calls } = mockSession([[ev.text('done'), ev.waiting()], null])
    const res = await watch(supabase)
    expect(res.settled).toBeNull()
    expect(calls).toHaveLength(2)
    expect(h.mark).toHaveBeenCalledTimes(1)
    expect(updates.find((u) => u.session_state)?.session_state).toMatchObject({ streamIndex: 12 })
  })

  it('a run whose turn parked on a question never checks steers (the relay refuses a parked run)', async () => {
    const { supabase } = makeSupabase('running')
    const inputRequested = {
      type: 'input.requested',
      data: {
        requests: [{ requestId: 'r', prompt: 'Q', display: 'confirmation', options: [{ id: 'approve', label: 'A' }, { id: 'deny', label: 'D' }],
          action: { callId: 'c', kind: 'tool-call', toolName: 'request_user_input', input: { questions: [{ question: 'Which?', header: 'h', options: [{ label: 'x' }], multiSelect: false }] } } }],
        sequence: 0, stepIndex: 0, turnId: 't',
      },
    } as unknown as HandleMessageStreamEvent
    mockSession([[inputRequested, ev.waiting()]])
    await watch(supabase)
    expect(h.settle).not.toHaveBeenCalled()
  })

  it('caps continuations per watch', async () => {
    h.settle.mockResolvedValue([{ id: 'relay-x', message: 'again' }])
    const { supabase } = makeSupabase()
    const { calls } = mockSession([[ev.waiting()], [ev.waiting()], [ev.waiting()], [ev.waiting()], [ev.waiting()]])
    await watch(supabase)
    // The first read plus at most three continuations.
    expect(calls).toHaveLength(4)
  })

  it('a steer the relay already claimed (its after-settle drain) is not read twice', async () => {
    h.settle.mockResolvedValue([{ id: 'relay-1', message: 'fintech only' }])
    h.mark.mockResolvedValue([])
    const { supabase } = makeSupabase()
    const { calls } = mockSession([[ev.text('done'), ev.waiting()], [ev.waiting()]])
    await watch(supabase)
    expect(calls).toHaveLength(1)
  })

  it('a steer landing after a handoff refusal or empty-ask turn is drained too (the boundary after driveTurns)', async () => {
    h.settle.mockResolvedValueOnce([{ id: 'relay-1', message: 'x' }]).mockResolvedValueOnce([])
    const { supabase } = makeSupabase()
    // The session's own snapshot knows where the read ended (past any respond() turns).
    h.readSessionSnapshot.mockReturnValue({ sessionId: 'sess-1', streamIndex: 40 } as never)
    const { calls } = mockSession([[ev.waiting()], [ev.received('Your agent, for you → x'), ev.waiting()]])
    await watch(supabase)
    expect(calls[1]).toEqual({ startIndex: 40 })
  })
})

describe('runWorkViaEve (in process): steers at the boundary too', () => {
  it('drains an orphan steer after the first turn, from the session snapshot', async () => {
    h.settle.mockResolvedValueOnce([{ id: 'relay-1', message: 'fintech only' }]).mockResolvedValueOnce([])
    const { supabase } = makeSupabase()
    const { session, calls } = mockSession([[ev.received('Your agent, for you → fintech only'), ev.text('Narrowed.'), ev.waiting()]])
    async function* firstTurn() {
      yield ev.text('done')
      yield ev.waiting()
    }
    h.create.mockResolvedValue({ sessionId: 'sess-1', session, response: firstTurn() })
    h.readSessionSnapshot.mockReturnValue({ sessionId: 'sess-1', streamIndex: 2 } as never)
    const res = await runWorkViaEve({ agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1', brief: { task: 'x' } as never, supabase: supabase as never })
    expect(res.settled).toBeNull()
    expect(h.mark).toHaveBeenCalledWith(supabase, { agentRunId: 'run-1', workspaceId: 'ws-1', ids: ['relay-1'] })
    expect(calls).toEqual([{ startIndex: 2 }])
    expect(h.usage).toHaveBeenCalledTimes(2)
  })
})
