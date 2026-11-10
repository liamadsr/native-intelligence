import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handle = {
  id: string
  step: ReturnType<typeof vi.fn>
  flush: ReturnType<typeof vi.fn>
  beat: ReturnType<typeof vi.fn>
  needInput: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  finish: ReturnType<typeof vi.fn>
  fail: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
}

const work = vi.hoisted(() => {
  const handles = new Map<string, Handle>()
  const handleFor = (id: string): Handle => {
    let h = handles.get(id)
    if (!h) {
      h = {
        id,
        step: vi.fn(async () => undefined),
        flush: vi.fn(async () => undefined),
        beat: vi.fn(async () => undefined),
        needInput: vi.fn(async () => undefined),
        resume: vi.fn(async () => undefined),
        finish: vi.fn(async () => undefined),
        fail: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      }
      handles.set(id, h)
    }
    return h
  }
  return {
    handles,
    handleFor,
    db: null as null | { tables: Record<string, Array<Record<string, unknown>>> },
    startWork: vi.fn(async (_svc: unknown, input: { runKey: string; status: string; title: string }) => {
      const id = `job:${input.runKey}`
      const rows = work.db!.tables.tracked_job
      if (!rows.some((r) => r.id === id)) rows.push({ id, status: input.status, run_key: input.runKey, title: input.title })
      return handleFor(id)
    }),
    attachWork: vi.fn((_svc: unknown, row: { id: string }) => handleFor(row.id)),
    resolveMemberId: vi.fn(async (): Promise<string | null> => 'member-1'),
    systemTeammateId: vi.fn(async () => 'teammate-assistant'),
  }
})
vi.mock('@/lib/work/recorder', () => ({ startWork: work.startWork, attachWork: work.attachWork }))
vi.mock('@/lib/work/agent-run-mirror', () => ({ resolveMemberId: work.resolveMemberId }))
vi.mock('@/lib/work/system-teammates', () => ({ systemTeammateId: work.systemTeammateId }))

import {
  INTERRUPTED_NEEDS_ID,
  INTERRUPTED_QUESTION,
  LEDGER_SILENT_TOOLS,
  TEAMMATE_NEEDS_ID,
  isTeammateQuestion,
  moveTurn,
  nextTurn,
  startTurnRow,
  stepFromTool,
  turnRunKey,
  turnTitle,
  type LedgerSession,
} from '../ledger'
import { CONV, USER, WS, fakeDb } from './fake-db'

const SID = '77777777-7777-4777-8777-777777777777'

function setup(turnStatus: string | null, extra: Partial<LedgerSession> = {}) {
  const jobId = turnStatus ? `job:${turnRunKey(SID, 1)}` : null
  const db = fakeDb({
    tracked_job: turnStatus ? [{ id: jobId, status: turnStatus }] : [],
    local_agent_session: [{ id: SID, user_id: USER, current_turn: 1, current_tracked_job_id: jobId, tracked_job_id: jobId }],
    local_agent_message: [{ id: 'm', session_id: SID, user_id: USER, text: 'Now fix the failing test', created_at: '2026-10-20T22:00:00Z' }],
  })
  work.db = db as never
  const s: LedgerSession = {
    id: SID, userId: USER, workspaceId: WS, conversationId: CONV, folderLabel: 'native-intelligence', deviceName: 'Liam’s MacBook',
    request: 'Take a look at this repository', currentTurn: 1, currentTrackedJobId: jobId, trackedJobId: jobId, ...extra,
  }
  return { db, s, h: jobId ? work.handleFor(jobId) : null }
}

beforeEach(() => {
  work.handles.clear()
  work.startWork.mockClear()
  work.attachWork.mockClear()
  work.resolveMemberId.mockResolvedValue('member-1')
})

describe('the turn row', () => {
  it('starts with kind local_agent, a per-turn run key, chat origin and the session in its source', async () => {
    const { db, s } = setup(null)
    const id = await startTurnRow(db as never, s, { turn: 1, text: s.request, status: 'queued' })
    expect(id).toBe(`job:local_agent:${SID}:1`)
    expect(work.startWork).toHaveBeenCalledWith(db, {
      workspaceId: WS,
      memberId: 'member-1',
      kind: 'local_agent',
      title: 'Native Intelligence on Liam’s MacBook · native-intelligence: Take a look at this repository',
      actor: 'agent',
      status: 'queued',
      runKey: `local_agent:${SID}:1`,
      origin: 'chat',
      source: { chat_conversation_id: CONV, local_agent_session_id: SID, folder_label: 'native-intelligence', device_name: 'Liam’s MacBook', turn: 1 },
      aiTeamMemberId: 'teammate-assistant',
    })
  })

  it('records nothing without a member', async () => {
    const { db, s } = setup(null)
    work.resolveMemberId.mockResolvedValue(null)
    expect(await startTurnRow(db as never, s, { turn: 1, text: 'x', status: 'queued' })).toBeNull()
    expect(work.startWork).not.toHaveBeenCalled()
  })

  it('titles cap the request at 60 characters; steps name the tool and its target', () => {
    expect(turnTitle('Liam’s MacBook', 'repo', 'a'.repeat(100))).toBe(`Native Intelligence on Liam’s MacBook · repo: ${'a'.repeat(59)}…`)
    expect(turnTitle('', 'repo', 'Look')).toBe('Native Intelligence on your Mac · repo: Look')
    expect(stepFromTool('read_file', '{"path":"src/lib/x.ts"}')).toBe('Reading src/lib/x.ts')
    expect(stepFromTool('bash', '{"command":"npm test"}')).toBe('Running npm test')
    expect(stepFromTool('grep', '{"pattern":"TODO"')).toBe('Searching')
    expect(stepFromTool('bash', JSON.stringify({ command: 'x'.repeat(200) })).length).toBe(60)
  })

  it('nextTurn opens turn+1 and points the session at it (CAS on current_turn)', async () => {
    const { db, s } = setup('needs_review')
    const next = await nextTurn(db as never, s, { text: 'Now fix the failing test', status: 'queued' })
    expect(next).toMatchObject({ currentTurn: 2, currentTrackedJobId: `job:local_agent:${SID}:2` })
    expect(db.tables.local_agent_session[0]).toMatchObject({ current_turn: 2, current_tracked_job_id: `job:local_agent:${SID}:2` })
    // A racing caller with the stale turn converges on what won.
    const again = await nextTurn(db as never, s, { text: 'x', status: 'queued' })
    expect(again.currentTurn).toBe(2)
  })
})

describe('moves', () => {
  it('step on a running turn steps and flushes; on a parked turn resumes first', async () => {
    const { db, s, h } = setup('running')
    await moveTurn(db as never, s, { type: 'step', text: 'Reading src/app.ts' })
    expect(h!.step).toHaveBeenCalledWith('Reading src/app.ts')
    expect(h!.flush).toHaveBeenCalled()
    expect(h!.resume).not.toHaveBeenCalled()
    db.tables.tracked_job[0].status = 'needs_input'
    await moveTurn(db as never, s, { type: 'step', text: 'Working' })
    expect(h!.resume).toHaveBeenCalledTimes(1)
  })

  it('a device step never reopens a settled turn: turns open only from messages', async () => {
    const { db, s, h } = setup('needs_review')
    const after = await moveTurn(db as never, s, { type: 'step', text: 'Working on your Mac' })
    const asked = await moveTurn(db as never, s, { type: 'ask', question: 'again?' })
    expect(after.currentTurn).toBe(1)
    expect(asked.currentTurn).toBe(1)
    expect(h!.step).not.toHaveBeenCalled()
    expect(h!.needInput).not.toHaveBeenCalled()
    expect(work.startWork).not.toHaveBeenCalled()
  })

  it('ask parks on the question; the answer resumes', async () => {
    const { db, s, h } = setup('running')
    await moveTurn(db as never, s, { type: 'ask', question: 'Which branch?' })
    expect(h!.needInput).toHaveBeenCalledWith([{ id: 'local-agent-ask', question: 'Which branch?' }])
    db.tables.tracked_job[0].status = 'needs_input'
    await moveTurn(db as never, s, { type: 'resume' })
    expect(h!.resume).toHaveBeenCalled()
  })

  it('a turn end is done (reported in the chat) unless it is an edit turn’s review; the summary caps at 2k', async () => {
    const { db, s, h } = setup('running')
    await moveTurn(db as never, s, { type: 'turn_end', summary: 'x'.repeat(3000) })
    const done = h!.finish.mock.calls[0][0] as { summary: string; review?: unknown; reportDone?: boolean }
    expect(done.review).toBeUndefined()
    expect(done.reportDone).toBe(true)
    expect(done.summary.length).toBe(2000)
    db.tables.tracked_job[0].status = 'running'
    await moveTurn(db as never, s, { type: 'turn_end', summary: 'Changed 3 files', review: true })
    expect(h!.finish.mock.calls[1][0]).toEqual({ summary: 'Changed 3 files', review: { kind: 'review', verb: 'review' } })
  })

  it('an undelivered message parks a live turn on "send it again"; a settled one is left', async () => {
    const { db, s, h } = setup('running')
    await moveTurn(db as never, s, { type: 'undelivered', reason: 'job not live' })
    expect(h!.needInput).toHaveBeenCalledWith([{ id: 'local-agent-undelivered', question: "Your Mac couldn't take a message (job not live). Send it again." }])
    db.tables.tracked_job[0].status = 'done'
    await moveTurn(db as never, s, { type: 'undelivered', reason: 'x' })
    expect(h!.needInput).toHaveBeenCalledTimes(1)
  })

  it('fail and cancel touch only an open turn: a turn settled for review keeps its result', async () => {
    const { db, s, h } = setup('needs_review')
    await moveTurn(db as never, s, { type: 'fail', message: 'boom' })
    await moveTurn(db as never, s, { type: 'cancel' })
    expect(h!.fail).not.toHaveBeenCalled()
    expect(h!.cancel).not.toHaveBeenCalled()
    db.tables.tracked_job[0].status = 'running'
    await moveTurn(db as never, s, { type: 'fail', message: 'boom' })
    expect(h!.fail).toHaveBeenCalledWith('boom')
    db.tables.tracked_job[0].status = 'queued'
    await moveTurn(db as never, s, { type: 'cancel' })
    expect(h!.cancel).toHaveBeenCalled()
  })

  it('interrupted parks a live turn with the resume text; beats only a live turn', async () => {
    const { db, s, h } = setup('running')
    await moveTurn(db as never, s, { type: 'beat' })
    expect(h!.beat).toHaveBeenCalledTimes(1)
    await moveTurn(db as never, s, { type: 'interrupted' })
    expect(h!.needInput).toHaveBeenCalledWith([{ id: 'local-agent-interrupted', question: INTERRUPTED_QUESTION }])
    db.tables.tracked_job[0].status = 'needs_input'
    await moveTurn(db as never, s, { type: 'beat' })
    await moveTurn(db as never, s, { type: 'interrupted' })
    expect(h!.beat).toHaveBeenCalledTimes(1)
    expect(h!.needInput).toHaveBeenCalledTimes(1)
  })

  it('a session with no turn row yet records one on its first step', async () => {
    const { db, s } = setup(null)
    const after = await moveTurn(db as never, s, { type: 'step', text: 'Starting on your Mac' })
    expect(after.currentTrackedJobId).toBe(`job:local_agent:${SID}:1`)
    expect(db.tables.local_agent_session[0]).toMatchObject({ current_tracked_job_id: `job:local_agent:${SID}:1`, tracked_job_id: `job:local_agent:${SID}:1` })
  })
})

describe('the Mac body’s question to its teammate (teammate plan C4)', () => {
  const parked = (db: { tables: Record<string, Array<Record<string, unknown>>> }, id: string) => {
    db.tables.tracked_job[0].needs = { kind: 'input', questions: [{ id, question: 'q' }] }
  }

  it('parks a running turn on its own needs id', async () => {
    const { db, s, h } = setup('running')
    await moveTurn(db as never, s, { type: 'ask', question: 'Which repository holds the API?', from: 'teammate' })
    expect(h!.needInput).toHaveBeenCalledWith([{ id: TEAMMATE_NEEDS_ID, question: 'Which repository holds the API?' }])
    // A device's question keeps its own id.
    const other = setup('running')
    await moveTurn(other.db as never, other.s, { type: 'ask', question: 'Which branch?' })
    expect(other.h!.needInput).toHaveBeenCalledWith([{ id: 'local-agent-ask', question: 'Which branch?' }])
  })

  it('a step leaves the question to its teammate standing, and resumes any other parked turn', async () => {
    const { db, s, h } = setup('needs_input')
    parked(db, TEAMMATE_NEEDS_ID)
    await moveTurn(db as never, s, { type: 'step', text: 'Reading src/app.ts' })
    expect(h!.resume).not.toHaveBeenCalled()
    expect(h!.step).not.toHaveBeenCalled()
    parked(db, INTERRUPTED_NEEDS_ID)
    await moveTurn(db as never, s, { type: 'step', text: 'Reading src/app.ts' })
    expect(h!.resume).toHaveBeenCalledTimes(1)
    expect(h!.step).toHaveBeenCalledWith('Reading src/app.ts')
  })

  it('asks over a turn parked on something else (its Mac app closed), but a device question there changes nothing', async () => {
    const { db, s, h } = setup('needs_input')
    parked(db, INTERRUPTED_NEEDS_ID)
    await moveTurn(db as never, s, { type: 'ask', question: 'Which repo?' })
    expect(h!.resume).not.toHaveBeenCalled()
    expect(h!.needInput).not.toHaveBeenCalled()
    await moveTurn(db as never, s, { type: 'ask', question: 'Which repo?', from: 'teammate' })
    expect(h!.resume).toHaveBeenCalledTimes(1)
    expect(h!.needInput).toHaveBeenCalledWith([{ id: TEAMMATE_NEEDS_ID, question: 'Which repo?' }])
  })

  it('a turn end leaves the question to its teammate standing, and finishes any other open turn', async () => {
    const { db, s, h } = setup('needs_input')
    parked(db, TEAMMATE_NEEDS_ID)
    await moveTurn(db as never, s, { type: 'turn_end', summary: 'Done.' })
    expect(h!.finish).not.toHaveBeenCalled()
    parked(db, 'local-agent-ask')
    await moveTurn(db as never, s, { type: 'turn_end', summary: 'Done.' })
    expect(h!.finish).toHaveBeenCalledTimes(1)
  })

  it('reads a row parked on it, and nothing else', () => {
    const q = (id: string) => ({ kind: 'input' as const, questions: [{ id, question: 'q' }] })
    expect(isTeammateQuestion({ status: 'needs_input', needs: q(TEAMMATE_NEEDS_ID) })).toBe(true)
    expect(isTeammateQuestion({ status: 'needs_input', needs: q('local-agent-ask') })).toBe(false)
    expect(isTeammateQuestion({ status: 'running', needs: q(TEAMMATE_NEEDS_ID) })).toBe(false)
    expect(isTeammateQuestion({ status: 'needs_input', needs: null })).toBe(false)
    expect(isTeammateQuestion(null)).toBe(false)
  })

  it('keeps the teammate tools out of the step lines', () => {
    expect([...LEDGER_SILENT_TOOLS].sort()).toEqual(['message_teammate', 'report_to_person'])
  })
})
