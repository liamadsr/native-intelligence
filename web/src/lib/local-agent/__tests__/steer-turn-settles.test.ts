/**
 * The DEV e2e's C1-C5 (scripts/local-agent/e2e-dev.ts) on the in-memory
 * database, with the real store, device and ledger and a stand-in work
 * recorder: a chat-started READ job, claimed and running, takes a person's
 * steer mid-turn, then finishes. The session goes waiting with the finish,
 * and its turn row settles (done): the turn the chat created, never a second
 * one the steer could have opened.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

const work = vi.hoisted(() => {
  const state = { db: null as null | { tables: Record<string, Row[]> } }
  const rowOf = (id: string) => state.db!.tables.tracked_job.find((r) => r.id === id)!
  const handleFor = (id: string) => ({
    id,
    step: vi.fn(async () => {
      if (rowOf(id).status === 'queued') rowOf(id).status = 'running'
    }),
    flush: vi.fn(async () => undefined),
    beat: vi.fn(async () => undefined),
    needInput: vi.fn(async () => {
      rowOf(id).status = 'needs_input'
    }),
    resume: vi.fn(async () => {
      rowOf(id).status = 'running'
    }),
    finish: vi.fn(async (args: { review?: unknown }) => {
      rowOf(id).status = args?.review ? 'needs_review' : 'done'
    }),
    fail: vi.fn(async () => {
      rowOf(id).status = 'failed'
    }),
    cancel: vi.fn(async () => {
      rowOf(id).status = 'canceled'
    }),
  })
  return {
    state,
    startWork: vi.fn(async (_svc: unknown, input: { runKey: string; status: string; title: string }) => {
      const id = `job:${input.runKey}`
      const rows = state.db!.tables.tracked_job
      if (!rows.some((r) => r.id === id)) rows.push({ id, status: input.status, run_key: input.runKey, title: input.title })
      return handleFor(id)
    }),
    attachWork: vi.fn((_svc: unknown, row: { id: string }) => handleFor(row.id)),
  }
})
vi.mock('@/lib/work/recorder', () => ({ startWork: work.startWork, attachWork: work.attachWork }))
vi.mock('@/lib/work/agent-run-mirror', () => ({ resolveMemberId: async () => 'member-1' }))
vi.mock('@/lib/work/system-teammates', () => ({ systemTeammateId: async () => 'teammate-assistant' }))

import { ackMessage, claimSession, ingestEvents, parseEventUpload, parseStateUpdate, updateState } from '../device'
import { addMessage, createSession } from '../store'
import { CONV, DEVICE, USER, WS, fakeDb, type FakeDb } from './fake-db'

const READ_FOLDER = '66666666-6666-4666-8666-666666666667'
const CHAT_KEY = `local-agent:${CONV}:session:wrun_s1:turn:turn-1:call:call-1`

let db: FakeDb
beforeEach(() => {
  db = fakeDb({
    user_device: [{ user_id: USER, id: DEVICE, name: 'E2E Mac', platform: 'macos', app_version: '0.2.94', last_seen_at: new Date().toISOString() }],
    device_folder: [{ id: READ_FOLDER, user_id: USER, device_id: DEVICE, grant_id: 'g-read', label: 'e2e-read-folder', path: '/tmp/e2e', mode: 'read', is_git: false, revoked_at: null }],
    chat_conversations: [{ id: CONV, user_id: USER, workspace_id: WS }],
    tracked_job: [],
  })
  work.state.db = db as never
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

const upload = (seqs: Array<[number, Record<string, unknown>]>) => parseEventUpload({ runId: 'run-1', events: seqs.map(([seq, event]) => ({ seq, event })) })
const session = () => db.tables.local_agent_session[0]
const turnRow = () => db.tables.tracked_job.find((r) => r.id === (session().current_tracked_job_id ?? session().tracked_job_id))

describe('a steer mid-turn, then the finish: the turn row settles (e2e C5)', () => {
  async function runningJob() {
    // C1: start_local_agent from a typed turn.
    const { session: s } = await createSession(db as never, {
      userId: USER, workspaceId: WS, folderId: READ_FOLDER, conversationId: CONV, request: 'Read README.md and report', mode: 'read', startedBy: 'agent', idempotencyKey: CHAT_KEY,
    })
    expect(turnRow()).toMatchObject({ status: 'queued' })
    // C2: the relay claims it, the launcher runs, the rebind lands.
    await claimSession(db as never, USER, s.id, { deviceId: DEVICE, runId: 'claim-1' })
    await updateState(db as never, USER, s.id, parseStateUpdate({ runId: 'run-1', previousRunId: 'claim-1' }))
    await ingestEvents(db as never, USER, s.id, upload([[1, { kind: 'status', status: 'running' }], [2, { kind: 'tool', callId: 'c1', name: 'read_file', input: '{"path":"README.md"}' }]]))
    expect(session()).toMatchObject({ status: 'running' })
    expect(turnRow()).toMatchObject({ status: 'running' })
    return s.id
  }

  it('one turn: the steer is part of it, and the finish settles it', async () => {
    const id = await runningJob()
    // C4: the person steers through the person route; the Mac takes it.
    const steer = await addMessage(db as never, { userId: USER, sessionId: id, author: 'person', text: 'Also count the files', policy: 'steer', idempotencyKey: 'person:req-1' })
    await ackMessage(db as never, USER, steer.messageId, { ok: true })
    expect(session()).toMatchObject({ current_turn: 1 })
    // C5: the Mac finishes the turn.
    await ingestEvents(db as never, USER, id, upload([
      [3, { kind: 'message', text: 'README says 42. There are 3 files.' }],
      [4, { kind: 'finish', summary: 'The answer is 42; 3 files.' }],
      [5, { kind: 'status', status: 'completed' }],
    ]))
    expect(session()).toMatchObject({ status: 'waiting', last_signal: 'finish', current_turn: 1 })
    expect(turnRow()).toMatchObject({ status: 'done' })
    expect(db.tables.tracked_job).toHaveLength(1)
  })

  it('the finish uploaded before the relay posts the status (the relay’s two paths in either order)', async () => {
    const id = await runningJob()
    const steer = await addMessage(db as never, { userId: USER, sessionId: id, author: 'person', text: 'Also count the files', policy: 'steer', idempotencyKey: 'person:req-1' })
    await ackMessage(db as never, USER, steer.messageId, { ok: true })
    // The relay's status sync lands first: waiting, from /state.
    await updateState(db as never, USER, id, parseStateUpdate({ runId: 'run-1', status: 'waiting' }))
    await ingestEvents(db as never, USER, id, upload([
      [3, { kind: 'finish', summary: 'The answer is 42; 3 files.' }],
      [4, { kind: 'status', status: 'completed' }],
    ]))
    expect(session()).toMatchObject({ status: 'waiting', current_turn: 1 })
    expect(turnRow()).toMatchObject({ status: 'done' })
  })
})
