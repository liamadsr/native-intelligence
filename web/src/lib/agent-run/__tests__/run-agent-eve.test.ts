/**
 * Watcher-branch tests for the eve coding-agent runtime (Phase 3).
 *
 * runAgentViaEve streams a durable eve session and mirrors progress into
 * agent_run.log_tail, then reconciles the terminal state. Four behaviors are
 * pinned here (eve/client + the token module both mocked so the suite is
 * independent of the network AND of the parallel token workstream):
 *   - happy path: events mirror to log_tail; the OUTCOME ROUTE already settled
 *     the row terminal (finish_run) → watcher no-ops, does NOT re-settle;
 *   - agent-died: stream ends, row still non-terminal → watcher settles 'failed'
 *     with the exact error string;
 *   - cancel: row flips to 'canceling' mid-stream → watcher aborts the client
 *     stream + settles 'canceled';
 *   - the eve session id is stamped onto sandbox_id with the `eve:` prefix.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'

const SECRET = 'test-agent-run-secret-abcdefghij'

// ── Mock eve/client (client construction) + the task-session helper (dispatch) ─
// vi.mock is hoisted; the mock fns come from vi.hoisted so the factory can see them.
// runAgentViaEve builds a Client (mount + auth headers asserted) then dispatches
// through createTaskSession — the TASK-mode path (a headless coding run must
// finish this dispatch; conversation mode would hang it on a park). We mock the
// helper to return the streamed MessageResponse the watcher consumes.
const h = vi.hoisted(() => {
  const createTaskSessionMock = vi.fn()
  // The watcher's own eve session cancel (cancel paths) goes through
  // client.sessions.attach(id).cancel() (eve 0.69+ stops working tasks too).
  const sessionCancelMock = vi.fn(async () => ({ status: 'accepted' as const }))
  const attachMock = vi.fn(() => ({ cancel: sessionCancelMock }))
  const ClientMock = vi.fn(() => ({ sessions: { attach: attachMock } }))
  const retireTaskSessionMock = vi.fn(async () => true)
  return { createTaskSessionMock, ClientMock, attachMock, sessionCancelMock, retireTaskSessionMock }
})
const { createTaskSessionMock, ClientMock, attachMock, sessionCancelMock, retireTaskSessionMock } = h
// The real boundary predicate (the re-attached watch ends on it); only Client is faked.
vi.mock('eve/client', async (orig) => ({
  isCurrentTurnBoundaryEvent: (await orig<typeof import('eve/client')>()).isCurrentTurnBoundaryEvent,
  Client: h.ClientMock,
}))
vi.mock('@/lib/eve/task-session', () => ({ createTaskSession: h.createTaskSessionMock, retireTaskSession: h.retireTaskSessionMock }))

// ── Mock the token module — independent of the parallel workstream ──────────
// We only need mint (opaque string) + internalSecret (must be truthy) + the
// header constants. The real HMAC is exercised in agent-run-token.test.ts.
vi.mock('../agent-run-token', () => ({
  mintAgentRunToken: vi.fn(() => 'signed.token'),
  internalSecret: vi.fn(() => SECRET),
  AGENT_RUN_SECRET_HEADER: 'x-agent-run-secret',
  AGENT_RUN_TOKEN_HEADER: 'x-agent-run-token',
  AGENT_RUN_WORKSPACE_HEADER: 'x-agent-run-workspace',
  AGENT_RUN_USER_HEADER: 'x-agent-run-user',
}))

import { runAgentViaEve, startAgentEveSession, cancelEveCodingSession, EVE_SANDBOX_PREFIX } from '../run-agent-eve'
import { internalSecret } from '../agent-run-token'

// ── Stream event builders ────────────────────────────────────────────────────
function messageAppended(delta: string): HandleMessageStreamEvent {
  return {
    type: 'message.appended',
    data: { messageDelta: delta, sequence: 0, stepIndex: 0, turnId: 't' },
  } as HandleMessageStreamEvent
}
function actionsRequested(...toolNames: string[]): HandleMessageStreamEvent {
  return {
    type: 'actions.requested',
    data: {
      actions: toolNames.map((toolName) => ({ kind: 'tool-call', toolName, callId: 'c', input: {} })),
      sequence: 0,
      stepIndex: 0,
      turnId: 't',
    },
  } as unknown as HandleMessageStreamEvent
}
function sessionCompleted(): HandleMessageStreamEvent {
  return { type: 'session.completed' } as HandleMessageStreamEvent
}
/** A successful tool result — renderEventLine maps it to NO log line. */
function actionSucceeded(): HandleMessageStreamEvent {
  return { type: 'action.result', data: { status: 'succeeded' } } as unknown as HandleMessageStreamEvent
}

/**
 * A stateful agent_run stub. Tracks ONE row's mutable state and records update
 * calls. `statusScript` lets a test flip the row's status on the Nth *read* so a
 * cancel can land "mid-stream". Every from('agent_run') read returns the current
 * row; from('actions') is a recorded no-op sink.
 */
function makeSupabase(init: {
  status: string
  actionId?: string | null
  logTail?: string | null
  sandboxId?: string | null
  /** Optional: return this status on the Nth agent_run read (1-indexed), latching. */
  statusAtRead?: { at: number; status: string }
  /** agent_run reads (1-indexed) that RESOLVE `{ data: null, error }` — how
   *  supabase-js reports a network/PostgREST failure (it does not throw). */
  readErrorAt?: number[]
  /** The early session stamp (the first sandbox_id-only update) resolves an error. */
  stampError?: boolean
}) {
  const row = {
    status: init.status,
    // `'actionId' in init` so an explicit `actionId: null` (a flow-origin run)
    // stays null instead of silently becoming 'action-1'.
    action_id: 'actionId' in init ? (init.actionId ?? null) : 'action-1',
    log_tail: init.logTail ?? null as string | null,
    sandbox_id: init.sandboxId ?? null as string | null,
  }
  let reads = 0
  let stampErrored = false
  const updates: Array<{
    table: string
    patch: Record<string, unknown>
    is?: Record<string, unknown>
    eqs?: Record<string, unknown>
    readsBefore?: number
    took?: boolean
  }> = []

  function agentRunChain() {
    // Terminal read returns a fresh snapshot of `row` (post any latched flip).
    const read = () => {
      reads += 1
      if (init.statusAtRead && reads >= init.statusAtRead.at) {
        row.status = init.statusAtRead.status
      }
      if (init.readErrorAt?.includes(reads)) {
        return Promise.resolve({ data: null, error: { message: 'TypeError: fetch failed' } })
      }
      return Promise.resolve({ data: { ...row }, error: null })
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: read,
      single: read,
      update: (patch: Record<string, unknown>) => {
        const rec = {
          table: 'agent_run',
          patch,
          is: {} as Record<string, unknown>,
          eqs: {} as Record<string, unknown>,
          readsBefore: reads,
          took: undefined as boolean | undefined,
        }
        updates.push(rec)
        const isStamp = Object.keys(patch).length === 1 && 'sandbox_id' in patch
        const errored = !!init.stampError && isStamp && !stampErrored
        if (errored) stampErrored = true
        // Applied when the query resolves, honoring the WHERE the way the
        // database would for the columns this row models: `.is(k, null)` and
        // `.eq('sandbox_id', v)` (the stamp's guards). Other filters pass.
        const apply = () => {
          if (errored) return { data: null, error: { message: 'stamp write failed' } }
          const r = row as Record<string, unknown>
          const isOk = Object.entries(rec.is).every(([k, v]) => (v === null ? r[k] == null : r[k] === v))
          const eqOk = !('sandbox_id' in rec.eqs) || r.sandbox_id === rec.eqs.sandbox_id
          rec.took = isOk && eqOk
          if (rec.took) Object.assign(row, patch)
          return { data: rec.took ? [{ id: 'agent-run-1' }] : [], error: null }
        }
        const withSelect = {
          eq: (k: string, v: unknown) => {
            rec.eqs[k] = v
            return withSelect
          },
          is: (k: string, v: unknown) => {
            rec.is[k] = v
            return withSelect
          },
          select: () => Promise.resolve().then(apply),
          then: (r: (x: unknown) => unknown) =>
            Promise.resolve()
              .then(apply)
              .then((res) => ({ error: res.error }))
              .then(r),
        }
        return withSelect
      },
    }
    return chain
  }
  function actionsChain() {
    const chain: Record<string, unknown> = {
      update: (patch: Record<string, unknown>) => {
        updates.push({ table: 'actions', patch })
        return { eq: () => Promise.resolve({ error: null }) }
      },
    }
    return chain
  }

  // The work ledger's lookup (`findWork`: select → eq → order → limit →
  // maybeSingle). No row here: the mirror is a no-op for these runs.
  function ledgerChain() {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    }
    return chain
  }

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'actions') return actionsChain()
      if (table === 'tracked_job') return ledgerChain()
      return agentRunChain()
    }),
  }
  return { supabase, updates, getRow: () => row, readCount: () => reads }
}

/**
 * Make createTaskSession resolve to a MessageResponse-like async-iterable over
 * `events`. The signal is threaded from the second arg (createTaskSession(client,
 * { message, signal })) so a cancel-driven abort interrupts the stream, exactly
 * as the real helper's resumed .stream({ signal }) does.
 */
function mockSend(events: HandleMessageStreamEvent[], sessionId = 'sess-eve-1') {
  createTaskSessionMock.mockImplementation((_client: unknown, input: { signal?: AbortSignal }) => {
    const signal = input?.signal
    async function* gen() {
      for (const ev of events) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        yield ev
      }
    }
    // A MessageResponse-like value. eve 0.31.0 removed continuationToken from the
    // response entirely — the sessionId is the whole handle.
    const response = {
      sessionId,
      [Symbol.asyncIterator]: () => gen()[Symbol.asyncIterator](),
    }
    return Promise.resolve(response)
  })
}

describe('runAgentViaEve', () => {
  beforeEach(() => {
    createTaskSessionMock.mockReset()
    ClientMock.mockClear()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })
  afterEach(() => {
    vi.clearAllMocks()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })

  it('happy path: mirrors events to log_tail; outcome route already settled → no re-settle', async () => {
    // Row is 'queued' during the stream, then the outcome route settles it
    // 'pr_open' before the post-stream reconcile read. We model that by latching
    // the terminal status on the FINAL read (the reconcile).
    const { supabase, updates } = makeSupabase({
      status: 'queued',
      // The reconcile read is the last agent_run read; flip to terminal there.
      statusAtRead: { at: 3, status: 'pr_open' },
    })
    mockSend([messageAppended('working on it'), actionsRequested('bash'), sessionCompleted()])

    const res = await runAgentViaEve({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
    })

    // Watcher did NOT settle — the outcome route owns the terminal state.
    expect(res.settled).toBeNull()
    expect(res.sessionId).toBe('sess-eve-1')
    // eve 0.67+ parks every session: a finished coding run retires its own.
    expect(retireTaskSessionMock).toHaveBeenCalledWith(expect.anything(), 'sess-eve-1', expect.anything())

    // Progress WAS mirrored (a log_tail update happened) and the eve session id
    // was stamped with the `eve:` prefix.
    const logUpdates = updates.filter((u) => u.table === 'agent_run' && 'log_tail' in u.patch)
    expect(logUpdates.length).toBeGreaterThan(0)
    const stamped = updates.find((u) => typeof u.patch.sandbox_id === 'string')
    expect(stamped?.patch.sandbox_id).toBe(`${EVE_SANDBOX_PREFIX}sess-eve-1`)

    // No terminal write from the watcher (no status:'failed'/'canceled').
    const terminalWrites = updates.filter(
      (u) => u.patch.status === 'failed' || u.patch.status === 'canceled',
    )
    expect(terminalWrites).toHaveLength(0)

    // Dispatch went through createTaskSession (the TASK-mode path) with the
    // kickoff message + an abort signal — NOT the mode-less typed send() that
    // would hang the run on a HITL/limit park.
    expect(createTaskSessionMock).toHaveBeenCalledTimes(1)
    const [clientArg, payload] = createTaskSessionMock.mock.calls[0]
    expect(clientArg).toBe(ClientMock.mock.results[0].value)
    expect(payload.message).toContain('Begin the coding run')
    expect(payload.signal).toBeInstanceOf(AbortSignal)

    // The mount + auth headers are wired.
    const clientOpts = (ClientMock.mock.calls[0] as unknown[])[0] as {
      host: string
      headers: Record<string, string>
      redirect: string
    }
    // eve 0.58+ mounts named agents at /eve/<name>/v1/* (the pre-0.58
    // /eve/agents/<name>/eve/v1/* shape now 404s).
    expect(new URL(clientOpts.host).pathname).toBe('/eve/coding-agent')
    expect(clientOpts.headers['x-agent-run-secret']).toBe(SECRET)
    expect(clientOpts.headers['x-agent-run-token']).toBe('signed.token')
    expect(clientOpts.redirect).toBe('error')
  })

  it('agent-died: stream ends with row non-terminal → settles failed with the exact error', async () => {
    // Row stays 'running' the whole way — no finish_run, no cancel.
    const { supabase, updates } = makeSupabase({ status: 'running' })
    mockSend([messageAppended('did some stuff'), sessionCompleted()])

    const res = await runAgentViaEve({
      agentRunId: 'run-2',
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
    })

    expect(res.settled).toBe('failed')
    const failWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'failed')
    expect(failWrite).toBeDefined()
    expect(failWrite!.patch.error_message).toBe('agent ended without reporting an outcome')
    // Action mirror to 'failed'.
    const actionFail = updates.find((u) => u.table === 'actions' && u.patch.agent_run_status === 'failed')
    expect(actionFail).toBeDefined()
  })

  it('cancel: row flips to canceling mid-stream → aborts stream + settles canceled', async () => {
    // The row is 'running'; the SECOND agent_run read (the first in-loop flush's
    // cancel check) returns 'canceling'. The stream has many events so the abort
    // interrupts it — the generator throws AbortError on the next yield.
    const { supabase, updates } = makeSupabase({
      status: 'running',
      statusAtRead: { at: 1, status: 'canceling' },
    })
    mockSend([
      actionsRequested('bash'),
      messageAppended('a'.repeat(1000)), // > LOG_FLUSH_CHARS forces a flush → cancel read
      messageAppended('more'),
      messageAppended('and more'),
      sessionCompleted(),
    ])

    const res = await runAgentViaEve({
      agentRunId: 'run-3',
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
    })

    expect(res.settled).toBe('canceled')
    const cancelWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'canceled')
    expect(cancelWrite).toBeDefined()
    expect(cancelWrite!.patch.error_message).toBe('Canceled by user')
    // Action mirror back to 'idle' (not 'failed').
    const actionIdle = updates.find((u) => u.table === 'actions' && u.patch.agent_run_status === 'idle')
    expect(actionIdle).toBeDefined()
  })

  it('cancel after agentRunCancel already settled the row canceled → watcher still stops (no re-settle)', async () => {
    // agentRunCancel's CAS settles canceling → canceled within seconds; the
    // watcher's cancel read must keep treating that as "stop".
    const { supabase, updates, getRow } = makeSupabase({
      status: 'running',
      statusAtRead: { at: 1, status: 'canceled' },
    })
    mockSend([
      actionsRequested('bash'),
      messageAppended('a'.repeat(1000)),
      messageAppended('more'),
      sessionCompleted(),
    ])

    const res = await runAgentViaEve({
      agentRunId: 'run-3b',
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
    })

    // Stopped on the canceled row: the stream was abandoned at the first flush,
    // so nothing after it reached log_tail. The row was already terminal, so no
    // second settle and no action write.
    expect(getRow().log_tail ?? '').not.toContain('more')
    expect(res.settled).toBeNull()
    expect(updates.find((u) => u.patch.status === 'canceled' || u.patch.status === 'failed')).toBeUndefined()
    expect(updates.find((u) => u.table === 'actions')).toBeUndefined()
  })

  it('throws when the internal secret is unset (guard before minting)', async () => {
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null)
    const { supabase } = makeSupabase({ status: 'queued' })
    await expect(
      runAgentViaEve({
        agentRunId: 'run-4',
        workspaceId: 'ws-1',
        userId: 'user-1',
        supabase: supabase as never,
      }),
    ).rejects.toThrow(/AGENT_RUN_INTERNAL_SECRET/)
  })
})

// ── Flow-origin runs (action_id NULL) through the watcher's settles ──────────
describe('runAgentViaEve — flow-origin (no action)', () => {
  beforeEach(() => {
    createTaskSessionMock.mockReset()
    ClientMock.mockClear()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })
  afterEach(() => vi.clearAllMocks())

  it('agent-died: settles agent_run failed and writes nothing to actions', async () => {
    const { supabase, updates, getRow } = makeSupabase({ status: 'running', actionId: null })
    expect(getRow().action_id).toBeNull()
    mockSend([messageAppended('did some stuff'), sessionCompleted()])

    const res = await runAgentViaEve({
      agentRunId: 'run-f1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
    })

    expect(res.settled).toBe('failed')
    expect(updates.find((u) => u.table === 'agent_run' && u.patch.status === 'failed')?.patch.error_message).toBe(
      'agent ended without reporting an outcome',
    )
    expect(updates.filter((u) => u.table === 'actions')).toEqual([])
  })

  it('cancel: settles agent_run canceled and writes nothing to actions', async () => {
    const { supabase, updates } = makeSupabase({
      status: 'running',
      actionId: null,
      statusAtRead: { at: 1, status: 'canceling' },
    })
    mockSend([
      actionsRequested('bash'),
      messageAppended('a'.repeat(1000)),
      messageAppended('more'),
      sessionCompleted(),
    ])

    const res = await runAgentViaEve({
      agentRunId: 'run-f2',
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
    })

    expect(res.settled).toBe('canceled')
    expect(updates.find((u) => u.table === 'agent_run' && u.patch.status === 'canceled')).toBeDefined()
    expect(updates.filter((u) => u.table === 'actions')).toEqual([])
  })
})

// ── Server-side session cancel (agentRunCancel's preempt) ────────────────────
describe('cancelEveCodingSession', () => {
  afterEach(() => {
    vi.clearAllMocks()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })

  function mockClientWithCancel(cancel: ReturnType<typeof vi.fn>) {
    const attach = vi.fn(() => ({ cancel }))
    ClientMock.mockImplementationOnce(() => ({ sessions: { attach } }) as never)
    return attach
  }

  it('attaches to the session on the coding-agent mount with the dispatch auth and cancels turn + tasks', async () => {
    const cancel = vi.fn(async () => ({ sessionId: 'sess-9', status: 'accepted' as const }))
    const attach = mockClientWithCancel(cancel)

    const res = await cancelEveCodingSession({
      sessionId: 'sess-9',
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
    })

    expect(res).toBe('accepted')
    expect(attach).toHaveBeenCalledWith('sess-9')
    expect(cancel).toHaveBeenCalledWith()
    const opts = (ClientMock.mock.calls.at(-1) as unknown[])[0] as {
      host: string
      auth: { bearer: string }
      headers: Record<string, string>
      redirect: string
    }
    expect(new URL(opts.host).pathname).toBe('/eve/coding-agent')
    expect(opts.auth).toEqual({ bearer: SECRET })
    expect(opts.headers['x-agent-run-token']).toBe('signed.token')
    expect(opts.redirect).toBe('error')
  })

  describe('dispatch origin (eveDispatchOrigin): THIS deployment, never production from a preview', () => {
    afterEach(() => vi.unstubAllEnvs())

    async function clientOptsFor() {
      mockClientWithCancel(vi.fn(async () => ({ sessionId: 'sess-9', status: 'accepted' as const })))
      await cancelEveCodingSession({ sessionId: 'sess-9', agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1' })
      return (ClientMock.mock.calls.at(-1) as unknown[])[0] as { host: string; headers: Record<string, string> }
    }

    it('on Vercel: https://VERCEL_URL even when NEXT_PUBLIC_APP_URL is production, plus the protection bypass', async () => {
      vi.stubEnv('VERCEL_URL', 'dial8-git-feature.vercel.app')
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev')
      vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'bypass-123')
      const opts = await clientOptsFor()
      expect(opts.host).toBe('https://dial8-git-feature.vercel.app/eve/coding-agent')
      expect(opts.headers['x-vercel-protection-bypass']).toBe('bypass-123')
    })

    it('off Vercel: NEXT_PUBLIC_APP_URL, and no bypass header without the secret', async () => {
      vi.stubEnv('VERCEL_URL', '')
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://staging.example')
      vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
      const opts = await clientOptsFor()
      expect(opts.host).toBe('https://staging.example/eve/coding-agent')
      expect(opts.headers).not.toHaveProperty('x-vercel-protection-bypass')
    })
  })

  it("passes eve's no_active_turn through (the session already finished)", async () => {
    mockClientWithCancel(vi.fn(async () => ({ status: 'no_active_turn' as const })))
    const res = await cancelEveCodingSession({
      sessionId: 's',
      agentRunId: 'r',
      workspaceId: 'w',
      userId: 'u',
    })
    expect(res).toBe('no_active_turn')
  })

  it('never throws: an eve transport error resolves to error', async () => {
    mockClientWithCancel(vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await cancelEveCodingSession({
      sessionId: 's',
      agentRunId: 'r',
      workspaceId: 'w',
      userId: 'u',
    })
    expect(res).toBe('error')
    warn.mockRestore()
  })

  it('no internal secret → not_configured, no client built', async () => {
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null)
    ClientMock.mockClear()
    const res = await cancelEveCodingSession({
      sessionId: 's',
      agentRunId: 'r',
      workspaceId: 'w',
      userId: 'u',
    })
    expect(res).toBe('not_configured')
    expect(ClientMock).not.toHaveBeenCalled()
  })
})

// ── The watcher stops the eve SESSION on cancel, not just its own stream ─────
// agentRunCancel cancels the session only when its (memoized) load-run saw an
// `eve:` sandbox_id. The watcher holds the session id, so its cancel branches
// cancel the session themselves; and the id is stamped the moment the session
// exists, before any event (a silent model never triggers a log flush).
describe('runAgentViaEve — session cancel + early stamp', () => {
  beforeEach(() => {
    createTaskSessionMock.mockReset()
    ClientMock.mockClear()
    attachMock.mockClear()
    sessionCancelMock.mockClear()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })
  afterEach(() => vi.clearAllMocks())

  const run = (supabase: unknown, agentRunId = 'run-c') =>
    runAgentViaEve({
      agentRunId,
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
    })

  it('stamps eve:<sessionId> right after session create — before any read or event — and only into an empty sandbox_id', async () => {
    const { supabase, updates } = makeSupabase({ status: 'queued', statusAtRead: { at: 2, status: 'pr_open' } })
    mockSend([actionSucceeded(), sessionCompleted()])

    await run(supabase)

    const first = updates[0]
    expect(first.table).toBe('agent_run')
    expect(first.patch).toEqual({ sandbox_id: `${EVE_SANDBOX_PREFIX}sess-eve-1` })
    expect(first.readsBefore).toBe(0)
    expect(first.is).toEqual({ sandbox_id: null })
    // No rendered event ever flushed, yet the row carries the session id.
    expect(updates.some((u) => 'log_tail' in u.patch)).toBe(false)
  })

  it('quiet run: an EMPTY-buffer flush that reads a canceled row stops the stream AND cancels the eve session', async () => {
    // The first event renders no line, so the first flush takes the empty-buffer
    // branch (readAgentRunCanceling), which reads the row already 'canceled' by
    // agentRunCancel.
    const { supabase, updates, getRow } = makeSupabase({
      status: 'running',
      statusAtRead: { at: 1, status: 'canceled' },
    })
    mockSend([actionSucceeded(), messageAppended('more'), messageAppended('after stop'), sessionCompleted()])

    const res = await run(supabase)

    // The stream was abandoned at that flush: nothing after it reached log_tail.
    expect(getRow().log_tail ?? '').not.toContain('more')
    expect(updates.some((u) => 'log_tail' in u.patch)).toBe(false)
    // The session itself was told to stop (turn + background tasks).
    expect(attachMock).toHaveBeenCalledWith('sess-eve-1')
    expect(sessionCancelMock).toHaveBeenCalledWith()
    expect(res.sessionCancel).toBe('accepted')
    // Row was already terminal: no second settle, no action write.
    expect(res.settled).toBeNull()
    expect(updates.find((u) => u.patch.status === 'canceled' || u.patch.status === 'failed')).toBeUndefined()
    expect(updates.find((u) => u.table === 'actions')).toBeUndefined()
  })

  it('canceling seen mid-stream → cancels the eve session, then settles canceled', async () => {
    const { supabase, updates } = makeSupabase({
      status: 'running',
      statusAtRead: { at: 1, status: 'canceling' },
    })
    mockSend([messageAppended('a'.repeat(1000)), messageAppended('more'), sessionCompleted()])

    const res = await run(supabase)

    expect(sessionCancelMock).toHaveBeenCalledTimes(1)
    expect(attachMock).toHaveBeenCalledWith('sess-eve-1')
    expect(res.sessionCancel).toBe('accepted')
    expect(res.settled).toBe('canceled')
    expect(updates.find((u) => u.table === 'agent_run' && u.patch.status === 'canceled')).toBeDefined()
  })

  it('row went canceling after the stream ended → the reconcile cancels the session too', async () => {
    // Reads: 1 = the in-loop flush's append, 2 = the final (empty-buffer) flush's
    // cancel read, 3 = the post-stream reconcile read — the first to see canceling.
    const { supabase } = makeSupabase({ status: 'running', statusAtRead: { at: 3, status: 'canceling' } })
    mockSend([messageAppended('x'), sessionCompleted()])

    const res = await run(supabase)

    expect(sessionCancelMock).toHaveBeenCalledWith()
    expect(res.settled).toBe('canceled')
  })

  it('an eve cancel failure never blocks the settle', async () => {
    sessionCancelMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { supabase } = makeSupabase({ status: 'running', statusAtRead: { at: 1, status: 'canceling' } })
    mockSend([messageAppended('a'.repeat(1000)), sessionCompleted()])

    const res = await run(supabase)

    expect(res.sessionCancel).toBe('error')
    expect(res.settled).toBe('canceled')
    warn.mockRestore()
  })

  it('no cancel on the normal paths (finish_run settled, or agent died)', async () => {
    const settledRun = makeSupabase({ status: 'running', statusAtRead: { at: 2, status: 'pr_open' } })
    mockSend([messageAppended('x'), sessionCompleted()])
    await run(settledRun.supabase)
    const diedRun = makeSupabase({ status: 'running' })
    mockSend([messageAppended('x'), sessionCompleted()])
    await run(diedRun.supabase, 'run-d')
    expect(sessionCancelMock).not.toHaveBeenCalled()
  })
})

// ── A DB blip is not a Stop; the stamp is honest about what it wrote ─────────
// supabase-js RESOLVES a failed read as { data: null, error } (it does not
// throw). Reading that as "row gone" would cancel a healthy session and settle
// it 'Canceled by user'. And the early stamp only counts when THIS session's id
// is actually on the row.
describe('runAgentViaEve — transient read errors + stamp fallbacks', () => {
  beforeEach(() => {
    createTaskSessionMock.mockReset()
    ClientMock.mockClear()
    attachMock.mockClear()
    sessionCancelMock.mockClear()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })
  afterEach(() => vi.clearAllMocks())

  const run = (supabase: unknown, agentRunId = 'run-t') =>
    runAgentViaEve({
      agentRunId,
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
    })

  const stopWrites = (updates: Array<{ table: string; patch: Record<string, unknown> }>) =>
    updates.filter((u) => u.patch.status === 'canceled' || u.patch.status === 'failed' || u.table === 'actions')

  it('an EMPTY-buffer flush whose read resolves an error keeps the run going: no session cancel, no settle', async () => {
    // Reads: 1 = the empty-buffer cancel read (errors), 2 = the final flush's
    // append, 3 = the reconcile (finish_run has settled it by then).
    const { supabase, updates, getRow } = makeSupabase({
      status: 'running',
      readErrorAt: [1],
      statusAtRead: { at: 3, status: 'pr_open' },
    })
    mockSend([actionSucceeded(), messageAppended('after the blip'), sessionCompleted()])

    const res = await run(supabase)

    expect(sessionCancelMock).not.toHaveBeenCalled()
    expect(res.sessionCancel).toBeUndefined()
    expect(res.settled).toBeNull()
    expect(stopWrites(updates)).toEqual([])
    // The stream was NOT abandoned: later output still reached log_tail.
    expect(getRow().log_tail ?? '').toContain('after the blip')
  })

  it("a log append whose read resolves an error keeps the run going (no 'Canceled by user')", async () => {
    const { supabase, updates, getRow } = makeSupabase({
      status: 'running',
      readErrorAt: [1],
      statusAtRead: { at: 3, status: 'pr_open' },
    })
    mockSend([messageAppended('a'.repeat(1000)), messageAppended('after the blip'), sessionCompleted()])

    const res = await run(supabase)

    expect(sessionCancelMock).not.toHaveBeenCalled()
    expect(res.settled).toBeNull()
    expect(stopWrites(updates)).toEqual([])
    expect(getRow().log_tail ?? '').toContain('after the blip')
  })

  it('early stamp errors → the FIRST log flush stamps instead, and only the first', async () => {
    const { supabase, updates, getRow } = makeSupabase({
      status: 'running',
      stampError: true,
      statusAtRead: { at: 4, status: 'pr_open' },
    })
    mockSend([messageAppended('a'.repeat(1000)), messageAppended('b'.repeat(1000)), sessionCompleted()])

    await run(supabase)

    const logWrites = updates.filter((u) => u.table === 'agent_run' && 'log_tail' in u.patch)
    expect(logWrites.length).toBeGreaterThanOrEqual(2)
    expect(logWrites[0].patch.sandbox_id).toBe(`${EVE_SANDBOX_PREFIX}sess-eve-1`)
    for (const later of logWrites.slice(1)) expect('sandbox_id' in later.patch).toBe(false)
    expect(getRow().sandbox_id).toBe(`${EVE_SANDBOX_PREFIX}sess-eve-1`)
  })

  it('retry: the row still carries the FIRST attempt’s eve session → swaps the stamp by CAS and cancels the superseded session', async () => {
    const { supabase, updates, getRow } = makeSupabase({
      status: 'running',
      sandboxId: `${EVE_SANDBOX_PREFIX}sess-old`,
      statusAtRead: { at: 4, status: 'pr_open' },
    })
    mockSend([messageAppended('x'), sessionCompleted()])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const res = await run(supabase)
    expect(warn).toHaveBeenCalledWith(
      '[agent-run-eve] superseded a prior eve session on this run',
      expect.objectContaining({ priorSessionId: 'sess-old', priorCancel: 'accepted' }),
    )
    warn.mockRestore()

    // The empty-slot stamp matched nothing (the guard held) …
    const stamps = updates.filter((u) => u.table === 'agent_run' && Object.keys(u.patch).join() === 'sandbox_id')
    expect(stamps[0].is).toEqual({ sandbox_id: null })
    expect(stamps[0].took).toBe(false)
    // … then the swap CASed on the observed old value and landed.
    expect(stamps[1].eqs).toMatchObject({ sandbox_id: `${EVE_SANDBOX_PREFIX}sess-old`, workspace_id: 'ws-1' })
    expect(stamps[1].took).toBe(true)
    // agentRunCancel now targets the session this watcher is streaming.
    expect(getRow().sandbox_id).toBe(`${EVE_SANDBOX_PREFIX}sess-eve-1`)
    // The superseded session was told to stop; the live one was not.
    expect(attachMock).toHaveBeenCalledTimes(1)
    expect(attachMock).toHaveBeenCalledWith('sess-old')
    expect(res.settled).toBeNull()
  })

  it('a non-eve sandbox_id already on the row is never overwritten, and nothing is canceled', async () => {
    const { supabase, getRow } = makeSupabase({
      status: 'running',
      sandboxId: 'sbx-not-eve',
      statusAtRead: { at: 4, status: 'pr_open' },
    })
    mockSend([messageAppended('x'), sessionCompleted()])

    await run(supabase)

    expect(getRow().sandbox_id).toBe('sbx-not-eve')
    expect(attachMock).not.toHaveBeenCalled()
  })
})

describe('split dispatch: startAgentEveSession + a budgeted re-attach watch', () => {
  beforeEach(() => {
    createTaskSessionMock.mockReset()
    ClientMock.mockClear()
    attachMock.mockClear()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })

  it('startAgentEveSession creates ONE task session and stamps it, without reading the stream', async () => {
    const { supabase, updates } = makeSupabase({ status: 'queued' })
    createTaskSessionMock.mockResolvedValue({ sessionId: 'sess-new', [Symbol.asyncIterator]: () => { throw new Error('must not stream') } })
    const res = await startAgentEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
    })
    expect(res).toEqual({ sessionId: 'sess-new', stamped: true })
    expect(createTaskSessionMock).toHaveBeenCalledTimes(1)
    expect(updates.find((u) => typeof u.patch.sandbox_id === 'string')?.patch.sandbox_id).toBe(`${EVE_SANDBOX_PREFIX}sess-new`)
  })

  /** attach(id, { streamIndex }).stream({ signal }) yields `events`, then (optionally) hangs until aborted. */
  function mockAttachStream(events: HandleMessageStreamEvent[], opts: { hang?: boolean } = {}) {
    const streamMock = vi.fn(({ signal }: { signal?: AbortSignal }) => ({
      async *[Symbol.asyncIterator]() {
        for (const ev of events) yield ev
        if (opts.hang) {
          await new Promise<void>((_, reject) =>
            signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
          )
        }
      },
    }))
    attachMock.mockImplementation(() => ({ cancel: sessionCancelMock, stream: streamMock }) as never)
    return streamMock
  }

  it('re-attaches by id from fromIndex, creates nothing, and returns pending (no settle) when the budget runs out', async () => {
    const { supabase, updates } = makeSupabase({ status: 'running', sandboxId: `${EVE_SANDBOX_PREFIX}sess-a` })
    mockAttachStream([messageAppended('a'), actionsRequested('bash'), messageAppended('b')], { hang: true })

    const res = await runAgentViaEve({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
      sessionId: 'sess-a',
      fromIndex: 17,
      budgetMs: 20,
    })

    expect(createTaskSessionMock).not.toHaveBeenCalled()
    expect(attachMock).toHaveBeenCalledWith('sess-a', { streamIndex: 17 })
    expect(res).toMatchObject({ settled: null, sessionId: 'sess-a', pending: { nextIndex: 20 } })
    expect(updates.filter((u) => u.patch.status === 'failed' || u.patch.status === 'canceled')).toHaveLength(0)
    // The tail is still flushed before handing off.
    expect(updates.some((u) => 'log_tail' in u.patch)).toBe(true)
  })

  it('a re-attached watch whose stream ends reconciles exactly like before (agent died → failed)', async () => {
    const { supabase, updates } = makeSupabase({ status: 'running', sandboxId: `${EVE_SANDBOX_PREFIX}sess-a` })
    mockAttachStream([messageAppended('done?'), sessionCompleted()])

    const res = await runAgentViaEve({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
      sessionId: 'sess-a',
      fromIndex: 0,
      budgetMs: 60_000,
    })

    expect(res.pending).toBeUndefined()
    expect(res.settled).toBe('failed')
    expect(updates.find((u) => u.patch.status === 'failed')).toBeTruthy()
  })

  // The durable session stream does NOT close at a terminal event (the fake
  // hangs after its events, as the real follow stream does). A 2s budget keeps a
  // regression cheap: without the boundary break the watch returns `pending`.
  const reattach = (supabase: unknown) =>
    runAgentViaEve({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: supabase as never,
      sessionId: 'sess-a',
      fromIndex: 5,
      budgetMs: 2_000,
    })
  const sessionFailed = () =>
    ({ type: 'session.failed', data: { code: 'X', message: 'boom', sessionId: 'sess-a' } }) as unknown as HandleMessageStreamEvent
  const sessionWaiting = () =>
    ({ type: 'session.waiting', data: { wait: 'next-user-message' } }) as unknown as HandleMessageStreamEvent

  it.each([
    ['session.completed', sessionCompleted],
    ['session.failed', sessionFailed],
  ])('a re-attached watch ends at %s without waiting out the budget, and settles the row', async (_name, terminal) => {
    const { supabase, updates } = makeSupabase({ status: 'running', sandboxId: `${EVE_SANDBOX_PREFIX}sess-a` })
    mockAttachStream([messageAppended('last words'), terminal()], { hang: true })

    const started = Date.now()
    const res = await reattach(supabase)

    expect(Date.now() - started).toBeLessThan(1_500)
    expect(res.pending).toBeUndefined()
    // Non-terminal row at the boundary → the same reconcile as the first attach.
    expect(res.settled).toBe('failed')
    expect(updates.find((u) => u.patch.status === 'failed')?.patch.error_message).toBe('agent ended without reporting an outcome')
    expect(updates.some((u) => String(u.patch.log_tail ?? '').includes('last words'))).toBe(true)
  })

  it.each([
    ['session.completed', sessionCompleted],
    ['session.failed', sessionFailed],
  ])('ends at %s and leaves an outcome-route-settled row alone', async (_name, terminal) => {
    const { supabase, updates } = makeSupabase({ status: 'running', statusAtRead: { at: 1, status: 'pr_open' } })
    mockAttachStream([terminal()], { hang: true })

    const res = await reattach(supabase)

    expect(res).toMatchObject({ settled: null, sessionId: 'sess-a' })
    expect(res.pending).toBeUndefined()
    expect(updates.filter((u) => u.patch.status === 'failed' || u.patch.status === 'canceled')).toHaveLength(0)
  })

  it('mirrors the first attach on session.waiting: ends it, unless a webhook authorization is still pending', async () => {
    const ended = makeSupabase({ status: 'running' })
    mockAttachStream([sessionWaiting()], { hang: true })
    const endedRes = await reattach(ended.supabase)
    expect(endedRes.pending).toBeUndefined()
    expect(endedRes.settled).toBe('failed')

    const parked = makeSupabase({ status: 'running' })
    const authRequired = {
      type: 'authorization.required',
      data: { name: 'github', webhookUrl: 'https://hook', sequence: 0, stepIndex: 0, turnId: 't', description: 'd' },
    } as unknown as HandleMessageStreamEvent
    mockAttachStream([authRequired, sessionWaiting()], { hang: true })
    const parkedRes = await runAgentViaEve({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      supabase: parked.supabase as never,
      sessionId: 'sess-a',
      fromIndex: 0,
      budgetMs: 30,
    })
    expect(parkedRes).toMatchObject({ settled: null, pending: { nextIndex: 2 } })
  })
})
