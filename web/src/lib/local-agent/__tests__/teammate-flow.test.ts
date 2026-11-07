/**
 * The Mac body's question to its teammate, end to end through the real store,
 * device ingest and ledger (teammate plan C4). Only the work recorder is
 * faked, and its rows move status the way the recorder's would, so the
 * interplay the unit tests mock (the device's uploads around a question the
 * server recorded, the answer, the next turn) is exercised here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
const work = vi.hoisted(() => {
  const state = { db: null as null | { tables: Record<string, Row[]> } }
  const rowOf = (id: string) => state.db!.tables.tracked_job.find((r) => r.id === id)!
  const handle = (id: string) => ({
    id,
    step: vi.fn(async (text: string) => void Object.assign(rowOf(id), { status: 'running', current_step: text })),
    flush: vi.fn(async () => undefined),
    beat: vi.fn(async () => undefined),
    needInput: vi.fn(async (questions: unknown[]) => void Object.assign(rowOf(id), { status: 'needs_input', needs: { kind: 'input', questions } })),
    resume: vi.fn(async () => void Object.assign(rowOf(id), { status: 'running', needs: null })),
    finish: vi.fn(async (o: { summary: string | null; review?: unknown }) => void Object.assign(rowOf(id), { status: o.review ? 'needs_review' : 'done', result_summary: o.summary, needs: null })),
    fail: vi.fn(async () => void Object.assign(rowOf(id), { status: 'failed' })),
    cancel: vi.fn(async () => void Object.assign(rowOf(id), { status: 'canceled' })),
  })
  return {
    state,
    startWork: vi.fn(async (_svc: unknown, input: { runKey: string; status: string; title: string }) => {
      const id = `job:${input.runKey}`
      const rows = state.db!.tables.tracked_job
      if (!rows.some((r) => r.id === id)) rows.push({ id, status: input.status, run_key: input.runKey, title: input.title, needs: null })
      return handle(id)
    }),
    attachWork: vi.fn((_svc: unknown, row: { id: string }) => handle(row.id)),
  }
})
vi.mock('@/lib/work/recorder', () => ({ startWork: work.startWork, attachWork: work.attachWork }))
vi.mock('@/lib/work/agent-run-mirror', () => ({ resolveMemberId: async () => 'member-1' }))
vi.mock('@/lib/work/system-teammates', () => ({ systemTeammateId: async () => 'teammate-assistant' }))

import { addMessage, askTeammate, createSession } from '../store'
import { LOOP_MESSAGE_EXPIRED, claimSession, ingestEvents, pendingFor } from '../device'
import { CONV, DEVICE, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

let db: FakeDb
let sid: string
let seq = 0
const session = () => db.tables.local_agent_session.find((s) => s.id === sid)!
const turns = () => db.tables.tracked_job.map((r) => ({ turn: (r.run_key as string).split(':').at(-1), status: r.status }))
const upload = (run: string, ...events: Array<Record<string, unknown>>) =>
  ingestEvents(db as never, USER, sid, { runId: run, events: events.map((event) => ({ seq: ++seq, event: event as never })) })

beforeEach(async () => {
  seq = 0
  db = seeded({ tracked_job: [] })
  work.state.db = db as never
  const { session: s } = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Find the model choice', mode: 'read', startedBy: 'agent' })
  sid = s.id
  await claimSession(db as never, USER, sid, { deviceId: DEVICE, runId: 'run-1' })
  await upload('run-1', { kind: 'status', status: 'running' })
})

const ask = () => askTeammate(db as never, { userId: USER, workspaceId: WS, sessionId: sid, text: 'Which repo has it?', key: 'k1' })

describe('message_teammate, end to end', () => {
  it('asks, the turn ends on it (with or without finish), the answer resumes it and its turn reports at its end', async () => {
    await upload('run-1', { kind: 'tool', callId: 'c0', name: 'grep', input: '{"pattern":"model"}' })
    await ask()
    expect(turns()).toEqual([{ turn: '1', status: 'needs_input' }])
    // The call's own events, a finish the model added anyway, then the turn's end.
    await upload(
      'run-1',
      { kind: 'tool', callId: 'c1', name: 'message_teammate', input: '{"text":"Which repo has it?"}' },
      { kind: 'tool_result', callId: 'c1', name: 'message_teammate', ok: true, output: '{"status":"sent"}' },
      { kind: 'finish', summary: 'Asked Dial8.' },
      { kind: 'status', status: 'waiting' },
    )
    expect(session()).toMatchObject({ status: 'waiting', last_signal: 'ask', last_signal_text: 'Which repo has it?' })
    expect(turns()).toEqual([{ turn: '1', status: 'needs_input' }])

    // The cloud body answers from its home turn.
    await addMessage(db as never, { userId: USER, sessionId: sid, author: 'agent', text: 'The desktop repo.', policy: 'steer' })
    expect(session().last_signal).toBeNull()
    expect(turns()).toEqual([{ turn: '1', status: 'running' }])

    // The Mac takes it as its next turn and finishes: that turn reports.
    await upload('run-1', { kind: 'status', status: 'running' }, { kind: 'tool', callId: 'c2', name: 'read_file', input: '{"path":"x"}' })
    await upload('run-1', { kind: 'finish', summary: 'It is in the desktop repo.' }, { kind: 'status', status: 'waiting' })
    expect(turns()).toEqual([{ turn: '1', status: 'done' }])
    expect(db.tables.tracked_job[0].result_summary).toBe('It is in the desktop repo.')
  })

  it('an answer that beats the turn’s end to the server still gets a turn of its own', async () => {
    await ask()
    // The Mac's turn ended, but its upload hasn't landed when the person answers.
    await addMessage(db as never, { userId: USER, sessionId: sid, author: 'person', text: 'The desktop repo.', policy: 'steer' })
    expect(db.tables.local_agent_message.at(-1)).toMatchObject({ policy: 'queue' })
    await upload('run-1', { kind: 'tool', callId: 'c1', name: 'message_teammate', input: '{}' }, { kind: 'status', status: 'waiting' })
    // Turn 1 settles at its end; turn 2 is the answer's, queued for the Mac.
    expect(turns()).toEqual([{ turn: '1', status: 'done' }, { turn: '2', status: 'queued' }])
    await upload('run-1', { kind: 'status', status: 'running' }, { kind: 'tool', callId: 'c2', name: 'read_file', input: '{"path":"x"}' })
    await upload('run-1', { kind: 'finish', summary: 'Found it.' }, { kind: 'status', status: 'waiting' })
    expect(turns()).toEqual([{ turn: '1', status: 'done' }, { turn: '2', status: 'done' }])
  })

  it('a late upload (the last turn’s end and this turn’s start) never wipes the question the server recorded', async () => {
    // The Mac ended a turn and started the next, asking Dial8 in it, before either status reached the server.
    await ask()
    expect(session()).toMatchObject({ status: 'running', last_signal: 'ask' })
    await upload(
      'run-1',
      { kind: 'status', status: 'waiting' },
      { kind: 'status', status: 'running' },
      { kind: 'tool', callId: 'c1', name: 'message_teammate', input: '{}' },
      { kind: 'status', status: 'waiting' },
    )
    expect(session()).toMatchObject({ status: 'waiting', last_signal: 'ask', last_signal_text: 'Which repo has it?' })
    expect(turns()).toEqual([{ turn: '1', status: 'needs_input' }])
    // The answer still resumes it.
    await addMessage(db as never, { userId: USER, sessionId: sid, author: 'agent', text: 'The desktop repo.', policy: 'steer' })
    expect(turns()).toEqual([{ turn: '1', status: 'running' }])
  })

  it('a question the Mac asked itself doesn’t outlive the queued turn it runs next: that turn ends and reports', async () => {
    // The person queues a message while turn 1 runs; turn 1 ends on the Mac's own question.
    await addMessage(db as never, { userId: USER, sessionId: sid, author: 'person', text: 'Then read the README.', policy: 'queue' })
    await upload('run-1', { kind: 'ask', question: 'Which repo?' }, { kind: 'status', status: 'waiting' })
    expect(session()).toMatchObject({ status: 'waiting', last_signal: 'ask', last_signal_text: 'Which repo?' })
    expect(turns().at(-1)).toEqual({ turn: '1', status: 'needs_input' })
    // The Mac runs the queued message next (no new message reaches the server): it ends as a turn.
    await upload('run-1', { kind: 'status', status: 'running' }, { kind: 'finish', summary: 'Read the README.' }, { kind: 'status', status: 'waiting' })
    expect(session()).toMatchObject({ status: 'waiting', last_signal: 'finish', last_signal_text: 'Read the README.' })
    expect(turns().at(-1)).toMatchObject({ status: 'done' })
    expect(db.tables.tracked_job.at(-1)!.result_summary).toBe('Read the README.')
  })

  it('an older run’s question, stored late (a gap-fill after a restart), doesn’t make the teammate question read as the Mac’s own', async () => {
    await ask()
    await upload('run-0', { kind: 'ask', question: 'An old question?' })
    expect(db.tables.local_agent_event.filter((e) => e.kind === 'ask').map((e) => e.source)).toEqual(['server', 'device'])
    await upload('run-1', { kind: 'finish', summary: 'Asked Dial8.' }, { kind: 'status', status: 'waiting' })
    expect(session()).toMatchObject({ status: 'waiting', last_signal: 'ask', last_signal_text: 'Which repo has it?' })
    expect(turns()).toEqual([{ turn: '1', status: 'needs_input' }])
  })

  it('a retried call finds its turn parked on the question already and parks it once', async () => {
    await ask()
    const touched = work.attachWork.mock.calls.length
    expect(await ask()).toMatchObject({ duplicate: true })
    expect(work.attachWork.mock.calls.length).toBe(touched)
    expect(turns()).toEqual([{ turn: '1', status: 'needs_input' }])
    expect(db.tables.local_agent_event.filter((e) => e.kind === 'ask')).toHaveLength(1)
  })

  it('after a relaunch, the Mac’s own question isn’t mistaken for an old, answered teammate question: its next turn ends (#900 review 3)', async () => {
    await ask()
    await upload('run-1', { kind: 'status', status: 'waiting' })
    await addMessage(db as never, { userId: USER, sessionId: sid, author: 'agent', text: 'The desktop repo.', policy: 'steer' })
    // Turn 1 resumes and ends on the Mac's own question.
    await upload('run-1', { kind: 'status', status: 'running' }, { kind: 'ask', question: 'Should I open a pull request?' }, { kind: 'status', status: 'waiting' })
    expect(session()).toMatchObject({ last_signal: 'ask', last_signal_text: 'Should I open a pull request?' })
    // The Mac relaunches (a new run takes the job), and runs its next turn.
    session().run_id = 'run-2'
    await upload('run-2', { kind: 'status', status: 'running' }, { kind: 'finish', summary: 'Opened it.' }, { kind: 'status', status: 'waiting' })
    expect(session()).toMatchObject({ status: 'waiting', last_signal: 'finish', last_signal_text: 'Opened it.' })
    expect(turns().at(-1)).toMatchObject({ status: 'done' })
  })

  it('two questions asked at once may land in either order: the open one still outlives a late upload (review of the #900 follow-up, 4)', async () => {
    await askTeammate(db as never, { userId: USER, workspaceId: WS, sessionId: sid, text: 'Which repo?', key: 'k1' })
    await askTeammate(db as never, { userId: USER, workspaceId: WS, sessionId: sid, text: 'Which branch?', key: 'k2' })
    // The first call's write landed last: the session holds its words, the newest server ask is the second's.
    Object.assign(session(), { last_signal_text: 'Which repo?' })
    await upload('run-1', { kind: 'status', status: 'waiting' }, { kind: 'status', status: 'running' }, { kind: 'status', status: 'waiting' })
    expect(session()).toMatchObject({ last_signal: 'ask', last_signal_text: 'Which repo?' })
  })

  it('the Mac body’s own tool calls never resume the turn it parked', async () => {
    await ask()
    await upload('run-1', { kind: 'tool', callId: 'c1', name: 'read_file', input: '{"path":"a"}' }, { kind: 'tool', callId: 'c2', name: 'report_to_person', input: '{}' })
    expect(turns()).toEqual([{ turn: '1', status: 'needs_input' }])
  })
})

describe('a start that joins a job no Mac has claimed yet', () => {
  it('gets a turn of its own, which reports when it ends', async () => {
    db = seeded({ tracked_job: [] })
    work.state.db = db as never
    seq = 0
    const first = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Map the app', mode: 'read', startedBy: 'agent' })
    sid = first.session.id
    // A second start from the same chat before the Mac picked the first up: it joins.
    const joined = await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Then list the routes', mode: 'read', startedBy: 'agent' })
    expect(joined.joined).toBe(true)
    expect(session()).toMatchObject({ status: 'queued', pending_turn_text: 'Then list the routes' })
    // The Mac claims it, runs the request, then the joined one as its next turn.
    await claimSession(db as never, USER, sid, { deviceId: DEVICE, runId: 'run-1' })
    await upload('run-1', { kind: 'status', status: 'running' }, { kind: 'finish', summary: 'Mapped.' }, { kind: 'status', status: 'waiting' })
    expect(turns()).toEqual([{ turn: '1', status: 'done' }, { turn: '2', status: 'queued' }])
    await upload('run-1', { kind: 'status', status: 'running' }, { kind: 'tool', callId: 'c1', name: 'grep', input: '{}' }, { kind: 'finish', summary: 'Twelve routes.' }, { kind: 'status', status: 'waiting' })
    expect(turns()).toEqual([{ turn: '1', status: 'done' }, { turn: '2', status: 'done' }])
  })
})

describe('a loop’s request that joined its job, and a Mac that slept (C)', () => {
  const key = (fire: string) => `local-agent-loop:f1:step:a1:fire:${fire}`
  const start = (request: string, fire: string) =>
    createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request, mode: 'read', startedBy: 'agent', idempotencyKey: key(fire) })

  beforeEach(async () => {
    db = seeded({ tracked_job: [] })
    work.state.db = db as never
    seq = 0
    sid = (await start('Nightly check', 'k1')).session.id
    await claimSession(db as never, USER, sid, { deviceId: DEVICE, runId: 'run-1' })
  })

  it('is dropped after 15 minutes, never run later: the message fails, the thread says so, and the turn opened for it fails', async () => {
    await upload('run-1', { kind: 'status', status: 'running' }, { kind: 'finish', summary: 'Checked.' }, { kind: 'status', status: 'waiting' })
    expect((await start('Nightly check again', 'k2')).joined).toBe(true)
    expect(turns()).toEqual([{ turn: '1', status: 'done' }, { turn: '2', status: 'queued' }])
    // The Mac slept; it asks what to do 16 minutes on.
    const msg = db.tables.local_agent_message[0]
    msg.created_at = new Date(Date.now() - 16 * 60_000).toISOString()
    expect((await pendingFor(db as never, USER, DEVICE)).messages).toEqual([])
    expect(msg).toMatchObject({ status: 'failed', error: LOOP_MESSAGE_EXPIRED })
    expect(db.tables.local_agent_event.at(-1)).toMatchObject({ source: 'server', kind: 'error', payload: expect.objectContaining({ messageId: msg.id }) })
    expect(turns()).toEqual([{ turn: '1', status: 'done' }, { turn: '2', status: 'failed' }])
  })

  it('queued behind a running turn, it no longer opens one; within 15 minutes, or a person’s at any age, it’s delivered', async () => {
    await upload('run-1', { kind: 'status', status: 'running' })
    expect((await start('Nightly check again', 'k2')).joined).toBe(true)
    expect(session().pending_turn_text).toBe('Nightly check again')
    const msg = db.tables.local_agent_message[0]
    msg.created_at = new Date(Date.now() - 16 * 60_000).toISOString()
    await pendingFor(db as never, USER, DEVICE)
    expect(msg.status).toBe('failed')
    expect(session().pending_turn_text ?? null).toBeNull()
    // The turn running is the Mac's own: untouched.
    expect(turns()).toEqual([{ turn: '1', status: 'running' }])

    // Fresh, it's delivered; and a person's message is never dropped for its age.
    await start('Third check', 'k3')
    await addMessage(db as never, { userId: USER, sessionId: sid, author: 'person', text: 'Also the README', policy: 'queue' })
    const person = db.tables.local_agent_message.at(-1)!
    person.created_at = new Date(Date.now() - 60 * 60_000).toISOString()
    // Oldest first: the person's hour-old message, then the fresh loop request.
    expect((await pendingFor(db as never, USER, DEVICE)).messages.map((m) => m.text)).toEqual(['Also the README', 'Third check'])
  })
})

describe('a job’s turn row, as far as idleness goes (review of the #900 follow-up, 3)', () => {
  const OTHER_CONV = '55555555-5555-4555-8555-555555555556'
  beforeEach(async () => {
    db.tables.chat_conversations.push({ id: OTHER_CONV, user_id: USER, workspace_id: WS })
    await upload('run-1', { kind: 'finish', summary: 'Found it.' }, { kind: 'status', status: 'waiting' })
    expect(turns()).toEqual([{ turn: '1', status: 'done' }])
    session().updated_at = new Date(Date.now() - 60_000).toISOString()
  })
  const another = () => createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: OTHER_CONV, request: 'Map the app', mode: 'read', startedBy: 'agent' })

  it('a pruned turn row (the session never depends on it) leaves the job idle by its own state: another start ends it', async () => {
    db.tables.tracked_job = []
    expect((await another()).created).toBe(true)
    expect(session().status).toBe('cancelled')
  })

  it('a turn row that can’t be read keeps it busy', async () => {
    const realFrom = db.from
    db.from = ((table: string) => {
      const q = realFrom(table) as Record<string, unknown>
      if (table === 'tracked_job') q.maybeSingle = async () => ({ data: null, error: { message: 'timeout' } })
      return q
    }) as typeof db.from
    await expect(another()).rejects.toMatchObject({ details: expect.objectContaining({ code: 'FOLDER_BUSY' }) })
    expect(session().status).toBe('waiting')
  })
})

