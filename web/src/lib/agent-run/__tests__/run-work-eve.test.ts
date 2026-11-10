/**
 * Turn-boundary classifier tests for the interactive eve work-agent runtime
 * (Loops v3 Phase 3 — docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md; extends
 * Phases 1-2, WORK-PROPOSALS-DESIGN.md).
 *
 * runWorkViaEve flips the run running (+ action 'working'), creates a durable eve
 * CONVERSATION session with the JSON brief, drains the first turn, reads the
 * advanced session snapshot, and classifies the turn into one of five cases.
 * resumeWorkRun does the fresh-process resume of a parked run. The suite pins the
 * classifier branches (conversation-session, the token module, notifications, and
 * log-tail all mocked so the suite is independent of the network + parallel
 * workstreams):
 *
 *   - flip: queued→running + action agent_run_status='working' up front; brief is
 *     the JSON first message via createConversationSession with an abort signal;
 *   - CASE 2 (settled-then-park): outcome route already settled terminal
 *     (finish_work) → watcher no-ops BUT persists session_state (the follow-up
 *     handle) from the advanced snapshot;
 *   - CASE 1 (question park): a request_user_input input.requested → CAS
 *     running→needs_input, pending_input persisted (with the request's approve/deny
 *     option ids + questions), session_state persisted, action → needs_input, a
 *     work_run_input notification filed;
 *   - CASE 3 (bare park): stream ends non-terminal with no question → settles
 *     'failed' AND persists session_state (a failed run is interrogable);
 *   - CASE 5 (cancel): row flips to 'canceling' mid-stream → aborts + settles
 *     'canceled' (action back to 'idle', pending_input cleared);
 *   - resume: mints a fresh token, resumes by ANSWERING the approval (approve
 *     optionId; eve 0.31.0 made respond/send exclusive, so the answer text rides on
 *     the response's `text` + clientContext rather than a companion message),
 *     clears pending_input, drives the classifier; a canceled parked run's resume
 *     no-ops; and a LEGACY session_state (a pre-0.31 continuationToken) is treated
 *     as non-resumable and settles failed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'
// A REAL request_user_input park + resume recorded against eve 0.66.3 on the
// work-agent (see the fixture's _source).
import recordedWorkHitl from './fixtures/eve-0.66.3-work-agent-request-user-input.json'

const SECRET = 'test-work-run-secret-abcdefghij0'

const h = vi.hoisted(() => {
  const createConversationSessionMock = vi.fn()
  const resumeConversationSessionMock = vi.fn()
  const readSessionSnapshotMock = vi.fn()
  const ClientMock = vi.fn(() => ({ /* opaque handle */ }))
  const appendAgentRunLogMock = vi.fn(async () => ({ canceling: false }))
  const readAgentRunCancelingMock = vi.fn(async () => false)
  const createNotificationMock = vi.fn(async (_params: unknown) => {})
  return {
    createConversationSessionMock,
    resumeConversationSessionMock,
    readSessionSnapshotMock,
    ClientMock,
    appendAgentRunLogMock,
    readAgentRunCancelingMock,
    createNotificationMock,
  }
})
const {
  createConversationSessionMock,
  resumeConversationSessionMock,
  readSessionSnapshotMock,
  ClientMock,
  appendAgentRunLogMock,
  readAgentRunCancelingMock,
  createNotificationMock,
} = h

// Only the Client is faked; isCurrentTurnBoundaryEvent (the attached-stream
// boundary rule watchWorkEveSession stops on) is the REAL one.
vi.mock('eve/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('eve/client')>()),
  Client: h.ClientMock,
}))
// Only the three I/O-bound helpers are mocked. parseConversationSnapshot and
// isLegacySessionState are pure blob validators — the REAL ones are used, so these
// tests exercise the actual legacy-degradation rule rather than a restatement of it.
vi.mock('@/lib/eve/conversation-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/eve/conversation-session')>()
  return {
    ...actual,
    createConversationSession: h.createConversationSessionMock,
    resumeConversationSession: h.resumeConversationSessionMock,
    readSessionSnapshot: h.readSessionSnapshotMock,
  }
})
vi.mock('../agent-run-token', () => ({
  mintAgentRunToken: vi.fn(() => 'signed.token'),
  internalSecret: vi.fn(() => SECRET),
  AGENT_RUN_SECRET_HEADER: 'x-agent-run-secret',
  AGENT_RUN_TOKEN_HEADER: 'x-agent-run-token',
  AGENT_RUN_WORKSPACE_HEADER: 'x-agent-run-workspace',
  AGENT_RUN_USER_HEADER: 'x-agent-run-user',
}))
vi.mock('../run-agent-eve', () => ({
  EVE_SANDBOX_PREFIX: 'eve:',
  // The row stamp (shared with the coding watcher) — a CAS write + supersede
  // cancel; here it just reports the stamp took.
  stampEveSession: vi.fn(async () => true),
}))
vi.mock('../log-tail', () => ({
  appendAgentRunLog: h.appendAgentRunLogMock,
  readAgentRunCanceling: h.readAgentRunCancelingMock,
}))
vi.mock('@/lib/notifications', () => ({ createNotification: h.createNotificationMock }))
// Usage logging is its own module (work-run-usage.test.ts); here only its wiring.
const logWorkRunUsageMock = vi.hoisted(() => vi.fn(async (_supabase: unknown, _args: unknown) => 0))
vi.mock('../work-run-usage', () => ({ logWorkRunUsage: logWorkRunUsageMock }))

import {
  runWorkViaEve,
  resumeWorkRun,
  startWorkEveSession,
  watchWorkEveSession,
  resumeWorkEveSession,
  type WorkRunBrief,
} from '../run-work-eve'
import { stampEveSession } from '../run-agent-eve'
import { internalSecret, mintAgentRunToken } from '../agent-run-token'
import { resetAgentRunMirrorCaches } from '@/lib/work/agent-run-mirror'

// The mirror caches ledger handles per run id across a process; each test
// builds its own fake, so a handle must never outlive the test that made it.
beforeEach(() => {
  resetAgentRunMirrorCaches()
})

// ── Event builders ────────────────────────────────────────────────────────────

function messageAppended(delta: string): HandleMessageStreamEvent {
  return {
    type: 'message.appended',
    data: { messageDelta: delta, sequence: 0, stepIndex: 0, turnId: 't' },
  } as HandleMessageStreamEvent
}
function sessionCompleted(): HandleMessageStreamEvent {
  return { type: 'session.completed' } as HandleMessageStreamEvent
}
function sessionWaiting(): HandleMessageStreamEvent {
  return { type: 'session.waiting', data: { wait: 'next-user-message' } } as HandleMessageStreamEvent
}
/** A request_user_input HITL pause (the question park) with approve/deny options. */
function inputRequested(): HandleMessageStreamEvent {
  return {
    type: 'input.requested',
    data: {
      requests: [
        {
          requestId: 'req-42',
          prompt: 'Pick an option',
          display: 'confirmation',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'deny', label: 'Deny' },
          ],
          action: {
            callId: 'call-1',
            kind: 'tool-call',
            toolName: 'request_user_input',
            input: {
              questions: [
                {
                  question: 'Which environment?',
                  header: 'Env',
                  options: [{ label: 'Staging' }, { label: 'Production' }],
                  multiSelect: false,
                },
              ],
            },
          },
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: 't',
    },
  } as unknown as HandleMessageStreamEvent
}

/** A request_user_input pause whose question text is EMPTY (normalizes to []). */
function inputRequestedEmpty(): HandleMessageStreamEvent {
  return {
    type: 'input.requested',
    data: {
      requests: [
        {
          requestId: 'req-empty',
          prompt: 'Pick an option',
          display: 'confirmation',
          options: [
            { id: 'approve', label: 'Approve' },
            { id: 'deny', label: 'Deny' },
          ],
          action: {
            callId: 'call-empty',
            kind: 'tool-call',
            toolName: 'request_user_input',
            // Blank question text → normalizeQuestions drops it → questions: [].
            input: { questions: [{ question: '', header: 'x', options: [], multiSelect: false }] },
          },
        },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: 't',
    },
  } as unknown as HandleMessageStreamEvent
}

const BRIEF: WorkRunBrief = {
  task: 'Draft a follow-up email to Randy about GA access.',
  userName: 'Liam',
  workspaceName: 'Native Intelligence',
  resources: [{ type: 'contact', id: 'con-9', label: 'Randy' }],
  deliverableHint: 'email_draft',
  trackedActionIdentifier: 'GEN-42',
}

/**
 * A stateful agent_run + actions stub. `row` is the mutable agent_run; `readN`
 * flips its status on the Nth *read* so a settle/cancel/park can land at a chosen
 * point. Supports the plain `.eq()` write, the flipToRunning CAS
 * `.eq().eq().eq().select('action_id').maybeSingle()`, the settle/park CAS
 * `.eq().eq().select('id')` (thenable), and reads via maybeSingle/single.
 */
function makeSupabase(init: {
  agentRun: Record<string, unknown>
  action?: Record<string, unknown> | null
  /** Flip agent_run.status on the Nth read (1-indexed). */
  statusAtRead?: { at: number; status: string }
  /** The run's work-ledger row, when the test wants the mirror to transition it. */
  ledgerRow?: Record<string, unknown> | null
}) {
  const row: Record<string, unknown> = {
    status: 'queued',
    action_id: 'action-1',
    attention_item_id: null,
    triggered_by: 'user-1',
    log_tail: null,
    sandbox_id: null,
    session_state: null,
    pending_input: null,
    kind: 'workspace',
    ...init.agentRun,
  }
  const actionRow: Record<string, unknown> | null =
    init.action === undefined ? { id: 'action-1', title: 'Follow up with Randy', team_id: null } : init.action
  const memberRow = { id: 'member-1' }

  let agentReads = 0
  const updates: Array<{ table: string; patch: Record<string, unknown> }> = []

  function agentRunChain() {
    const read = () => {
      agentReads += 1
      if (init.statusAtRead && agentReads >= init.statusAtRead.at) {
        row.status = init.statusAtRead.status
      }
      return Promise.resolve({ data: { ...row }, error: null })
    }
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: read,
      single: read,
      update: (patch: Record<string, unknown>) => {
        // Honor the CAS predicate: a write chain filtered by `.eq('status', X)`
        // only takes when the row's CURRENT status (before applying the patch)
        // equals X. This lets the queued→running / needs_input CAS guards behave
        // like the real DB (a stale/canceled row's CAS misses → no rows).
        const statusBeforePatch = row.status
        let casStatus: string | undefined
        const commit = () => {
          if (casStatus !== undefined && casStatus !== statusBeforePatch) return false
          updates.push({ table: 'agent_run', patch })
          Object.assign(row, patch)
          return true
        }
        const withSelect: Record<string, unknown> = {
          eq: (col: string, val: unknown) => {
            if (col === 'status' && typeof val === 'string') casStatus = val
            return withSelect
          },
          select: () => withSelect,
          maybeSingle: () => {
            const took = commit()
            return Promise.resolve({
              data: took ? { action_id: row.action_id } : null,
              error: null,
            })
          },
          then: (r: (x: unknown) => unknown) => {
            const took = commit()
            return Promise.resolve({ data: took ? [{ id: 'work-run-1' }] : [], error: null }).then(r)
          },
        }
        return withSelect
      },
    }
    return chain
  }
  function actionsChain() {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data: actionRow, error: null }),
      update: (patch: Record<string, unknown>) => {
        updates.push({ table: 'actions', patch })
        return {
          eq: () => Promise.resolve({ error: null }),
        }
      },
    }
    return chain
  }
  function memberChain() {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data: memberRow, error: null }),
    }
    return chain
  }
  function attentionChain() {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
    }
    return chain
  }
  // The work ledger's lookup (`findWork`: select → eq → order → limit →
  // maybeSingle) and the recorder's CAS writes. Without a `ledgerRow` the
  // mirror is a no-op; with one, transitions land on it and are recorded.
  const ledgerRow = init.ledgerRow ?? null
  function ledgerChain() {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      order: () => chain,
      limit: () => chain,
      maybeSingle: () => Promise.resolve({ data: ledgerRow ? { ...ledgerRow } : null, error: null }),
      update: (patch: Record<string, unknown>) => {
        if (ledgerRow) Object.assign(ledgerRow, patch)
        updates.push({ table: 'tracked_job', patch })
        const w: Record<string, unknown> = {
          eq: () => w,
          in: () => w,
          select: () => w,
          maybeSingle: () => Promise.resolve({ data: ledgerRow ? { id: ledgerRow.id } : null, error: null }),
          then: (r: (x: unknown) => unknown) =>
            Promise.resolve({ data: ledgerRow ? [{ id: ledgerRow.id }] : [], error: null }).then(r),
        }
        return w
      },
    }
    return chain
  }

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'actions') return actionsChain()
      if (table === 'member') return memberChain()
      if (table === 'attention_item') return attentionChain()
      if (table === 'tracked_job') return ledgerChain()
      return agentRunChain()
    }),
  }
  return { supabase, updates, getRow: () => row }
}

/** Wire createConversationSession to yield `events` then return a session whose
 *  snapshot readSessionSnapshot reports as `snapshot`. */
function mockCreate(events: HandleMessageStreamEvent[], snapshot: { sessionId: string; streamIndex: number } | null, sessionId = 'sess-work-1') {
  createConversationSessionMock.mockImplementation((_client: unknown, input: { signal?: AbortSignal }) => {
    const signal = input?.signal
    async function* gen() {
      for (const ev of events) {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        yield ev
      }
    }
    const session = { id: sessionId }
    const response = { [Symbol.asyncIterator]: () => gen()[Symbol.asyncIterator]() }
    return Promise.resolve({ sessionId, session, response })
  })
  readSessionSnapshotMock.mockReturnValue(snapshot)
}

/**
 * Wire createConversationSession so the returned session exposes a `.respond()`
 * (the empty-ask self-heal re-drives the SAME session by ANSWERING the dead
 * approval). eve 0.31.0 made respond() and send() exclusive and positional — a
 * turn carrying inputResponses goes through respond(inputResponses, options) and
 * its `message` would be dropped by the route, so the guidance travels on the
 * response's `text` plus `clientContext`.
 *
 * `firstEvents` is the create turn; each subsequent `.respond()` yields the NEXT
 * array from `laterTurns` in order. `respondCalls` records `{ inputResponses,
 * options }` for assertions.
 */
function mockCreateWithRespond(
  firstEvents: HandleMessageStreamEvent[],
  laterTurns: HandleMessageStreamEvent[][],
  snapshot: { sessionId: string; streamIndex: number } | null,
  sessionId = 'sess-work-1',
) {
  const respondCalls: Array<{ inputResponses: unknown; options: Record<string, unknown> }> = []
  let turnIdx = 0
  function responseFor(events: HandleMessageStreamEvent[]) {
    async function* gen() {
      for (const ev of events) yield ev
    }
    return { [Symbol.asyncIterator]: () => gen()[Symbol.asyncIterator]() }
  }
  const session = {
    id: sessionId,
    respond: vi.fn((inputResponses: unknown, options: Record<string, unknown> = {}) => {
      respondCalls.push({ inputResponses, options })
      const events = laterTurns[turnIdx] ?? []
      turnIdx += 1
      return Promise.resolve(responseFor(events))
    }),
  }
  createConversationSessionMock.mockImplementation(() => {
    return Promise.resolve({ sessionId, session, response: responseFor(firstEvents) })
  })
  readSessionSnapshotMock.mockReturnValue(snapshot)
  return { respondCalls, session }
}

function runDispatch(supabase: unknown) {
  return runWorkViaEve({
    agentRunId: 'run-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    brief: BRIEF,
    supabase: supabase as never,
  })
}

describe('runWorkViaEve — turn-boundary classifier', () => {
  beforeEach(() => {
    createConversationSessionMock.mockReset()
    resumeConversationSessionMock.mockReset()
    readSessionSnapshotMock.mockReset()
    appendAgentRunLogMock.mockReset()
    appendAgentRunLogMock.mockResolvedValue({ canceling: false })
    readAgentRunCancelingMock.mockReset()
    readAgentRunCancelingMock.mockResolvedValue(false)
    createNotificationMock.mockReset()
    ClientMock.mockClear()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })
  afterEach(() => {
    vi.clearAllMocks()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })

  describe('dispatch origin (eveDispatchOrigin): THIS deployment, never production from a preview', () => {
    afterEach(() => vi.unstubAllEnvs())

    async function clientOptsFor() {
      const { supabase } = makeSupabase({ agentRun: { status: 'queued' }, statusAtRead: { at: 2, status: 'completed' } })
      mockCreate([messageAppended('working'), sessionCompleted()], { sessionId: 'sess-work-1', streamIndex: 5 })
      await runDispatch(supabase)
      return (ClientMock.mock.calls[0] as unknown[])[0] as { host: string; headers: Record<string, string> }
    }

    it('on Vercel: https://VERCEL_URL even when NEXT_PUBLIC_APP_URL is production, plus the protection bypass', async () => {
      vi.stubEnv('VERCEL_URL', 'dial8-git-feature.vercel.app')
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev')
      vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 'bypass-123')
      const opts = await clientOptsFor()
      expect(opts.host).toBe('https://dial8-git-feature.vercel.app/eve/work-agent')
      expect(opts.headers['x-vercel-protection-bypass']).toBe('bypass-123')
    })

    it('off Vercel: NEXT_PUBLIC_APP_URL, and no bypass header without the secret', async () => {
      vi.stubEnv('VERCEL_URL', '')
      vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://staging.example')
      vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', '')
      const opts = await clientOptsFor()
      expect(opts.host).toBe('https://staging.example/eve/work-agent')
      expect(opts.headers).not.toHaveProperty('x-vercel-protection-bypass')
    })
  })

  it('flips running + action working, creates a CONVERSATION session with the JSON brief', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: { status: 'queued' },
      statusAtRead: { at: 2, status: 'completed' },
    })
    mockCreate([messageAppended('working'), sessionCompleted()], { sessionId: 'sess-work-1', streamIndex: 5 })

    const res = await runDispatch(supabase)
    expect(res.sessionId).toBe('sess-work-1')
    expect(res.settled).toBeNull() // outcome route already settled (completed)

    const runningWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'running')
    expect(runningWrite).toBeDefined()
    expect(runningWrite!.patch.started_at).toBeTruthy()
    const workingWrite = updates.find((u) => u.table === 'actions' && u.patch.agent_run_status === 'working')
    expect(workingWrite).toBeDefined()

    expect(createConversationSessionMock).toHaveBeenCalledTimes(1)
    const [clientArg, payload] = createConversationSessionMock.mock.calls[0]
    expect(clientArg).toBe(ClientMock.mock.results[0].value)
    const parsed = JSON.parse(payload.message)
    expect(parsed.task).toBe(BRIEF.task)
    expect(parsed.trackedActionIdentifier).toBe('GEN-42')
    expect(payload.signal).toBeInstanceOf(AbortSignal)

    const clientOpts = (ClientMock.mock.calls[0] as unknown[])[0] as { host: string; redirect: string }
    // eve 0.58+ mounts named agents at /eve/<name>/v1/* (the pre-0.58
    // /eve/agents/<name>/eve/v1/* shape now 404s).
    expect(new URL(clientOpts.host).pathname).toBe('/eve/work-agent')
    expect(clientOpts.redirect).toBe('error')
  })

  it('CASE 2 settled-then-park: finish_work settled terminal → no-op BUT persists session_state', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: { status: 'running' },
      statusAtRead: { at: 1, status: 'completed' }, // finish_work settled it during the turn
    })
    mockCreate([messageAppended('done the work'), sessionWaiting()], { sessionId: 'sess-work-1', streamIndex: 12 })

    const res = await runDispatch(supabase)
    expect(res.settled).toBeNull() // outcome route owns the terminal state

    // The follow-up handle IS persisted from the advanced snapshot — the feature.
    const stateWrite = updates.find(
      (u) => u.table === 'agent_run' && u.patch.session_state !== undefined,
    )
    expect(stateWrite).toBeDefined()
    // A terminal park STAMPS the frozen follow-up-transcript boundary (settleStreamIndex)
    // once, from the advancing streamIndex. GET replay reads from it.
    expect(stateWrite!.patch.session_state).toEqual({
      sessionId: 'sess-work-1',
      streamIndex: 12,
      settleStreamIndex: 12,
    })
    // It did NOT rewrite the terminal status.
    const clobber = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'failed')
    expect(clobber).toBeUndefined()
  })

  it('logs the drained turn’s usage from the dispatcher (source dispatch), with every event it read', async () => {
    const { supabase } = makeSupabase({
      agentRun: { status: 'running' },
      statusAtRead: { at: 1, status: 'completed' },
    })
    const turn = [messageAppended('done the work'), sessionWaiting()]
    mockCreate(turn, { sessionId: 'sess-work-1', streamIndex: 12 })
    logWorkRunUsageMock.mockClear()

    await runDispatch(supabase)
    expect(logWorkRunUsageMock).toHaveBeenCalledTimes(1)
    expect(logWorkRunUsageMock).toHaveBeenCalledWith(supabase, {
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      events: turn,
      source: 'dispatch',
    })
  })

  it('CASE 1 question park: request_user_input → needs_input + pending_input + notification', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: { status: 'running' },
      // status stays 'running' across reads (no settle) so the park CAS wins.
      ledgerRow: {
        id: 'job-1',
        workspace_id: 'ws-1',
        member_id: 'member-1',
        kind: 'work_run',
        title: 'Follow up with Randy',
        status: 'running',
        agent_run_id: 'run-1',
        progress: {},
        source: {},
      },
    })
    mockCreate([messageAppended('let me ask'), inputRequested(), sessionWaiting()], {
      sessionId: 'sess-work-1',
      streamIndex: 7,
    })

    const res = await runDispatch(supabase)
    expect(res.settled).toBe('needs_input')

    const parkWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'needs_input')
    expect(parkWrite).toBeDefined()
    // pending_input carries the request's option ids + the questions.
    const pending = parkWrite!.patch.pending_input as Record<string, unknown>
    expect(pending.requestId).toBe('req-42')
    expect(pending.approveOptionId).toBe('approve')
    expect(pending.denyOptionId).toBe('deny')
    expect((pending.questions as unknown[])).toHaveLength(1)
    expect((pending.questions as Array<{ question: string }>)[0].question).toBe('Which environment?')
    // session_state persisted at the park.
    expect(parkWrite!.patch.session_state).toEqual({ sessionId: 'sess-work-1', streamIndex: 7 })

    // Action mirrored to needs_input.
    const actionWrite = updates.find((u) => u.table === 'actions' && u.patch.agent_run_status === 'needs_input')
    expect(actionWrite).toBeDefined()

    // The ledger row parked with the question — and THAT transition is the one
    // "needs your input" push, targeting the work item (not a second producer).
    const ledgerPark = updates.find((u) => u.table === 'tracked_job' && u.patch.status === 'needs_input')
    expect(ledgerPark).toBeDefined()
    expect(createNotificationMock).toHaveBeenCalledTimes(1)
    const notif = createNotificationMock.mock.calls[0][0] as Record<string, unknown>
    expect(notif.type).toBe('work_needs_you')
    expect(notif.targetType).toBe('work_item')
    expect(notif.targetId).toBe('job-1')
    expect(notif.title).toBe('Follow up with Randy — needs your answer')
    expect(notif.body).toContain('Which environment?')
  })

  it('CASE 1 on a RECORDED eve 0.66.3 work-agent park: the real request_user_input stream classifies as a question park (not a bare park)', async () => {
    const park = recordedWorkHitl.park as unknown as HandleMessageStreamEvent[]
    const recordedRequest = (park.find((e) => e.type === 'input.requested') as unknown as {
      data: { requests: Array<{ requestId: string; kind: string; options: Array<{ id: string }>; action: { toolName: string } }> }
    }).data.requests[0]
    // The live 0.66.3 shape the classifier keys on.
    expect(recordedRequest.action.toolName).toBe('request_user_input')
    expect(recordedRequest.kind).toBe('tool-approval')
    expect(recordedRequest.options.map((o) => o.id)).toEqual(['approve', 'cancel'])
    // eve emitted turn.completed on the PARKED turn — the classifier must still see the park.
    expect(park.some((e) => e.type === 'turn.completed')).toBe(true)

    const { supabase, updates } = makeSupabase({ agentRun: { status: 'running' } })
    mockCreate(park, { sessionId: 'wrun_01M3B4PW5JPPX1F7HGBGJKA3X7', streamIndex: 189 })

    const res = await runDispatch(supabase)
    expect(res.settled).toBe('needs_input')
    const parkWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'needs_input')
    expect(parkWrite).toBeDefined()
    const pending = parkWrite!.patch.pending_input as {
      requestId: string
      approveOptionId: string
      denyOptionId: string
      questions: Array<{ question: string; header: string; options: Array<{ label: string }> }>
    }
    expect(pending.requestId).toBe(recordedRequest.requestId)
    expect(pending.approveOptionId).toBe('approve')
    expect(pending.denyOptionId).toBe('cancel')
    expect(pending.questions).toHaveLength(1)
    expect(pending.questions[0].question).toBe('Which environment should I target?')
    expect(pending.questions[0].options.map((o) => o.label)).toEqual(['Staging', 'Production'])
    // Never classified as a bare park (CASE 3 → failed).
    expect(updates.some((u) => u.table === 'agent_run' && u.patch.status === 'failed')).toBe(false)
  })

  it('CASE 3 bare park: stream ends non-terminal, no question → failed AND persists session_state', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: { status: 'running' }, // stays running (agent stopped without finish_work)
    })
    mockCreate([messageAppended('did some stuff'), sessionWaiting()], {
      sessionId: 'sess-work-1',
      streamIndex: 3,
    })

    const res = await runDispatch(supabase)
    expect(res.settled).toBe('failed')
    const failWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'failed')
    expect(failWrite).toBeDefined()
    expect(failWrite!.patch.error_message).toBe('agent ended without reporting an outcome')
    // A failed run's session stays interrogable — session_state persisted, and a
    // failed run is TERMINAL so it STAMPS the frozen settleStreamIndex boundary.
    expect(failWrite!.patch.session_state).toEqual({
      sessionId: 'sess-work-1',
      streamIndex: 3,
      settleStreamIndex: 3,
    })
    // pending_input cleared (no open question on a failed run).
    expect(failWrite!.patch.pending_input).toBeNull()
    const actionFail = updates.find((u) => u.table === 'actions' && u.patch.agent_run_status === 'failed')
    expect(actionFail).toBeDefined()
  })

  it("a session eve failed before its first model call (no spec) settles failed with eve's reason", async () => {
    const { supabase, updates } = makeSupabase({ agentRun: { status: 'running' } })
    // What eve streams when the work-agent's model resolver refuses to run
    // without its spec: MODEL_SELECTION_FAILED on the step, the turn and the
    // session, and no model step.
    const reason = '[work-agent] no run spec for this session (its prompt and tools could not be loaded) — refusing to run the work blind'
    const failed = (type: string) =>
      ({ type, data: { code: 'MODEL_SELECTION_FAILED', message: reason, sequence: 0, stepIndex: 0, turnId: 't' } }) as unknown as HandleMessageStreamEvent
    mockCreate([failed('step.failed'), failed('turn.failed'), failed('session.failed')], {
      sessionId: 'sess-work-1',
      streamIndex: 3,
    })

    const res = await runDispatch(supabase)
    expect(res.settled).toBe('failed')
    const failWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'failed')
    expect(failWrite!.patch.error_message).toBe(`agent session failed: ${reason}`)
    expect(updates.find((u) => u.table === 'actions' && u.patch.agent_run_status === 'failed')).toBeDefined()
  })

  it('CASE 5 cancel: canceling mid-stream → aborts + settles canceled (action idle, pending cleared)', async () => {
    const { supabase, updates } = makeSupabase({ agentRun: { status: 'running' } })
    // The log-append path detects the canceling row (mirrors the real
    // appendAgentRunLog returning canceling when the row flipped to 'canceling').
    appendAgentRunLogMock.mockResolvedValue({ canceling: true })
    mockCreate([messageAppended('a'.repeat(1000)), messageAppended('more'), sessionWaiting()], {
      sessionId: 'sess-work-1',
      streamIndex: 1,
    })

    const res = await runDispatch(supabase)
    expect(res.settled).toBe('canceled')
    const cancelWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'canceled')
    expect(cancelWrite).toBeDefined()
    expect(cancelWrite!.patch.error_message).toBe('Canceled by user')
    expect(cancelWrite!.patch.pending_input).toBeNull()
    const actionIdle = updates.find((u) => u.table === 'actions' && u.patch.agent_run_status === 'idle')
    expect(actionIdle).toBeDefined()
  })

  it('EMPTY-ASK self-heal: a request_user_input with no renderable questions is DENIED in-place and the session re-driven, not parked', async () => {
    const { supabase, updates } = makeSupabase({ agentRun: { status: 'running' } })
    // First turn: an empty ask (questions normalize to []). Self-heal turn: the
    // agent proceeds and finish_work settles the run terminal.
    const { respondCalls } = mockCreateWithRespond(
      [messageAppended('let me ask'), inputRequestedEmpty(), sessionWaiting()],
      [[messageAppended('ok, proceeding'), sessionWaiting()]],
      { sessionId: 'sess-work-1', streamIndex: 9 },
    )
    // The self-heal turn ends non-terminal with no question → bare park → failed.
    // We assert the run did NOT park needs_input and DID deny the empty ask.
    const res = await runDispatch(supabase)

    // The empty ask was NOT parked as needs_input (that would be a dead picker).
    const parkWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'needs_input')
    expect(parkWrite).toBeUndefined()

    // Exactly one self-heal RESPOND: deny optionId + the guidance, which now rides
    // on the response's `text` and as one-turn clientContext (a respond drops
    // `message`), never as a second send.
    expect(respondCalls).toHaveLength(1)
    const responses = respondCalls[0].inputResponses as Array<Record<string, unknown>>
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({ requestId: 'req-empty', optionId: 'deny' })
    expect(String(responses[0].text)).toMatch(/empty|unreadable|best judgment/i)
    expect(String(respondCalls[0].options.clientContext)).toMatch(/empty|unreadable|best judgment/i)

    // Self-heal is allowed once → the run doesn't loop or park; it settles (here the
    // second turn ended non-terminal with no question → bare park → failed).
    expect(res.settled).toBe('failed')
  })

  it('a run that may not ask (a server-started helper, migration 337) never parks: its question is answered in place, once', async () => {
    const { supabase, updates } = makeSupabase({ agentRun: { status: 'running', server_helper: 'meeting_prep' } })
    const { respondCalls } = mockCreateWithRespond(
      [messageAppended('let me ask'), inputRequested(), sessionWaiting()],
      [[inputRequested(), sessionWaiting()]],
      { sessionId: 'sess-work-1', streamIndex: 9 },
    )
    const res = await runDispatch(supabase)
    expect(updates.find((u) => u.table === 'agent_run' && u.patch.status === 'needs_input')).toBeUndefined()
    expect(respondCalls).toHaveLength(1)
    const responses = respondCalls[0].inputResponses as Array<Record<string, unknown>>
    expect(responses[0]).toMatchObject({ requestId: 'req-42', optionId: 'deny' })
    expect(String(responses[0].text)).toMatch(/Nobody can answer/)
    // It asked again: failed, never parked on the question.
    expect(res.settled).toBe('failed')
    const failWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'failed')
    expect(String(failWrite!.patch.error_message)).toMatch(/nobody can answer/i)
  })

  it('EMPTY-ASK self-heal fires at most ONCE: a second empty ask settles the run failed', async () => {
    const { supabase, updates } = makeSupabase({ agentRun: { status: 'running' } })
    // First turn empty ask → self-heal → the agent asks ANOTHER empty question.
    const { respondCalls } = mockCreateWithRespond(
      [inputRequestedEmpty(), sessionWaiting()],
      [[inputRequestedEmpty(), sessionWaiting()]],
      { sessionId: 'sess-work-1', streamIndex: 4 },
    )

    const res = await runDispatch(supabase)

    // Only ONE self-heal respond (the second empty ask stops, doesn't re-deny).
    expect(respondCalls).toHaveLength(1)
    // The run is settled failed, never parked on the dead question.
    expect(res.settled).toBe('failed')
    const parkWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'needs_input')
    expect(parkWrite).toBeUndefined()
    const failWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'failed')
    expect(failWrite).toBeDefined()
    expect(String(failWrite!.patch.error_message)).toMatch(/empty question/i)
  })

  it('preserves settleStreamIndex across a later persist (frozen boundary never re-derives)', async () => {
    // A run whose session_state already carries a stamped settleStreamIndex; a
    // subsequent terminal persist must PRESERVE it, not re-stamp from the new index.
    const { supabase, updates } = makeSupabase({
      agentRun: {
        status: 'running',
        session_state: { sessionId: 'sess-work-1', streamIndex: 12, settleStreamIndex: 12 },
      },
      statusAtRead: { at: 1, status: 'completed' }, // case 2 persist
    })
    mockCreate([messageAppended('follow-up turn'), sessionWaiting()], {
      sessionId: 'sess-work-1',
      streamIndex: 30,
    })

    await runDispatch(supabase)
    const stateWrite = updates.find(
      (u) => u.table === 'agent_run' && u.patch.session_state !== undefined,
    )
    expect(stateWrite).toBeDefined()
    // streamIndex ADVANCES, but settleStreamIndex stays FROZEN at 12.
    expect(stateWrite!.patch.session_state).toEqual({
      sessionId: 'sess-work-1',
      streamIndex: 30,
      settleStreamIndex: 12,
    })
  })

  it('throws when the internal secret is unset (guard before flip/mint)', async () => {
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null)
    const { supabase } = makeSupabase({ agentRun: { status: 'queued' } })
    await expect(runDispatch(supabase)).rejects.toThrow(/AGENT_RUN_INTERNAL_SECRET/)
  })
})

describe('resumeWorkRun — resume driver', () => {
  beforeEach(() => {
    createConversationSessionMock.mockReset()
    resumeConversationSessionMock.mockReset()
    readSessionSnapshotMock.mockReset()
    appendAgentRunLogMock.mockReset()
    appendAgentRunLogMock.mockResolvedValue({ canceling: false })
    readAgentRunCancelingMock.mockReset()
    readAgentRunCancelingMock.mockResolvedValue(false)
    createNotificationMock.mockReset()
    ClientMock.mockClear()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  const PENDING = {
    requestId: 'req-42',
    approveOptionId: 'approve',
    denyOptionId: 'deny',
    questions: [{ question: 'Which environment?', header: 'Env', options: [], multiSelect: false }],
    askedAt: '2026-07-15T00:00:00.000Z',
  }

  function mockResume(events: HandleMessageStreamEvent[], snapshot: { sessionId: string; streamIndex: number } | null) {
    resumeConversationSessionMock.mockImplementation((_client: unknown, args: { signal?: AbortSignal }) => {
      const signal = args?.signal
      async function* gen() {
        for (const ev of events) {
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          yield ev
        }
      }
      const session = { id: 'sess-work-1' }
      const response = { [Symbol.asyncIterator]: () => gen()[Symbol.asyncIterator]() }
      return Promise.resolve({ session, response })
    })
    readSessionSnapshotMock.mockReturnValue(snapshot)
  }

  function resume(
    supabase: unknown,
    response: { answers?: Array<{ question: string; answer: string }>; skipped?: boolean },
    expectedRequestId?: string | null,
  ) {
    return resumeWorkRun({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      response,
      expectedRequestId,
      supabase: supabase as never,
    })
  }

  // The RECORDED 0.66.3 park → resume, driven through the app's own code: the
  // dispatcher parks on the recorded stream (writing pending_input), then
  // resumeWorkRun resumes from THAT pending_input and replays the recorded
  // resumed turn through its classifier. (The live recording sent the same
  // payload SHAPE — approve id + answer text on the respond — but its answer
  // wording was hand-written, not formatAnswers'; see the fixture _source.)
  async function parkOnRecording() {
    const park = recordedWorkHitl.park as unknown as HandleMessageStreamEvent[]
    const { supabase, updates } = makeSupabase({ agentRun: { status: 'running' } })
    mockCreate(park, { sessionId: 'wrun_01M3B4PW5JPPX1F7HGBGJKA3X7', streamIndex: 189 })
    const res = await runDispatch(supabase)
    expect(res.settled).toBe('needs_input')
    const parkWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'needs_input')!
    return {
      pending: parkWrite.patch.pending_input as typeof PENDING,
      sessionState: parkWrite.patch.session_state as { sessionId: string; streamIndex: number },
    }
  }
  const recordedResolution = () =>
    (
      (recordedWorkHitl.resumeBoundary as unknown as Array<{
        type: string
        data: { resolutions?: Array<{ requestId: string; outcome: string; response: { optionId: string; text?: string } }> }
      }>).find((e) => e.type === 'input.resolved')!.data.resolutions![0]
    )

  it.each([
    ['finish_work settled the row during the resumed turn', { at: 3, status: 'completed' }, null],
    ['finish_work was refused, as in the recording (no run token) → the run fails, never hangs', undefined, 'failed'],
  ] as const)('RECORDED 0.66.3 resume: resumeWorkRun answers the recorded park with the payload eve accepted, and the recorded resumed turn classifies (%s)', async (_label, statusAtRead, settled) => {
    const { pending, sessionState } = await parkOnRecording()
    const resolved = recordedResolution()

    const { supabase, updates } = makeSupabase({
      agentRun: {
        status: 'queued',
        sandbox_id: `eve:${sessionState.sessionId}`,
        session_state: sessionState,
        pending_input: pending,
      },
      ...(statusAtRead ? { statusAtRead } : {}),
    })
    mockResume(recordedWorkHitl.resumeBoundary as unknown as HandleMessageStreamEvent[], {
      sessionId: sessionState.sessionId,
      streamIndex: 260,
    })

    const res = await resume(
      supabase,
      { answers: [{ question: pending.questions[0].question, answer: 'Staging' }] },
      pending.requestId,
    )

    // The respond payload: exactly the inputResponses eve resolved in the recording…
    const args = resumeConversationSessionMock.mock.calls[0][1] as {
      sessionId: string
      payload: { message?: string; inputResponses?: Array<{ requestId: string; optionId?: string }> }
    }
    expect(args.sessionId).toBe(sessionState.sessionId)
    expect(args.payload.inputResponses).toEqual([{ requestId: resolved.requestId, optionId: resolved.response.optionId }])
    expect(resolved.outcome).toBe('approved')
    // …plus the answer on the text channel eve echoed back (resolved.response.text).
    expect(resolved.response.text).toContain('Staging')
    expect(args.payload.message).toContain('Which environment should I target?')
    expect(args.payload.message).toContain('Staging')

    expect(res.settled).toBe(settled)
    const failWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'failed')
    if (settled === 'failed') {
      expect(failWrite?.patch.error_message).toBe('agent ended without reporting an outcome')
    } else {
      expect(failWrite).toBeUndefined()
    }
  })

  it('resumes with the approval choreography (approve optionId + answers as message), then settles', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: {
        status: 'queued', // the respond route CAS'd needs_input→queued
        sandbox_id: 'eve:sess-work-1',
        session_state: { sessionId: 'sess-work-1', streamIndex: 7 },
        pending_input: PENDING,
      },
      statusAtRead: { at: 3, status: 'completed' }, // finish_work settles on the resumed turn
    })
    mockResume([messageAppended('finishing up'), sessionWaiting()], { sessionId: 'sess-work-1', streamIndex: 20 })

    const res = await resume(supabase, { answers: [{ question: 'Which environment?', answer: 'Staging' }] })
    expect(res.settled).toBeNull() // finish_work owns the terminal state

    // Flipped queued→running + cleared pending_input.
    const flip = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'running' && u.patch.pending_input === null)
    expect(flip).toBeDefined()
    // Action mirrored back to working.
    const actionWorking = updates.find((u) => u.table === 'actions' && u.patch.agent_run_status === 'working')
    expect(actionWorking).toBeDefined()

    // The resume send carried the approval choreography.
    expect(resumeConversationSessionMock).toHaveBeenCalledTimes(1)
    const args = resumeConversationSessionMock.mock.calls[0][1] as {
      sessionId: string
      snapshot: { sessionId: string; streamIndex: number }
      payload: { message?: string; inputResponses?: Array<{ requestId: string; optionId?: string }> }
    }
    expect(args.sessionId).toBe('sess-work-1')
    expect(args.snapshot).toEqual({ sessionId: 'sess-work-1', streamIndex: 7 })
    expect(args.payload.inputResponses).toEqual([{ requestId: 'req-42', optionId: 'approve' }])
    expect(args.payload.message).toContain('Which environment?')
    expect(args.payload.message).toContain('Staging')

    // A fresh token was minted for the resume.
    expect(ClientMock).toHaveBeenCalledTimes(1)
    const clientOpts = (ClientMock.mock.calls[0] as unknown[])[0] as { headers: Record<string, string> }
    expect(clientOpts.headers['x-agent-run-token']).toBe('signed.token')
  })

  it('skip: resumes with deny optionId + a "skipped" message', async () => {
    const { supabase } = makeSupabase({
      agentRun: {
        status: 'queued',
        sandbox_id: 'eve:sess-work-1',
        session_state: { sessionId: 'sess-work-1', streamIndex: 7 },
        pending_input: PENDING,
      },
      statusAtRead: { at: 3, status: 'completed' },
    })
    mockResume([messageAppended('ok proceeding'), sessionWaiting()], { sessionId: 'sess-work-1', streamIndex: 20 })

    await resume(supabase, { skipped: true })
    const args = resumeConversationSessionMock.mock.calls[0][1] as {
      payload: { message?: string; inputResponses?: Array<{ requestId: string; optionId?: string }> }
    }
    expect(args.payload.inputResponses).toEqual([{ requestId: 'req-42', optionId: 'deny' }])
    expect(args.payload.message?.toLowerCase()).toContain('skipped')
  })

  it('no-op when the run is no longer queued (canceled in the gap)', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: {
        status: 'canceled', // canceled between the respond CAS and this dispatch
        sandbox_id: 'eve:sess-work-1',
        session_state: { sessionId: 'sess-work-1', streamIndex: 7 },
        pending_input: PENDING,
      },
    })

    const res = await resume(supabase, { answers: [{ question: 'q', answer: 'a' }] })
    // The queued→running CAS finds no queued row → no resume send, no clobber.
    expect(resumeConversationSessionMock).not.toHaveBeenCalled()
    const clobber = updates.find((u) => u.table === 'agent_run' && (u.patch.status === 'running' || u.patch.status === 'failed'))
    expect(clobber).toBeUndefined()
    expect(res.settled).toBeNull()
  })

  it('request-identity guard: a resume whose expectedRequestId ≠ the run’s current pending requestId is a clean no-op (stale duplicate)', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: {
        status: 'queued', // queued for a LATER question (req-99)
        sandbox_id: 'eve:sess-work-1',
        session_state: { sessionId: 'sess-work-1', streamIndex: 7 },
        pending_input: { ...PENDING, requestId: 'req-99' },
      },
    })

    // A duplicate of an OLDER resume event (answered req-42) arrives while the run
    // is parked on req-99 → must NOT drive the resume, must NOT settle/CAS.
    const res = await resume(
      supabase,
      { answers: [{ question: 'q', answer: 'a' }] },
      'req-42',
    )

    expect(resumeConversationSessionMock).not.toHaveBeenCalled()
    // No queued→running flip, no failed settle — the row is left for the correct event.
    const flip = updates.find(
      (u) => u.table === 'agent_run' && (u.patch.status === 'running' || u.patch.status === 'failed'),
    )
    expect(flip).toBeUndefined()
    expect(res.settled).toBeNull()
  })

  it('request-identity guard: a matching expectedRequestId drives the resume normally', async () => {
    const { supabase } = makeSupabase({
      agentRun: {
        status: 'queued',
        sandbox_id: 'eve:sess-work-1',
        session_state: { sessionId: 'sess-work-1', streamIndex: 7 },
        pending_input: { ...PENDING, requestId: 'req-42' },
      },
      statusAtRead: { at: 3, status: 'completed' },
    })
    mockResume([messageAppended('finishing'), sessionWaiting()], { sessionId: 'sess-work-1', streamIndex: 20 })

    await resume(supabase, { answers: [{ question: 'Which environment?', answer: 'Staging' }] }, 'req-42')
    expect(resumeConversationSessionMock).toHaveBeenCalledTimes(1)
  })

  it('settles failed when there is no live session to resume', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: {
        status: 'queued',
        sandbox_id: null, // no eve session id
        session_state: null,
        pending_input: PENDING,
      },
    })

    const res = await resume(supabase, { answers: [{ question: 'q', answer: 'a' }] })
    expect(res.settled).toBe('failed')
    expect(resumeConversationSessionMock).not.toHaveBeenCalled()
    const failWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'failed')
    expect(failWrite).toBeDefined()
  })

  it('LEGACY session_state (a pre-eve-0.31 continuationToken) is NOT resumable and settles failed', async () => {
    // Continuation tokens were removed with no replacement — such a session can
    // never be re-addressed. The run must degrade into the existing settleFailed
    // path (never attempt a resume), with a reason that names the upgrade so the
    // failure is distinguishable from "this run never had a session".
    const { supabase, updates } = makeSupabase({
      agentRun: {
        status: 'queued',
        sandbox_id: 'eve:sess-work-1',
        session_state: { continuationToken: 'ct-from-before-the-upgrade', streamIndex: 7 },
        pending_input: PENDING,
      },
    })

    const res = await resume(supabase, { answers: [{ question: 'q', answer: 'a' }] })
    expect(res.settled).toBe('failed')
    expect(resumeConversationSessionMock).not.toHaveBeenCalled()
    const failWrite = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'failed')
    expect(failWrite).toBeDefined()
    expect(String(failWrite!.patch.error_message)).toMatch(/predates the eve upgrade/i)
  })
})


// ── Step-split dispatch primitives (one run = one eve session across Inngest requests) ──

describe('startWorkEveSession — create once, reuse a stamped session', () => {
  beforeEach(() => {
    createConversationSessionMock.mockReset()
    readSessionSnapshotMock.mockReset()
    appendAgentRunLogMock.mockReset()
    appendAgentRunLogMock.mockResolvedValue({ canceling: false })
    ClientMock.mockClear()
    ;(stampEveSession as unknown as ReturnType<typeof vi.fn>).mockClear()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })

  it('fresh row: flips queued→running (+ action working), creates the session with the brief, stamps it, and does NOT open the stream', async () => {
    const { supabase, updates } = makeSupabase({ agentRun: { status: 'queued' } })
    let opened = false
    createConversationSessionMock.mockImplementation(() =>
      Promise.resolve({
        sessionId: 'sess-work-1',
        session: { id: 'sess-work-1' },
        response: {
          [Symbol.asyncIterator]: () => {
            opened = true
            return (async function* () {})()
          },
        },
      }),
    )

    const start = await startWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      brief: BRIEF,
      supabase: supabase as never,
    })

    expect(start).toEqual({ sessionId: 'sess-work-1', stamped: true, reused: false, fromIndex: 0 })
    expect(updates.find((u) => u.table === 'agent_run' && u.patch.status === 'running')).toBeDefined()
    expect(updates.find((u) => u.table === 'actions' && u.patch.agent_run_status === 'working')).toBeDefined()
    expect(createConversationSessionMock).toHaveBeenCalledTimes(1)
    const [, payload] = createConversationSessionMock.mock.calls[0]
    expect(JSON.parse(payload.message).task).toBe(BRIEF.task)
    // CREATE-ONCE on the run id (step 3): the create carries eve's operationId.
    expect(payload.operationId).toBe('work-run:run-1')
    expect(stampEveSession).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { agentRunId: 'run-1', workspaceId: 'ws-1', sandboxId: 'eve:sess-work-1' },
    )
    // The first turn's stream is never consumed here — the watch steps read it.
    expect(opened).toBe(false)
  })

  it('the create→stamp window: a crash after eve accepted the create but before the stamp → the retry creates with the SAME operationId, eve hands back the first session, and that one is stamped (one agent per run)', async () => {
    // A fake eve honouring create-once (docs/channels/eve.mdx): the same
    // operationId returns the session the first create started, without a
    // second dispatch of the brief. Counting dispatches is the assertion.
    const sessionsByOperation = new Map<string, string>()
    let dispatched = 0
    createConversationSessionMock.mockImplementation((_client: unknown, input: { operationId?: string }) => {
      const key = input.operationId
      let id = key ? sessionsByOperation.get(key) : undefined
      if (!id) {
        dispatched += 1
        id = `sess-${dispatched}`
        if (key) sessionsByOperation.set(key, id)
      }
      return Promise.resolve({
        sessionId: id,
        session: { id },
        response: { [Symbol.asyncIterator]: () => (async function* () {})() },
      })
    })
    const stamp = stampEveSession as unknown as ReturnType<typeof vi.fn>
    // Attempt 1 dies between the create and the stamp (the stamp write never lands).
    stamp.mockImplementationOnce(async () => {
      throw new Error('FUNCTION_INVOCATION_TIMEOUT')
    })

    // The row stays unstamped across the crash: the retry cannot find a session on it.
    const { supabase } = makeSupabase({ agentRun: { status: 'queued' } })
    const args = { agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1', brief: BRIEF, supabase: supabase as never }
    await expect(startWorkEveSession(args)).rejects.toThrow(/FUNCTION_INVOCATION_TIMEOUT/)

    // Attempt 2 (Inngest's retry of the never-memoized create step).
    const retry = await startWorkEveSession(args)

    expect(createConversationSessionMock).toHaveBeenCalledTimes(2)
    const ops = createConversationSessionMock.mock.calls.map(([, p]) => (p as { operationId?: string }).operationId)
    expect(ops).toEqual(['work-run:run-1', 'work-run:run-1'])
    // ONE session was ever dispatched, and the retry stamps and watches that one from its first event.
    expect(dispatched).toBe(1)
    expect(retry).toEqual({ sessionId: 'sess-1', stamped: true, reused: false, fromIndex: 0 })
    expect(stamp).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      { agentRunId: 'run-1', workspaceId: 'ws-1', sandboxId: 'eve:sess-1' },
    )
  })

  it('a live row already stamped with eve:<id> (an earlier attempt) is REUSED: no create, no flip, resumes at the persisted cursor', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: {
        status: 'running',
        sandbox_id: 'eve:sess-prior',
        session_state: { sessionId: 'sess-prior', streamIndex: 33 },
      },
    })

    const start = await startWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      brief: BRIEF,
      supabase: supabase as never,
    })

    expect(start).toEqual({ sessionId: 'sess-prior', stamped: true, reused: true, fromIndex: 33 })
    expect(createConversationSessionMock).not.toHaveBeenCalled()
    expect(stampEveSession).not.toHaveBeenCalled()
    expect(updates).toHaveLength(0)
  })

  it('a stamped but TERMINAL row is not reused from the row; the create still carries the run\'s operationId (the dispatcher refuses terminal rows before this, so on real eve this path would adopt the parked session, never a second one)', async () => {
    const { supabase } = makeSupabase({ agentRun: { status: 'completed', sandbox_id: 'eve:sess-old' } })
    createConversationSessionMock.mockResolvedValue({
      sessionId: 'sess-new',
      session: { id: 'sess-new' },
      response: { [Symbol.asyncIterator]: () => (async function* () {})() },
    })

    const start = await startWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      brief: BRIEF,
      supabase: supabase as never,
    })
    expect(start.reused).toBe(false)
    expect(start.sessionId).toBe('sess-new')
    const [, payload] = createConversationSessionMock.mock.calls[0]
    expect(payload.operationId).toBe('work-run:run-1')
  })
})

describe('watchWorkEveSession — re-attach, drain to the boundary or the budget', () => {
  /** Wire the eve Client so `sessions.attach()` returns a session whose `.stream()`
   *  yields `events`, stopping (or hanging) per `hangAfter`. Records attach args. */
  function mockAttach(
    events: HandleMessageStreamEvent[],
    opts: { hangAfter?: number; snapshot?: { sessionId: string; streamIndex: number } | null } = {},
  ) {
    const attachCalls: Array<[string, { streamIndex?: number } | undefined]> = []
    const session = {
      id: 'sess-work-1',
      state: { sessionId: 'sess-work-1', streamIndex: 0 },
      stream: vi.fn(({ signal }: { signal?: AbortSignal } = {}) => {
        async function* gen() {
          let n = 0
          for (const ev of events) {
            if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
            yield ev
            n += 1
            if (opts.hangAfter !== undefined && n >= opts.hangAfter) {
              // The durable stream stays open (no boundary yet): wait for the abort.
              await new Promise<void>((_, reject) => {
                signal?.addEventListener('abort', () =>
                  reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
                )
              })
            }
          }
          // No boundary in `events` → an attached stream never closes by itself.
          if (opts.hangAfter === undefined) {
            await new Promise<void>((_, reject) => {
              signal?.addEventListener('abort', () =>
                reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
              )
            })
          }
        }
        return gen()
      }),
      respond: vi.fn(),
    }
    ClientMock.mockImplementation(() => ({
      sessions: {
        attach: (id: string, o?: { streamIndex?: number }) => {
          attachCalls.push([id, o])
          return session
        },
      },
    }))
    readSessionSnapshotMock.mockReturnValue(opts.snapshot === undefined ? null : opts.snapshot)
    return { attachCalls, session }
  }

  beforeEach(() => {
    createConversationSessionMock.mockReset()
    readSessionSnapshotMock.mockReset()
    appendAgentRunLogMock.mockReset()
    appendAgentRunLogMock.mockResolvedValue({ canceling: false })
    readAgentRunCancelingMock.mockReset()
    readAgentRunCancelingMock.mockResolvedValue(false)
    createNotificationMock.mockReset()
    ClientMock.mockReset()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })
  afterEach(() => {
    ClientMock.mockReset()
  })

  it('attaches at fromIndex, stops at the turn boundary, and classifies (finish_work settled → no-op + session_state from the stream position)', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: { status: 'running' },
      statusAtRead: { at: 1, status: 'completed' },
    })
    const { attachCalls } = mockAttach([messageAppended('done'), sessionWaiting()], { snapshot: null })

    const res = await watchWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      sessionId: 'sess-work-1',
      fromIndex: 10,
      budgetMs: 5_000,
      supabase: supabase as never,
    })

    expect(attachCalls).toEqual([['sess-work-1', { streamIndex: 10 }]])
    expect(res.settled).toBeNull()
    expect(res.pending).toBeUndefined()
    // No snapshot from the client → the watch derives it: fromIndex + consumed.
    const stateWrite = updates.find((u) => u.table === 'agent_run' && u.patch.session_state !== undefined)
    expect(stateWrite!.patch.session_state).toEqual({ sessionId: 'sess-work-1', streamIndex: 12, settleStreamIndex: 12 })
  })

  it('flushes a tool line on the timer while the tool is still running — no next event needed (Part 0 obs. 1)', async () => {
    vi.useFakeTimers()
    try {
      const { supabase } = makeSupabase({ agentRun: { status: 'running' } })
      const toolRequested = {
        type: 'actions.requested',
        data: { actions: [{ kind: 'tool-call', toolName: 'sleep' }] },
      } as unknown as HandleMessageStreamEvent
      // The prose flushes on arrival (first flush is always due); the tool line
      // lands inside the flush interval and then the stream goes quiet — a long
      // tool call — until the watch budget.
      mockAttach([messageAppended('Waiting a bit.'), toolRequested], { hangAfter: 2 })
      const texts = () => appendAgentRunLogMock.mock.calls.map((c) => (c as unknown as [unknown, { text: string }])[1].text).join('')

      const watch = watchWorkEveSession({
        agentRunId: 'run-1',
        workspaceId: 'ws-1',
        userId: 'user-1',
        sessionId: 'sess-work-1',
        fromIndex: 0,
        budgetMs: 60_000,
        supabase: supabase as never,
      })
      await vi.advanceTimersByTimeAsync(10)
      expect(texts()).toContain('Waiting a bit.')
      expect(texts()).not.toContain('[tool] sleep')

      // One flush interval later the timer writes it — the ledger's current_step
      // rides this same append (log-tail.ts beatAgentRunWork).
      await vi.advanceTimersByTimeAsync(2_100)
      expect(texts()).toContain('[tool] sleep')

      await vi.advanceTimersByTimeAsync(60_000)
      const res = await watch
      expect(res.settled).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the timer notices a Stop while the model is silent (empty buffer → canceling read)', async () => {
    vi.useFakeTimers()
    try {
      const { supabase, updates } = makeSupabase({ agentRun: { status: 'running' } })
      mockAttach([messageAppended('Thinking…')], { hangAfter: 1 })
      readAgentRunCancelingMock.mockResolvedValue(true)

      const watch = watchWorkEveSession({
        agentRunId: 'run-1',
        workspaceId: 'ws-1',
        userId: 'user-1',
        sessionId: 'sess-work-1',
        fromIndex: 0,
        budgetMs: 60_000,
        supabase: supabase as never,
      })
      await vi.advanceTimersByTimeAsync(2_100)
      const res = await watch
      expect(res.settled).toBe('canceled')
      expect(updates.find((u) => u.table === 'agent_run' && u.patch.status === 'canceled')).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('budget expiry before the boundary settles NOTHING and returns where the next watch resumes', async () => {
    const { supabase, updates } = makeSupabase({ agentRun: { status: 'running' } })
    mockAttach([messageAppended('still'), messageAppended('working')], { hangAfter: 2 })

    const res = await watchWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      sessionId: 'sess-work-1',
      fromIndex: 40,
      budgetMs: 30,
      supabase: supabase as never,
    })

    expect(res.settled).toBeNull()
    expect(res.pending).toEqual({ nextIndex: 42, pendingInput: null })
    expect(updates.find((u) => u.table === 'agent_run' && (u.patch.status === 'failed' || u.patch.status === 'needs_input'))).toBeUndefined()
  })

  it('a park seen before the budget expired is carried, and the next watch classifies it as a question park', async () => {
    // Watch 1: input.requested arrives, then the budget expires before session.waiting.
    const { supabase: s1 } = makeSupabase({ agentRun: { status: 'running' } })
    mockAttach([inputRequested()], { hangAfter: 1 })
    const first = await watchWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      sessionId: 'sess-work-1',
      fromIndex: 0,
      budgetMs: 30,
      supabase: s1 as never,
    })
    expect(first.pending?.nextIndex).toBe(1)
    expect(first.pending?.pendingInput?.requestId).toBe('req-42')

    // Watch 2: only the boundary remains on the stream.
    const { supabase: s2, updates } = makeSupabase({ agentRun: { status: 'running' } })
    mockAttach([sessionWaiting()], { snapshot: { sessionId: 'sess-work-1', streamIndex: 2 } })
    const second = await watchWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      sessionId: 'sess-work-1',
      fromIndex: 1,
      budgetMs: 5_000,
      carriedPendingInput: first.pending!.pendingInput,
      supabase: s2 as never,
    })

    expect(second.settled).toBe('needs_input')
    const park = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'needs_input')
    expect(park).toBeDefined()
    expect((park!.patch.pending_input as { requestId: string }).requestId).toBe('req-42')
  })

  it('budget expiring in the instant AFTER the boundary was read still classifies the turn (never pending past the boundary)', async () => {
    // The race: the drain reads session.waiting, then the trailing log flush
    // is slow and the 30 ms budget timer fires during it. The turn is complete,
    // so the watch must park/settle it — returning `pending` with an index past
    // the boundary would leave the next watch reading nothing until the step
    // cap failed the run.
    const { supabase, updates } = makeSupabase({ agentRun: { status: 'running' } })
    appendAgentRunLogMock
      // First flush (the message line, due at once): fast.
      .mockImplementationOnce(async () => ({ canceling: false }))
      // Trailing flush after the boundary: slower than the budget.
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 120))
        return { canceling: false }
      })
    mockAttach([messageAppended('a'.repeat(1000)), messageAppended('b'), inputRequested(), sessionWaiting()], {
      snapshot: { sessionId: 'sess-work-1', streamIndex: 4 },
    })

    const res = await watchWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      sessionId: 'sess-work-1',
      fromIndex: 0,
      budgetMs: 30,
      supabase: supabase as never,
    })

    expect(res.pending).toBeUndefined()
    expect(res.settled).toBe('needs_input')
    const park = updates.find((u) => u.table === 'agent_run' && u.patch.status === 'needs_input')
    expect(park).toBeDefined()
    expect((park!.patch.pending_input as { requestId: string }).requestId).toBe('req-42')
  })

  it('cancel observed mid-watch settles canceled, never pending', async () => {
    const { supabase, updates } = makeSupabase({ agentRun: { status: 'running' } })
    appendAgentRunLogMock.mockResolvedValue({ canceling: true })
    mockAttach([messageAppended('a'.repeat(1000)), messageAppended('b')], { hangAfter: 2 })

    const res = await watchWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      sessionId: 'sess-work-1',
      fromIndex: 0,
      budgetMs: 5_000,
      supabase: supabase as never,
    })

    expect(res.settled).toBe('canceled')
    expect(res.pending).toBeUndefined()
    expect(updates.find((u) => u.table === 'agent_run' && u.patch.status === 'canceled')).toBeDefined()
  })
})

describe('resumeWorkEveSession — answer the park, return the resumed cursor', () => {
  const PENDING = {
    requestId: 'req-42',
    approveOptionId: 'approve',
    denyOptionId: 'deny',
    questions: [{ question: 'Which environment?', header: 'Env', options: [], multiSelect: false }],
    askedAt: '2026-07-15T00:00:00.000Z',
  }
  beforeEach(() => {
    resumeConversationSessionMock.mockReset()
    appendAgentRunLogMock.mockReset()
    appendAgentRunLogMock.mockResolvedValue({ canceling: false })
    ClientMock.mockReset()
    ;(internalSecret as unknown as ReturnType<typeof vi.fn>).mockReturnValue(SECRET)
  })

  it('CAS queued→running, answers the approval, and returns the parked cursor as fromIndex — without draining the turn', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: {
        status: 'queued',
        sandbox_id: 'eve:sess-work-1',
        session_state: { sessionId: 'sess-work-1', streamIndex: 7 },
        pending_input: PENDING,
      },
    })
    let opened = false
    resumeConversationSessionMock.mockResolvedValue({
      session: { id: 'sess-work-1' },
      response: {
        [Symbol.asyncIterator]: () => {
          opened = true
          return (async function* () {})()
        },
      },
    })

    const res = await resumeWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      response: { answers: [{ question: 'Which environment?', answer: 'Staging' }] },
      expectedRequestId: 'req-42',
      supabase: supabase as never,
    })

    expect(res).toEqual({ kind: 'resumed', sessionId: 'sess-work-1', fromIndex: 7 })
    expect(updates.find((u) => u.table === 'agent_run' && u.patch.status === 'running' && u.patch.pending_input === null)).toBeDefined()
    const args = resumeConversationSessionMock.mock.calls[0][1] as { payload: { inputResponses: unknown } }
    expect(args.payload.inputResponses).toEqual([{ requestId: 'req-42', optionId: 'approve' }])
    expect(opened).toBe(false)
    // Bots v3 Phase 5: the resumed turn's token carries `resume`, so the
    // work-agent re-resolves its tools from it (the answer can come hours later).
    expect(vi.mocked(mintAgentRunToken)).toHaveBeenLastCalledWith(expect.objectContaining({ agentRunId: 'run-1', resume: true }))
  })

  it('a stale duplicate (expectedRequestId mismatch) is skipped without a CAS', async () => {
    const { supabase, updates } = makeSupabase({
      agentRun: {
        status: 'queued',
        sandbox_id: 'eve:sess-work-1',
        session_state: { sessionId: 'sess-work-1', streamIndex: 7 },
        pending_input: { ...PENDING, requestId: 'req-99' },
      },
    })
    const res = await resumeWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      response: { answers: [] },
      expectedRequestId: 'req-42',
      supabase: supabase as never,
    })
    expect(res).toEqual({ kind: 'skipped', sessionId: 'sess-work-1', settled: null })
    expect(updates).toHaveLength(0)
    expect(resumeConversationSessionMock).not.toHaveBeenCalled()
  })
})
