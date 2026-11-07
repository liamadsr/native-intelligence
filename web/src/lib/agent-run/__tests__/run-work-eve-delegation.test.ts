/**
 * The work-run watcher's delegate_work paths (Part 5 row 13), against the
 * stateful fake so the park, the ledger row and the release are real writes:
 *
 *   - a handoff that created a child parks the run on it (needs_input + the
 *     DelegationPark, ledger waiting_on_child) and dispatches the child only
 *     AFTER the park took; a park that lost to a cancel abandons the child;
 *   - a batch where every handoff was refused is answered in place (approve →
 *     each execute returns its refusal) and the turn goes on, at most twice;
 *   - a handoff alongside a question parks on the question, whose resume also
 *     answers the refused handoff (companionResponses);
 *   - a person's answer never un-parks a delegation park;
 *   - releaseDelegationPark: waits while a child runs, then un-parks and
 *     approves every handoff in the park (refused ones too).
 *
 * The §3.2 checks themselves are delegation.test.ts; planDelegations and the
 * dispatch are spies here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { DelegationPark } from '../types'

const SECRET = 'test-work-run-secret-abcdefghij0'

const h = vi.hoisted(() => ({
  resumeConversationSessionMock: vi.fn(),
  readSessionSnapshotMock: vi.fn(),
  ClientMock: vi.fn(),
  appendAgentRunLogMock: vi.fn(async (..._a: unknown[]) => ({ canceling: false })),
  readAgentRunCancelingMock: vi.fn(async () => false),
  planMock: vi.fn(),
  dispatchMock: vi.fn(async (..._a: unknown[]) => undefined),
}))

vi.mock('eve/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('eve/client')>()),
  Client: h.ClientMock,
}))
vi.mock('@/lib/eve/conversation-session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/eve/conversation-session')>()),
  createConversationSession: vi.fn(),
  resumeConversationSession: h.resumeConversationSessionMock,
  readSessionSnapshot: h.readSessionSnapshotMock,
}))
vi.mock('../agent-run-token', () => ({
  mintAgentRunToken: vi.fn(() => 'signed.token'),
  internalSecret: vi.fn(() => SECRET),
  AGENT_RUN_SECRET_HEADER: 'x-agent-run-secret',
  AGENT_RUN_TOKEN_HEADER: 'x-agent-run-token',
  AGENT_RUN_WORKSPACE_HEADER: 'x-agent-run-workspace',
  AGENT_RUN_USER_HEADER: 'x-agent-run-user',
}))
vi.mock('../run-agent-eve', () => ({ EVE_SANDBOX_PREFIX: 'eve:', stampEveSession: vi.fn(async () => true) }))
vi.mock('../log-tail', () => ({ appendAgentRunLog: h.appendAgentRunLogMock, readAgentRunCanceling: h.readAgentRunCancelingMock }))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => undefined) } }))
vi.mock('../delegation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../delegation')>()),
  planDelegations: h.planMock,
  dispatchDelegatedChildren: h.dispatchMock,
}))

import { releaseDelegationPark, resumeWorkEveSession, watchWorkEveSession } from '../run-work-eve'
import { inngest } from '@/lib/inngest/client'
import { resetAgentRunMirrorCaches } from '@/lib/work/agent-run-mirror'

// ── Events ─────────────────────────────────────────────────────────────────────

function delegateRequest(requestId: string, callId: string, role = 'researcher') {
  return {
    requestId,
    prompt: 'Approve delegate_work?',
    display: 'confirmation',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' },
    ],
    action: { callId, kind: 'tool-call', toolName: 'delegate_work', input: { role, brief: { task: 'Find the Acme price.' } } },
  }
}
function questionRequest() {
  return {
    requestId: 'req-q',
    prompt: 'Pick',
    display: 'confirmation',
    options: [
      { id: 'approve', label: 'Approve' },
      { id: 'deny', label: 'Deny' },
    ],
    action: {
      callId: 'call-q',
      kind: 'tool-call',
      toolName: 'request_user_input',
      input: { questions: [{ question: 'Which quarter?', header: 'Q', options: [{ label: 'Q3' }, { label: 'Q4' }], multiSelect: false }] },
    },
  }
}
function inputRequested(requests: unknown[]): HandleMessageStreamEvent {
  return { type: 'input.requested', data: { requests, sequence: 0, stepIndex: 0, turnId: 't' } } as unknown as HandleMessageStreamEvent
}
function sessionWaiting(): HandleMessageStreamEvent {
  return { type: 'session.waiting', data: { wait: 'next-user-message' } } as unknown as HandleMessageStreamEvent
}
function messageAppended(delta: string): HandleMessageStreamEvent {
  return { type: 'message.appended', data: { messageDelta: delta, sequence: 0, stepIndex: 0, turnId: 't' } } as HandleMessageStreamEvent
}

function responseOf(events: HandleMessageStreamEvent[]) {
  return {
    [Symbol.asyncIterator]: () =>
      (async function* () {
        for (const ev of events) yield ev
      })(),
  }
}

/** The attached session: `.stream()` yields the watched turn; each `.respond()`
 *  yields the next of `later` (and runs its side effect first). */
function mockAttach(first: HandleMessageStreamEvent[], later: Array<{ events: HandleMessageStreamEvent[]; effect?: () => void }> = []) {
  let i = 0
  const session = {
    id: 'sess-work-1',
    state: { sessionId: 'sess-work-1', streamIndex: 0 },
    stream: vi.fn(() => responseOf(first)[Symbol.asyncIterator]()),
    respond: vi.fn(async (_responses: unknown, _opts?: unknown) => {
      const next = later[i] ?? { events: [sessionWaiting()] }
      i += 1
      next.effect?.()
      return responseOf(next.events)
    }),
  }
  h.ClientMock.mockImplementation(() => ({ sessions: { attach: () => session } }))
  return session
}

// ── The DB ─────────────────────────────────────────────────────────────────────

function db(run: Record<string, unknown> = {}): FakeSupabase {
  const fake = makeFakeSupabase()
  fake.seed('member', [{ id: 'mem-1', workspace_id: 'ws-1', user_id: 'user-1' }])
  fake.seed('agent_run', [
    {
      id: 'run-1',
      workspace_id: 'ws-1',
      kind: 'workspace',
      status: 'running',
      action_id: null,
      triggered_by: 'user-1',
      sandbox_id: 'eve:sess-work-1',
      session_state: null,
      pending_input: null,
      ...run,
    },
    { id: 'child-1', workspace_id: 'ws-1', kind: 'workspace', status: 'queued', parent_run_id: 'run-1', triggered_by: 'user-1' },
  ])
  fake.seed('tracked_job', [
    { id: 'work-1', workspace_id: 'ws-1', member_id: 'mem-1', kind: 'work_run', run_key: 'run-1', agent_run_id: 'run-1', status: 'running', progress: {}, depth: 0 },
    { id: 'work-child', workspace_id: 'ws-1', member_id: 'mem-1', kind: 'work_run', run_key: 'child-1', agent_run_id: 'child-1', status: 'queued', progress: {}, parent_id: 'work-1', root_id: 'work-1', depth: 1 },
  ])
  return fake
}

const run = (fake: FakeSupabase, id = 'run-1') => fake.rows('agent_run').find((r) => r.id === id)!
const ledger = (fake: FakeSupabase, id = 'work-1') => fake.rows('tracked_job').find((r) => r.id === id)!

function park(children: DelegationPark['children']): DelegationPark {
  return { kind: 'delegation', askedAt: '2026-09-28T23:00:00.000Z', children }
}
const CHILD_ENTRY = { requestId: 'req-d1', callId: 'call-d1', approveOptionId: 'approve', role: 'researcher', childRunId: 'child-1' }
const REFUSED_ENTRY = {
  requestId: 'req-d1',
  callId: 'call-d1',
  approveOptionId: 'approve',
  role: 'writer',
  childRunId: null,
  refused: { code: 'DELEGATION_NOT_ALLOWED' as const, reason: 'you are not allowed to hand work to that role' },
}

function watch(fake: FakeSupabase) {
  return watchWorkEveSession({
    agentRunId: 'run-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    sessionId: 'sess-work-1',
    fromIndex: 0,
    budgetMs: 5_000,
    supabase: fake as never,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetAgentRunMirrorCaches()
  h.readSessionSnapshotMock.mockReturnValue({ sessionId: 'sess-work-1', streamIndex: 4 })
  h.appendAgentRunLogMock.mockResolvedValue({ canceling: false })
  h.readAgentRunCancelingMock.mockResolvedValue(false)
})

describe('a handoff that created a child', () => {
  it('parks the run on it, and dispatches the child only once the park took', async () => {
    const fake = db()
    h.planMock.mockResolvedValue({ park: park([CHILD_ENTRY]), childRunIds: ['child-1'] })
    let statusAtDispatch: unknown = null
    h.dispatchMock.mockImplementation(async () => {
      statusAtDispatch = run(fake).status
    })
    mockAttach([inputRequested([delegateRequest('req-d1', 'call-d1')]), sessionWaiting()])

    const res = await watch(fake)

    expect(res.settled).toBe('needs_input')
    expect(h.planMock).toHaveBeenCalledTimes(1)
    const planArgs = h.planMock.mock.calls[0][1] as { requests: Array<{ requestId: string; callId: string }>; alongsideQuestion: boolean }
    expect(planArgs.requests.map((r) => [r.requestId, r.callId])).toEqual([['req-d1', 'call-d1']])
    expect(planArgs.alongsideQuestion).toBe(false)
    expect(run(fake)).toMatchObject({ status: 'needs_input', pending_input: park([CHILD_ENTRY]) })
    expect(h.dispatchMock).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'ws-1', childRunIds: ['child-1'] })
    expect(statusAtDispatch).toBe('needs_input')
    expect(ledger(fake)).toMatchObject({
      status: 'waiting_on_child',
      current_step: 'Waiting on Researcher',
      needs: { kind: 'child', work_item_id: 'work-child', role: 'researcher' },
      deadline_at: null,
    })
  })

  it('a park that lost to a concurrent cancel never dispatches, and its child is abandoned', async () => {
    const fake = db()
    h.planMock.mockImplementation(async () => {
      run(fake).status = 'canceled'
      return { park: park([CHILD_ENTRY]), childRunIds: ['child-1'] }
    })
    mockAttach([inputRequested([delegateRequest('req-d1', 'call-d1')]), sessionWaiting()])

    await watch(fake)

    expect(h.dispatchMock).not.toHaveBeenCalled()
    expect(run(fake).status).toBe('canceled')
    expect(run(fake, 'child-1')).toMatchObject({ status: 'canceled', error_message: 'The run that handed this over stopped first' })
    expect(ledger(fake, 'work-child').status).toBe('canceled')
  })
})

describe('a batch where every handoff was refused', () => {
  it('is answered in place (approve, so each execute returns its refusal) and the turn goes on', async () => {
    const fake = db()
    h.planMock.mockResolvedValue({ park: park([REFUSED_ENTRY]), childRunIds: [] })
    const session = mockAttach([inputRequested([delegateRequest('req-d1', 'call-d1', 'writer')]), sessionWaiting()], [
      // finish_work settles the run through the outcome route during the next turn.
      { events: [messageAppended('Carrying on.'), sessionWaiting()], effect: () => void (run(fake).status = 'completed') },
    ])

    const res = await watch(fake)

    expect(session.respond).toHaveBeenCalledTimes(1)
    expect(session.respond.mock.calls[0][0]).toEqual([{ requestId: 'req-d1', optionId: 'approve' }])
    expect(h.appendAgentRunLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: expect.stringContaining('handoff refused — DELEGATION_NOT_ALLOWED') }),
    )
    expect(h.dispatchMock).not.toHaveBeenCalled()
    expect(res.settled).toBeNull()
    expect(run(fake)).toMatchObject({ status: 'completed', pending_input: null })
  })

  it('a model that keeps handing off refused work is failed after two rounds', async () => {
    const fake = db()
    h.planMock.mockImplementation(async (_s: unknown, a: { requests: Array<{ requestId: string; callId: string }> }) => ({
      park: park(a.requests.map((r) => ({ ...REFUSED_ENTRY, requestId: r.requestId, callId: r.callId }))),
      childRunIds: [],
    }))
    const again = (n: number) => ({ events: [inputRequested([delegateRequest(`req-d${n}`, `call-d${n}`, 'writer')]), sessionWaiting()] })
    const session = mockAttach([inputRequested([delegateRequest('req-d1', 'call-d1', 'writer')]), sessionWaiting()], [again(2), again(3)])

    const res = await watch(fake)

    expect(session.respond).toHaveBeenCalledTimes(2)
    expect(res.settled).toBe('failed')
    expect(run(fake)).toMatchObject({ status: 'failed' })
    expect(String(run(fake).error_message)).toContain('agent kept handing off work that was refused')
  })
})

describe('a delegated child that fails', () => {
  it('tells its parent it settled, so the parent is not left waiting', async () => {
    const fake = db({ parent_run_id: 'run-parent', origin: 'delegation' })
    // The turn ends with no outcome and no park: a bare park, settled failed.
    mockAttach([messageAppended('I give up.'), sessionWaiting()])
    const res = await watch(fake)
    expect(res.settled).toBe('failed')
    expect(inngest.send).toHaveBeenCalledWith({
      id: 'child-settled:run-1',
      name: 'work/run.child_settled',
      data: { agent_run_id: 'run-parent', child_run_id: 'run-1', workspace_id: 'ws-1' },
    })
  })
})

describe('a handoff alongside a question', () => {
  it('parks on the question and carries the refused handoff’s answer for the resume', async () => {
    const fake = db()
    h.planMock.mockResolvedValue({
      park: park([{ ...REFUSED_ENTRY, role: 'researcher', refused: { code: 'ASK_FIRST', reason: 'ask first' } }]),
      childRunIds: [],
    })
    mockAttach([inputRequested([questionRequest(), delegateRequest('req-d1', 'call-d1')]), sessionWaiting()])

    const res = await watch(fake)

    expect((h.planMock.mock.calls[0][1] as { alongsideQuestion: boolean }).alongsideQuestion).toBe(true)
    expect(res.settled).toBe('needs_input')
    expect(run(fake).status).toBe('needs_input')
    expect(run(fake).pending_input).toMatchObject({
      requestId: 'req-q',
      companionResponses: [{ requestId: 'req-d1', optionId: 'approve' }],
    })
    expect(h.dispatchMock).not.toHaveBeenCalled()
  })

  it('the question’s resume answers the question AND the handoff in one batch', async () => {
    const fake = db({
      status: 'queued',
      session_state: { sessionId: 'sess-work-1', streamIndex: 7 },
      pending_input: {
        requestId: 'req-q',
        approveOptionId: 'approve',
        denyOptionId: 'deny',
        questions: [{ question: 'Which quarter?', header: 'Q', options: [], multiSelect: false }],
        askedAt: '2026-09-28T23:00:00.000Z',
        companionResponses: [{ requestId: 'req-d1', optionId: 'approve' }],
      },
    })
    h.resumeConversationSessionMock.mockResolvedValue({ session: { id: 'sess-work-1' }, response: responseOf([]) })

    const res = await resumeWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      response: { answers: [{ question: 'Which quarter?', answer: 'Q3' }] },
      expectedRequestId: 'req-q',
      supabase: fake as never,
    })

    expect(res).toEqual({ kind: 'resumed', sessionId: 'sess-work-1', fromIndex: 7 })
    const payload = (h.resumeConversationSessionMock.mock.calls[0][1] as { payload: { inputResponses: unknown } }).payload
    expect(payload.inputResponses).toEqual([
      { requestId: 'req-q', optionId: 'approve' },
      { requestId: 'req-d1', optionId: 'approve' },
    ])
  })
})

describe('a person’s answer', () => {
  it('never un-parks a run waiting on its teammates', async () => {
    const fake = db({ status: 'queued', session_state: { sessionId: 'sess-work-1', streamIndex: 7 }, pending_input: park([CHILD_ENTRY]) })
    const res = await resumeWorkEveSession({
      agentRunId: 'run-1',
      workspaceId: 'ws-1',
      userId: 'user-1',
      response: { answers: [] },
      supabase: fake as never,
    })
    expect(res.kind).toBe('skipped')
    expect(h.resumeConversationSessionMock).not.toHaveBeenCalled()
    expect(run(fake).pending_input).toEqual(park([CHILD_ENTRY]))
  })
})

describe('releaseDelegationPark', () => {
  function parked(extra: Record<string, unknown> = {}) {
    const fake = db({
      status: 'needs_input',
      session_state: { sessionId: 'sess-work-1', streamIndex: 9 },
      pending_input: park([CHILD_ENTRY, { ...REFUSED_ENTRY, requestId: 'req-d2', callId: 'call-d2' }]),
      ...extra,
    })
    ledger(fake).status = 'waiting_on_child'
    return fake
  }
  const release = (fake: FakeSupabase) => releaseDelegationPark({ agentRunId: 'run-1', workspaceId: 'ws-1', supabase: fake as never })

  it('waits while a child is still running', async () => {
    const fake = parked()
    run(fake, 'child-1').status = 'running'
    expect(await release(fake)).toEqual({ kind: 'waiting', sessionId: 'sess-work-1', settled: null })
    expect(run(fake).status).toBe('needs_input')
    expect(h.resumeConversationSessionMock).not.toHaveBeenCalled()
  })

  it('once every child settled: un-parks, and approves every handoff in the park (refused ones too)', async () => {
    const fake = parked()
    run(fake, 'child-1').status = 'completed'
    h.resumeConversationSessionMock.mockResolvedValue({ session: { id: 'sess-work-1' }, response: responseOf([]) })

    expect(await release(fake)).toEqual({ kind: 'resumed', sessionId: 'sess-work-1', fromIndex: 9 })
    expect(run(fake)).toMatchObject({ status: 'running', pending_input: null })
    expect(ledger(fake).status).toBe('running')
    const call = h.resumeConversationSessionMock.mock.calls[0][1] as { sessionId: string; payload: { inputResponses: unknown; message?: unknown } }
    expect(call.sessionId).toBe('sess-work-1')
    expect(call.payload).toEqual({
      inputResponses: [
        { requestId: 'req-d1', optionId: 'approve' },
        { requestId: 'req-d2', optionId: 'approve' },
      ],
    })
    expect(h.appendAgentRunLogMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: expect.stringContaining('the teammate finished') }),
    )
  })

  it('a second release of the same park is a no-op', async () => {
    const fake = parked()
    run(fake, 'child-1').status = 'failed'
    h.resumeConversationSessionMock.mockResolvedValue({ session: { id: 'sess-work-1' }, response: responseOf([]) })
    await release(fake)
    expect((await release(fake)).kind).toBe('skipped')
    expect(h.resumeConversationSessionMock).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for a run no longer parked on its children (stopped, or a question park)', async () => {
    const stopped = parked({ status: 'canceled' })
    expect((await release(stopped)).kind).toBe('skipped')
    const question = parked({ pending_input: { requestId: 'req-q', approveOptionId: 'approve', denyOptionId: 'deny', questions: [], askedAt: 'x' } })
    expect((await release(question)).kind).toBe('skipped')
    expect(h.resumeConversationSessionMock).not.toHaveBeenCalled()
  })

  it('fails the run when there is no session to hand the results to, or the resume send fails', async () => {
    const noSession = parked({ sandbox_id: null, session_state: null })
    run(noSession, 'child-1').status = 'completed'
    expect(await release(noSession)).toMatchObject({ kind: 'skipped', settled: 'failed' })
    expect(run(noSession).status).toBe('failed')

    const sendFails = parked()
    run(sendFails, 'child-1').status = 'completed'
    h.resumeConversationSessionMock.mockRejectedValue(new Error('eve down'))
    expect(await release(sendFails)).toMatchObject({ kind: 'skipped', settled: 'failed' })
    expect(String(run(sendFails).error_message)).toContain('release send failed: eve down')
  })
})
