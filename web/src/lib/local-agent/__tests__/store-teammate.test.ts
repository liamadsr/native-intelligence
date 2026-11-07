/**
 * The teammate plan's store changes (WS-C): one agent per folder, the Mac
 * body's teammate tools (message_teammate, report_to_person), and the pull
 * request and local-model records (migration 418).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown, _move?: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
  nextTurn: vi.fn(async (_svc: unknown, s: Record<string, unknown>) => ({ ...s, currentTurn: (s.currentTurn as number) + 1 })),
  turnStatus: vi.fn(async (): Promise<string | null> => 'running'),
  parkedOnTeammate: vi.fn(async (): Promise<boolean> => false),
  // isIdle's read, steered by the same knob: no turn id is 'none', a status turnStatus can't give is 'unknown'.
  turnState: vi.fn(async (_svc: unknown, s: { currentTrackedJobId?: string | null }): Promise<string> =>
    s.currentTrackedJobId ? ((await ledger.turnStatus()) ?? 'unknown') : 'none',
  ),
}))
vi.mock('../ledger', async (orig) => ({ ...(await orig<typeof import('../ledger')>()), ...ledger }))

import {
  FOLDER_BUSY_CODE,
  FOLDER_LIVE_INDEX,
  LOOP_EXPIRED_REASON,
  LOOP_QUEUED_TTL_MS,
  LocalAgentError,
  QUEUED_TTL_MS,
  SESSION_CHANGED_CODE,
  PERSON_WORD_CHARS,
  REPLACED_BY_LOOP_REASON,
  REPLACED_BY_THIS_CHAT_REASON,
  REPLACED_REASON,
  REPORTS_PER_HOUR,
  REPORT_CAP_CODE,
  TEAMMATE_CAP_CODE,
  TEAMMATE_MESSAGES_PER_DAY,
  TEAMMATE_MESSAGES_PER_HOUR,
  TEAMMATE_MESSAGES_PER_JOB,
  addMessage,
  addThreadReport,
  askTeammate,
  createSession,
  isAttendedSession,
  loadSession,
  macTeammateName,
  personWordsOf,
  pushWasAllowed,
  recordLocalModel,
  recordPullRequest,
  requestStop,
  sessionUsesLocalModel,
  toSessionRow,
  type DbSession,
} from '../store'
import { macCallerClass } from '../agent-access'
import { UNATTENDED_QUEUED_TTL_MS } from '../unattended'
import { EXPIRED_REASON } from '../ledger'
import { CONV, DEVICE, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

const OTHER_CONV = '55555555-5555-4555-8555-555555555556'
const base = { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Take a look at this repository', mode: 'read' as const, startedBy: 'agent' as const }

function db2(): FakeDb {
  const db = seeded()
  db.tables.chat_conversations.push({ id: OTHER_CONV, user_id: USER, workspace_id: WS })
  return db
}

const row = (db: FakeDb, id: string) => db.tables.local_agent_session.find((s) => s.id === id)!
/** Two loops' steps, by fire. */
const loopA = (fire: string) => `local-agent-loop:f1:step:a1:fire:${fire}`
const loopB = (fire: string) => `local-agent-loop:f2:step:b1:fire:${fire}`
/** Its turn ended with nothing open, a minute ago. */
const idle = (db: FakeDb, id: string) =>
  Object.assign(row(db, id), { status: 'waiting', run_id: 'r', last_signal: 'finish', updated_at: new Date(Date.now() - 60_000).toISOString() })
const moves = () => ledger.moveTurn.mock.calls.map((c) => c[2])

beforeEach(() => {
  for (const f of Object.values(ledger)) f.mockClear()
  ledger.turnStatus.mockResolvedValue('running')
  ledger.parkedOnTeammate.mockResolvedValue(false)
})

describe('one agent per folder', () => {
  it('a second start from the same chat becomes the live agent’s next turn (joined), once per retried key', async () => {
    const db = db2()
    const first = await createSession(db as never, base)
    const second = await createSession(db as never, { ...base, request: 'Now check the tests', idempotencyKey: 'k-2' })
    expect(second).toMatchObject({ created: false, joined: true })
    expect(second.session.id).toBe(first.session.id)
    expect(db.tables.local_agent_session).toHaveLength(1)
    expect(db.tables.local_agent_message).toEqual([expect.objectContaining({ session_id: first.session.id, author: 'agent', text: 'Now check the tests', policy: 'queue', idempotency_key: 'start:k-2' })])
    // eve retries the same call: still one message.
    const retry = await createSession(db as never, { ...base, request: 'Now check the tests', idempotencyKey: 'k-2' })
    expect(retry.joined).toBe(true)
    expect(db.tables.local_agent_message).toHaveLength(1)
  })

  it('an edit agent takes a read request; a read one working there refuses an edit, naming itself', async () => {
    const db = db2()
    const edit = await createSession(db as never, { ...base, mode: 'edit' })
    expect((await createSession(db as never, { ...base, request: 'Read the README' })).session.id).toBe(edit.session.id)

    const db3 = db2()
    const read = await createSession(db3 as never, base)
    Object.assign(row(db3, read.session.id), { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
    const err = await createSession(db3 as never, { ...base, mode: 'edit', request: 'Fix it' }).catch((e) => e)
    expect(err).toBeInstanceOf(LocalAgentError)
    expect(err.code).toBe('conflict')
    expect(err.details).toMatchObject({ code: FOLDER_BUSY_CODE, reason: 'read_only', session: expect.objectContaining({ id: read.session.id }) })
    expect(err.message).toContain('Dial8 on Liam’s MacBook is already working in dial8-website, read-only')
    expect(db3.tables.local_agent_session).toHaveLength(1)
  })

  it('another chat is refused while the agent works, asks or was interrupted', async () => {
    for (const state of [
      { status: 'queued' },
      { status: 'running', lease_expires_at: new Date(Date.now() + 60_000).toISOString() },
      { status: 'waiting', last_signal: 'ask', last_signal_text: 'Which branch?' },
      { status: 'waiting', pending_turn_text: 'and then this' },
      { status: 'interrupted', updated_at: new Date().toISOString() },
    ]) {
      const db = db2()
      const first = await createSession(db as never, base)
      Object.assign(row(db, first.session.id), { run_id: 'r', ...state })
      const err = await createSession(db as never, { ...base, conversationId: OTHER_CONV }).catch((e) => e)
      expect(err.details, JSON.stringify(state)).toMatchObject({ code: FOLDER_BUSY_CODE, reason: 'other_chat' })
      expect(err.message).toContain('for another chat')
      expect(row(db, first.session.id).status).toBe(state.status)
    }
  })

  it('another chat ends an idle agent quietly (its finished turn kept) and starts its own', async () => {
    const db = db2()
    ledger.turnStatus.mockResolvedValue('done')
    const old = await createSession(db as never, base)
    Object.assign(row(db, old.session.id), { status: 'waiting', run_id: 'r', last_signal: 'finish', last_signal_text: 'Done.' })
    ledger.moveTurn.mockClear()
    const next = await createSession(db as never, { ...base, conversationId: OTHER_CONV, request: 'Fix the login bug', mode: 'edit' })
    expect(next.created).toBe(true)
    expect(row(db, old.session.id)).toMatchObject({ status: 'cancelled', error: REPLACED_REASON })
    expect(row(db, next.session.id)).toMatchObject({ status: 'queued', conversation_id: OTHER_CONV, mode: 'edit' })
    // The idle one's settled turn is left alone, and the Mac hears about the stop.
    expect(moves()).toEqual([])
    expect(db.rings.map((r) => (r.msg as { payload: { reason: string; sessionId: string } }).payload)).toContainEqual({ reason: 'stop', sessionId: old.session.id })
  })

  it('a loop’s start never joins a session the person started, nor the other way round', async () => {
    const db = db2()
    const attended = await createSession(db as never, base)
    Object.assign(row(db, attended.session.id), { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
    const loop = await createSession(db as never, { ...base, idempotencyKey: 'local-agent-loop:f1:step:a1:fire:k1' }).catch((e) => e)
    expect(loop.details).toMatchObject({ code: FOLDER_BUSY_CODE, reason: 'other_chat' })
    expect(loop.message).toContain('for you in this chat')
    expect(db.tables.local_agent_message ?? []).toEqual([])

    const db3 = db2()
    const fromLoop = await createSession(db3 as never, { ...base, idempotencyKey: 'local-agent-loop:f1:step:a1:fire:k1' })
    Object.assign(row(db3, fromLoop.session.id), { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
    const typed = await createSession(db3 as never, { ...base, idempotencyKey: 'local-agent:c:session:s:turn:t:call:c' }).catch((e) => e)
    expect(typed.message).toContain('for one of your loops')
    // The same loop step firing again: the later fire is the live job's next turn.
    expect((await createSession(db3 as never, { ...base, idempotencyKey: 'local-agent-loop:f1:step:a1:fire:k2' })).joined).toBe(true)
    // Another loop (or another step) never joins it: its calls would be reviewed against this loop's words.
    const otherLoop = await createSession(db3 as never, { ...base, idempotencyKey: 'local-agent-loop:f2:step:a9:fire:k1' }).catch((e) => e)
    expect(otherLoop.details).toMatchObject({ code: FOLDER_BUSY_CODE, reason: 'other_chat' })
  })

  it('a loop ends the person’s idle session (nothing open), but never a busy one; the person’s start ends a loop’s idle one', async () => {
    const db = db2()
    ledger.turnStatus.mockResolvedValue('done')
    const person = await createSession(db as never, base)
    Object.assign(row(db, person.session.id), { status: 'waiting', run_id: 'r', last_signal: 'finish' })
    // Busy: a follow-up on its way to the Mac.
    db.tables.local_agent_message = [{ id: 'm1', session_id: person.session.id, user_id: USER, status: 'pending', text: 'and the tests', author: 'person', policy: 'queue' }]
    const refused = await createSession(db as never, { ...base, idempotencyKey: 'local-agent-loop:f1:step:a1:fire:k1' }).catch((e) => e)
    expect(refused.details).toMatchObject({ code: FOLDER_BUSY_CODE })
    expect(row(db, person.session.id).status).toBe('waiting')
    // Idle: the loop's job takes the folder (S6: else a finished job holds it for a day).
    db.tables.local_agent_message = []
    const loop = await createSession(db as never, { ...base, idempotencyKey: 'local-agent-loop:f1:step:a1:fire:k2' })
    expect(loop.created).toBe(true)
    // Its ended line says who took the folder: a loop.
    expect(row(db, person.session.id)).toMatchObject({ status: 'cancelled', error: REPLACED_BY_LOOP_REASON })

    const db3 = db2()
    const fromLoop = await createSession(db3 as never, { ...base, idempotencyKey: 'local-agent-loop:f1:step:a1:fire:k1' })
    Object.assign(row(db3, fromLoop.session.id), { status: 'waiting', run_id: 'r', last_signal: 'finish' })
    const typed = await createSession(db3 as never, base)
    expect(typed.created).toBe(true)
    // The person's start from the thread the loop reports in: this chat.
    expect(row(db3, fromLoop.session.id)).toMatchObject({ status: 'cancelled', error: REPLACED_BY_THIS_CHAT_REASON })
  })

  it('an agent is busy while a push the person allowed is still running (no pull request yet), and ended pushes still count as allowed', async () => {
    ledger.turnStatus.mockResolvedValue('needs_review')
    const db = db2()
    const s = await createSession(db as never, { ...base, mode: 'edit' })
    Object.assign(row(db, s.session.id), { status: 'waiting', run_id: 'r', last_signal: 'finish', branch: 'dial8/x' })
    const now = new Date().toISOString()
    db.tables.local_agent_event = [
      { id: 1, session_id: s.session.id, user_id: USER, source: 'device', kind: 'prompt', payload: { kind: 'prompt', id: 'p-1', prompt: 'push', state: 'asking' }, created_at: now },
      { id: 2, session_id: s.session.id, user_id: USER, source: 'device', kind: 'prompt', payload: { kind: 'prompt', id: 'p-1', prompt: 'push', state: 'allowed' }, created_at: now },
    ]
    expect(await pushWasAllowed(db as never, { id: s.session.id, user_id: USER })).toBe(true)
    await expect(createSession(db as never, { ...base, conversationId: OTHER_CONV })).rejects.toMatchObject({ details: { code: FOLDER_BUSY_CODE } })
    // Its pull request landed: idle again.
    db.tables.local_agent_event.push({ id: 3, session_id: s.session.id, user_id: USER, source: 'device', kind: 'pull_request', payload: { ok: true }, created_at: now })
    expect((await createSession(db as never, { ...base, conversationId: OTHER_CONV })).created).toBe(true)
    // A push the person said no to was never allowed.
    expect(await pushWasAllowed(db2() as never, { id: 'nope', user_id: USER })).toBe(false)
  })

  it('an agent is not idle while a message is on its way, its turn is open, or a push waits on the Mac', async () => {
    const waitingIn = async (db: FakeDb) => {
      const s = await createSession(db as never, base)
      Object.assign(row(db, s.session.id), { status: 'waiting', run_id: 'r', last_signal: 'finish', mode: 'edit', branch: 'dial8/x' })
      return s.session.id
    }
    // A follow-up the Mac hasn't taken yet.
    ledger.turnStatus.mockResolvedValue('done')
    const db = db2()
    const a = await waitingIn(db)
    db.tables.local_agent_message = [{ id: 'm1', session_id: a, user_id: USER, status: 'pending', text: 'and the tests', author: 'person', policy: 'queue' }]
    await expect(createSession(db as never, { ...base, conversationId: OTHER_CONV })).rejects.toMatchObject({ details: { code: FOLDER_BUSY_CODE } })
    expect(row(db, a).status).toBe('waiting')
    // Its ledger turn is still open (a queued next turn).
    ledger.turnStatus.mockResolvedValue('queued')
    const db3 = db2()
    const b = await waitingIn(db3)
    await expect(createSession(db3 as never, { ...base, conversationId: OTHER_CONV })).rejects.toMatchObject({ details: { code: FOLDER_BUSY_CODE } })
    expect(row(db3, b).status).toBe('waiting')
    // Its push waits on the Mac (an open native prompt), until that prompt's longest wait has passed.
    ledger.turnStatus.mockResolvedValue('needs_review')
    const db4 = db2()
    const c = await waitingIn(db4)
    db4.tables.local_agent_event = [{ id: 1, session_id: c, user_id: USER, source: 'device', kind: 'prompt', payload: { kind: 'prompt', id: 'p-1', prompt: 'push', state: 'asking' }, created_at: new Date().toISOString() }]
    await expect(createSession(db4 as never, { ...base, conversationId: OTHER_CONV })).rejects.toMatchObject({ details: { code: FOLDER_BUSY_CODE } })
    db4.tables.local_agent_event[0].created_at = new Date(Date.now() - 40 * 60_000).toISOString()
    expect((await createSession(db4 as never, { ...base, conversationId: OTHER_CONV })).created).toBe(true)
    expect(row(db4, c).status).toBe('cancelled')
  })

  it('every session has a conversation (its thread, where C1 puts its cards)', async () => {
    await expect(createSession(db2() as never, { ...base, conversationId: null })).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('an ended session holds nothing', async () => {
    const db = db2()
    const old = await createSession(db as never, base)
    Object.assign(row(db, old.session.id), { status: 'cancelled' })
    expect((await createSession(db as never, { ...base, conversationId: OTHER_CONV })).created).toBe(true)
  })

  it('a loop’s next fire never answers its job’s open question: FOLDER_BUSY, the question stands (A)', async () => {
    const db = db2()
    const job = await createSession(db as never, { ...base, idempotencyKey: loopA('k1') })
    // It asked (its teammate, or the person on the Mac: either way the person answers it, never a fire).
    Object.assign(row(db, job.session.id), { status: 'waiting', run_id: 'r', last_signal: 'ask', last_signal_text: 'Which branch?' })
    ledger.turnStatus.mockResolvedValue('needs_input')
    ledger.moveTurn.mockClear()
    const err = await createSession(db as never, { ...base, request: 'Run the nightly check', idempotencyKey: loopA('k2') }).catch((e) => e)
    expect(err).toBeInstanceOf(LocalAgentError)
    expect(err.details).toMatchObject({ code: FOLDER_BUSY_CODE, reason: 'asking', session: expect.objectContaining({ id: job.session.id }) })
    expect(err.message).toContain('is waiting on your answer')
    expect(row(db, job.session.id)).toMatchObject({ status: 'waiting', last_signal: 'ask', last_signal_text: 'Which branch?' })
    expect(db.tables.local_agent_message ?? []).toEqual([])
    expect(moves()).toEqual([])
    // The person's own start in their chat still answers their job's question.
    const db3 = db2()
    const mine = await createSession(db3 as never, base)
    Object.assign(row(db3, mine.session.id), { status: 'waiting', run_id: 'r', last_signal: 'ask', last_signal_text: 'Which branch?' })
    expect(await createSession(db3 as never, { ...base, request: 'Use main', idempotencyKey: 'k-typed' })).toMatchObject({ joined: true })
    expect(row(db3, mine.session.id).last_signal).toBeNull()
  })

  it('a join lands before another start ends the idle job: the other start finds it busy (B, one order)', async () => {
    const db = db2()
    ledger.turnStatus.mockResolvedValue('done')
    const job = await createSession(db as never, { ...base, idempotencyKey: loopA('k1') })
    idle(db, job.session.id)
    // No signal standing (a turn that ended without a finish): only its updated_at shows the join.
    row(db, job.session.id).last_signal = null
    // Loop B found the job idle; just before its ending lands, loop A's next fire joins it.
    let joined: unknown
    db.interleave(
      (q) => q.table === 'local_agent_session' && q.op === 'update' && (q.values as { status?: unknown }).status === 'cancelled',
      async () => void (joined = await createSession(db as never, { ...base, request: 'Again', idempotencyKey: loopA('k2') })),
    )
    const other = await createSession(db as never, { ...base, idempotencyKey: loopB('k1') }).catch((e) => e)
    expect(joined).toMatchObject({ joined: true, session: expect.objectContaining({ id: job.session.id }) })
    expect(other.details).toMatchObject({ code: FOLDER_BUSY_CODE, session: expect.objectContaining({ id: job.session.id }) })
    expect(row(db, job.session.id).status).toBe('waiting')
    expect(db.tables.local_agent_message).toEqual([expect.objectContaining({ session_id: job.session.id, status: 'pending', text: 'Again' })])
    expect(db.tables.local_agent_session).toHaveLength(1)
  })

  it('another start ends the idle job before a join lands: the join decides again, and the folder is busy (B, the other order)', async () => {
    const db = db2()
    ledger.turnStatus.mockResolvedValue('done')
    const job = await createSession(db as never, { ...base, idempotencyKey: loopA('k1') })
    idle(db, job.session.id)
    ledger.nextTurn.mockClear()
    // Loop A's fire is joining; just before its message lands, loop B ends the idle job and starts its own.
    let other: { session: { id: string } } | undefined
    db.interleave(
      (q) => q.table === 'local_agent_message' && q.op === 'insert',
      async () => void (other = await createSession(db as never, { ...base, idempotencyKey: loopB('k1') })),
    )
    const err = await createSession(db as never, { ...base, request: 'Again', idempotencyKey: loopA('k2') }).catch((e) => e)
    expect(other).toMatchObject({ created: true })
    expect(row(db, job.session.id)).toMatchObject({ status: 'cancelled', error: REPLACED_BY_LOOP_REASON })
    expect(err).toBeInstanceOf(LocalAgentError)
    expect(err.details).toMatchObject({ code: FOLDER_BUSY_CODE, reason: 'other_chat', session: expect.objectContaining({ id: other!.session.id }) })
    // Nothing of the join is left: no message, no inbound line, no turn opened on the ended job.
    expect(db.tables.local_agent_message ?? []).toEqual([])
    expect((db.tables.local_agent_event ?? []).filter((e) => e.kind === 'inbound')).toEqual([])
    expect(ledger.nextTurn).not.toHaveBeenCalled()
  })

  it('a Stop that lands as a fire joins: the join decides again, ends the stopped idle job and starts its own (B)', async () => {
    const db = db2()
    ledger.turnStatus.mockResolvedValue('done')
    const job = await createSession(db as never, { ...base, idempotencyKey: loopA('k1') })
    idle(db, job.session.id)
    db.interleave((q) => q.table === 'local_agent_message' && q.op === 'insert', () => requestStop(db as never, USER, job.session.id))
    const out = await createSession(db as never, { ...base, request: 'Again', idempotencyKey: loopA('k2') })
    expect(out).toMatchObject({ created: true })
    expect(out.session.id).not.toBe(job.session.id)
    expect(row(db, job.session.id)).toMatchObject({ status: 'cancelled' })
    expect(db.tables.local_agent_message ?? []).toEqual([])
  })

  it('a message to a job being stopped is refused and taken back; one the Mac merely moved on is decided again (B)', async () => {
    const db = db2()
    const s = await createSession(db as never, base)
    Object.assign(row(db, s.session.id), { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString(), stop_requested_at: new Date().toISOString() })
    await expect(addMessage(db as never, { userId: USER, sessionId: s.session.id, author: 'person', text: 'And the tests', policy: 'steer' })).rejects.toMatchObject({
      code: 'conflict',
      details: { code: SESSION_CHANGED_CODE },
    })
    expect(db.tables.local_agent_message ?? []).toEqual([])
    expect((db.tables.local_agent_event ?? []).filter((e) => e.kind === 'inbound')).toEqual([])
    // The Mac's turn ended between the read and the write: decided again on `waiting`, and sent.
    const db3 = db2()
    const t = await createSession(db3 as never, base)
    Object.assign(row(db3, t.session.id), { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
    db3.interleave(
      (q) => q.table === 'local_agent_session' && q.op === 'update' && 'updated_at' in (q.values as object),
      async () => void Object.assign(row(db3, t.session.id), { status: 'waiting' }),
    )
    await addMessage(db3 as never, { userId: USER, sessionId: t.session.id, author: 'person', text: 'And the tests', policy: 'queue' })
    expect(db3.tables.local_agent_message).toEqual([expect.objectContaining({ status: 'pending', text: 'And the tests' })])
    expect(row(db3, t.session.id).pending_turn_text ?? null).toBeNull()
  })

  it('a message the Mac takes before the session write lands is sent as decided: its turn opens, nothing queues behind it (B, review)', async () => {
    for (const taken of ['delivered', 'failed'] as const) {
      const db = db2()
      const s = await createSession(db as never, base)
      idle(db, s.session.id)
      ledger.turnStatus.mockResolvedValue('done')
      ledger.nextTurn.mockClear()
      // The Mac polls, takes the message and starts on it, all before the write.
      db.interleave(
        (q) => q.table === 'local_agent_session' && q.op === 'update' && 'updated_at' in (q.values as object),
        async () => {
          db.tables.local_agent_message[0].status = taken
          Object.assign(row(db, s.session.id), { status: 'running' })
        },
      )
      await addMessage(db as never, { userId: USER, sessionId: s.session.id, author: 'person', text: 'And the tests', policy: 'queue' })
      expect(row(db, s.session.id).pending_turn_text ?? null).toBeNull()
      // Delivered: the turn that runs it is opened, as decided on `waiting`. Failed: its ack reported it; no turn.
      if (taken === 'delivered') expect(ledger.nextTurn).toHaveBeenCalledWith(db, expect.objectContaining({ id: s.session.id }), { text: 'And the tests', status: 'queued' })
      else expect(ledger.nextTurn).not.toHaveBeenCalled()
      expect(db.tables.local_agent_message).toHaveLength(1)
    }
  })

  it('an agent whose turn row can’t be read is not idle: busy, never ended (B)', async () => {
    const db = db2()
    const job = await createSession(db as never, base)
    idle(db, job.session.id)
    ledger.turnStatus.mockResolvedValue(null)
    const err = await createSession(db as never, { ...base, idempotencyKey: loopA('k1') }).catch((e) => e)
    expect(err.details).toMatchObject({ code: FOLDER_BUSY_CODE })
    expect(row(db, job.session.id).status).toBe('waiting')
  })

  it('a loop step’s fire joins its job only in the same mode (F); a person’s read request still joins their edit job', async () => {
    const db = db2()
    const job = await createSession(db as never, { ...base, mode: 'edit', idempotencyKey: loopA('k1') })
    Object.assign(row(db, job.session.id), { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
    const err = await createSession(db as never, { ...base, mode: 'read', idempotencyKey: loopA('k2') }).catch((e) => e)
    expect(err.details).toMatchObject({ code: FOLDER_BUSY_CODE, reason: 'other_mode' })
    expect(err.message).toContain('with edits, and this asks for read-only')
    expect(db.tables.local_agent_message ?? []).toEqual([])
    const db3 = db2()
    const mine = await createSession(db3 as never, { ...base, mode: 'edit' })
    expect(await createSession(db3 as never, { ...base, request: 'Read the README', idempotencyKey: 'k-read' })).toMatchObject({ joined: true, session: expect.objectContaining({ id: mine.session.id }) })
  })

  it('a start that loses the folder race twice is FOLDER_BUSY, not a server error (F)', async () => {
    const db = db2()
    const realFrom = db.from
    db.from = ((table: string) => {
      const q = realFrom(table) as Record<string, unknown>
      if (table === 'local_agent_session') {
        q.insert = () => ({
          select: () => ({ maybeSingle: async () => ({ data: null, error: { code: '23505', message: `duplicate key value violates unique constraint "${FOLDER_LIVE_INDEX}"` } }) }),
        })
      }
      return q
    }) as typeof db.from
    const err = await createSession(db as never, base).catch((e) => e)
    expect(err).toBeInstanceOf(LocalAgentError)
    expect(err.details).toMatchObject({ code: FOLDER_BUSY_CODE, reason: 'changing' })
  })

  it('a loop’s join refuses a question asked between its read and its write: FOLDER_BUSY asking, the question stands (#900 review 1)', async () => {
    const db = db2()
    const job = await createSession(db as never, { ...base, idempotencyKey: loopA('k1') })
    Object.assign(row(db, job.session.id), { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
    ledger.moveTurn.mockClear()
    // The fire reads it running with nothing asked; the Mac's turn ends on its own question before the write.
    db.interleave(
      (q) => q.table === 'local_agent_session' && q.op === 'update' && 'updated_at' in (q.values as object),
      async () => void Object.assign(row(db, job.session.id), { status: 'waiting', last_signal: 'ask', last_signal_text: 'Which branch?' }),
    )
    const err = await createSession(db as never, { ...base, request: 'Run the nightly check', idempotencyKey: loopA('k2') }).catch((e) => e)
    expect(err.details).toMatchObject({ code: FOLDER_BUSY_CODE, reason: 'asking' })
    expect(row(db, job.session.id)).toMatchObject({ status: 'waiting', last_signal: 'ask', last_signal_text: 'Which branch?' })
    expect(db.tables.local_agent_message ?? []).toEqual([])
    expect(moves()).toEqual([])
  })

  it('a job whose turn was never recorded (the ledger write failed) is idle by its own state; one it can’t read is not (#900 review 2)', async () => {
    const db = db2()
    const job = await createSession(db as never, base)
    idle(db, job.session.id)
    row(db, job.session.id).current_tracked_job_id = null
    ledger.turnStatus.mockResolvedValue(null)
    const out = await createSession(db as never, { ...base, conversationId: OTHER_CONV })
    expect(out.created).toBe(true)
    expect(row(db, job.session.id)).toMatchObject({ status: 'cancelled', error: REPLACED_REASON })
  })

  it('a message to a live job that keeps changing under its write stays sent: never taken back, so never sent twice (#900 review 4)', async () => {
    const db = db2()
    const s = await createSession(db as never, base)
    Object.assign(row(db, s.session.id), { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
    // Every write it tries loses to the Mac moving the session on.
    for (const status of ['waiting', 'running', 'waiting']) {
      db.interleave(
        (q) => q.table === 'local_agent_session' && q.op === 'update' && 'updated_at' in (q.values as object),
        async () => void (row(db, s.session.id).status = status),
      )
    }
    const sent = await addMessage(db as never, { userId: USER, sessionId: s.session.id, author: 'person', text: 'And the tests', policy: 'queue' })
    expect(sent.messageId).toEqual(expect.any(String))
    expect(db.tables.local_agent_message).toEqual([expect.objectContaining({ id: sent.messageId, status: 'pending', text: 'And the tests' })])
    expect((db.tables.local_agent_event ?? []).filter((e) => e.kind === 'inbound')).toHaveLength(1)
  })

  it('a kept answer to a job that asks still closes its question and resumes its turn (review of the #900 follow-up, 2)', async () => {
    const db = db2()
    const s = await createSession(db as never, base)
    Object.assign(row(db, s.session.id), { status: 'waiting', run_id: 'r', last_signal: 'ask', last_signal_text: 'Which branch?' })
    ledger.turnStatus.mockResolvedValue('needs_input')
    ledger.moveTurn.mockClear()
    for (const status of ['running', 'waiting', 'running']) {
      db.interleave(
        (q) => q.table === 'local_agent_session' && q.op === 'update' && 'updated_at' in (q.values as object),
        async () => void (row(db, s.session.id).status = status),
      )
    }
    await addMessage(db as never, { userId: USER, sessionId: s.session.id, author: 'person', text: 'Use main.', policy: 'queue' })
    expect(db.tables.local_agent_message).toEqual([expect.objectContaining({ status: 'pending', text: 'Use main.' })])
    expect(row(db, s.session.id)).toMatchObject({ last_signal: null, last_signal_text: null })
    expect(moves()).toEqual([{ type: 'resume' }])
  })

  it('a retried fire whose request its job already holds is told it joined, even once the job asks (#900 review 5)', async () => {
    const db = db2()
    const job = await createSession(db as never, { ...base, idempotencyKey: loopA('k1') })
    Object.assign(row(db, job.session.id), { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
    const first = await createSession(db as never, { ...base, request: 'Again', idempotencyKey: loopA('k2') })
    expect(first.joined).toBe(true)
    Object.assign(row(db, job.session.id), { status: 'waiting', last_signal: 'ask', last_signal_text: 'Which branch?' })
    const retry = await createSession(db as never, { ...base, request: 'Again', idempotencyKey: loopA('k2') })
    expect(retry).toMatchObject({ joined: true, session: expect.objectContaining({ id: job.session.id }) })
    expect(db.tables.local_agent_message).toHaveLength(1)
  })

  it('an ending that loses to an unrelated write since the read decides again, and ends the job then (#900 review 6)', async () => {
    const db = db2()
    ledger.turnStatus.mockResolvedValue('done')
    const job = await createSession(db as never, base)
    idle(db, job.session.id)
    // A write that touches nothing else (the Mac's lease, a heartbeat) lands just before the ending.
    db.interleave(
      (q) => q.table === 'local_agent_session' && q.op === 'update' && (q.values as { status?: unknown }).status === 'cancelled',
      async () => void (row(db, job.session.id).updated_at = new Date().toISOString()),
    )
    const out = await createSession(db as never, { ...base, conversationId: OTHER_CONV })
    expect(out.created).toBe(true)
    expect(row(db, job.session.id)).toMatchObject({ status: 'cancelled', error: REPLACED_REASON })
  })

  it('a start that loses the race to the folder index decides again against the winner', async () => {
    const db = db2()
    // Another request's session landed between this one's check and its insert.
    const realFrom = db.from
    let raced = false
    db.from = ((table: string) => {
      const q = realFrom(table) as Record<string, unknown>
      if (table !== 'local_agent_session' || raced) return q
      const insert = q.insert as (v: unknown) => unknown
      q.insert = (v: unknown) => {
        raced = true
        db.tables.local_agent_session.push({ ...(v as Record<string, unknown>), id: '99999999-9999-4999-8999-999999999999', created_at: new Date().toISOString(), updated_at: new Date().toISOString(), current_turn: 1, last_signal: null, pending_turn_text: null, expires_at: new Date(Date.now() + 3600_000).toISOString() })
        return insert(v)
      }
      return q
    }) as typeof db.from
    const out = await createSession(db as never, base)
    expect(out).toMatchObject({ joined: true, created: false })
    expect(out.session.id).toBe('99999999-9999-4999-8999-999999999999')
  })
})

describe('a loop’s limits (C)', () => {
  it('a loop’s job asked again after its Mac went quiet waits 15 minutes in the queue, a person’s 6 hours', async () => {
    expect(LOOP_QUEUED_TTL_MS).toBe(UNATTENDED_QUEUED_TTL_MS)
    for (const [key, ttl] of [[loopA('k1'), LOOP_QUEUED_TTL_MS], [undefined, QUEUED_TTL_MS]] as const) {
      const db = db2()
      const s = await createSession(db as never, { ...base, ...(key ? { idempotencyKey: key } : {}) })
      Object.assign(row(db, s.session.id), { status: 'interrupted', run_id: 'r', lease_expires_at: null })
      ledger.turnStatus.mockResolvedValue('needs_input')
      expect((await addMessage(db as never, { userId: USER, sessionId: s.session.id, author: 'agent', text: 'Carry on', policy: 'queue' })).requeued).toBe(true)
      const wait = Date.parse(row(db, s.session.id).expires_at as string) - Date.now()
      expect(wait).toBeLessThanOrEqual(ttl)
      expect(wait).toBeGreaterThan(ttl - 60_000)
    }
  })

  it('a job no Mac claimed in time expires in its own words: a loop’s 15 minutes, a person’s 6 hours', async () => {
    for (const [key, words] of [[loopA('k1'), LOOP_EXPIRED_REASON], [undefined, EXPIRED_REASON]] as const) {
      const db = db2()
      const s = await createSession(db as never, { ...base, ...(key ? { idempotencyKey: key } : {}) })
      row(db, s.session.id).expires_at = new Date(Date.now() - 1000).toISOString()
      expect(await loadSession(db as never, USER, s.session.id)).toMatchObject({ status: 'expired', error: words })
      expect(moves().at(-1)).toEqual({ type: 'fail', message: words })
    }
  })
})

describe('the Mac body’s teammate tools', () => {
  async function running(db: FakeDb, patch: Record<string, unknown> = {}) {
    const { session } = await createSession(db as never, base)
    Object.assign(row(db, session.id), { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString(), ...patch })
    ledger.moveTurn.mockClear()
    return session.id
  }
  const ctx = (sessionId: string) => ({ userId: USER, workspaceId: WS, sessionId })

  it('message_teammate: the question goes in the thread, becomes the open question and parks the turn on it, once per key', async () => {
    const db = seeded()
    const id = await running(db)
    await askTeammate(db as never, { ...ctx(id), text: 'Which repository holds the API?', key: 'k1' })
    expect(row(db, id)).toMatchObject({ status: 'running', last_signal: 'ask', last_signal_text: 'Which repository holds the API?' })
    expect(moves()).toEqual([{ type: 'ask', question: 'Which repository holds the API?', from: 'teammate' }])
    const events = db.tables.local_agent_event.filter((e) => e.session_id === id)
    expect(events).toEqual([expect.objectContaining({ source: 'server', kind: 'ask', payload: { question: 'Which repository holds the API?', via: 'message_teammate', key: 'k1' } })])
    // A retry of the same call (its turn parked on it now) does nothing more.
    ledger.parkedOnTeammate.mockResolvedValue(true)
    expect(await askTeammate(db as never, { ...ctx(id), text: 'Which repository holds the API?', key: 'k1' })).toMatchObject({ duplicate: true })
    expect(db.tables.local_agent_event.filter((e) => e.session_id === id)).toHaveLength(1)
    expect(moves()).toHaveLength(1)
  })

  it('a call on an idle or interrupted row is proof of life: running again, with a lease', async () => {
    for (const status of ['waiting', 'interrupted']) {
      const db = seeded()
      const id = await running(db, { status, lease_expires_at: null })
      await askTeammate(db as never, { ...ctx(id), text: 'Which branch?', key: `k-${status}` })
      expect(row(db, id).status).toBe('running')
      expect(Date.parse(row(db, id).lease_expires_at as string)).toBeGreaterThan(Date.now() + 60_000)
    }
  })

  it('the answer resumes the parked turn even while that turn winds down, and closes the question', async () => {
    const db = seeded()
    const id = await running(db)
    await askTeammate(db as never, { ...ctx(id), text: 'Which branch?', key: 'k1' })
    ledger.moveTurn.mockClear()
    ledger.turnStatus.mockResolvedValue('needs_input')
    await addMessage(db as never, { userId: USER, sessionId: id, author: 'agent', text: 'Use main.', policy: 'steer' })
    expect(moves()).toEqual([{ type: 'resume' }])
    expect(row(db, id)).toMatchObject({ last_signal: null, last_signal_text: null })
  })

  it('an answer that lands while the asking turn still reads as working goes as queue, and opens its own turn at that turn’s end', async () => {
    const db = seeded()
    const id = await running(db)
    await askTeammate(db as never, { ...ctx(id), text: 'Which branch?', key: 'k1' })
    ledger.moveTurn.mockClear()
    ledger.turnStatus.mockResolvedValue('needs_input')
    await addMessage(db as never, { userId: USER, sessionId: id, author: 'agent', text: 'Use main.', policy: 'steer' })
    expect(db.tables.local_agent_message.at(-1)).toMatchObject({ text: 'Use main.', policy: 'queue' })
    expect(db.tables.local_agent_event.at(-1)).toMatchObject({ kind: 'inbound', payload: expect.objectContaining({ policy: 'queue' }) })
    expect(row(db, id)).toMatchObject({ pending_turn_text: 'Use main.', last_signal: null })
    expect(moves()).toEqual([{ type: 'resume' }])
    // Once the turn has ended (waiting), an answer is an ordinary message.
    const db3 = seeded()
    const id3 = await running(db3, { status: 'waiting', last_signal: 'ask', last_signal_text: 'Which branch?' })
    await addMessage(db3 as never, { userId: USER, sessionId: id3, author: 'agent', text: 'Use main.', policy: 'steer' })
    expect(db3.tables.local_agent_message.at(-1)).toMatchObject({ policy: 'steer' })
    expect(row(db3, id3).pending_turn_text ?? null).toBeNull()
  })

  it('a question asked on a settled turn opens the next one, so it still reaches the chat', async () => {
    const db = seeded()
    const id = await running(db)
    ledger.turnStatus.mockResolvedValue('done')
    await askTeammate(db as never, { ...ctx(id), text: 'Which branch?', key: 'k1' })
    expect(ledger.nextTurn).toHaveBeenCalledWith(db, expect.objectContaining({ id }), { text: 'Which branch?', status: 'running' })
    expect(moves()).toEqual([{ type: 'ask', question: 'Which branch?', from: 'teammate' }])
    // An open turn carries it as it is.
    ledger.nextTurn.mockClear()
    ledger.turnStatus.mockResolvedValue('running')
    await askTeammate(db as never, { ...ctx(id), text: 'And the base?', key: 'k2' })
    expect(ledger.nextTurn).not.toHaveBeenCalled()
  })

  it('message_teammate is also capped per job in all, and per person per day; a refused call leaves no line behind', async () => {
    const db = seeded()
    const id = await running(db)
    const longAgo = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
    // 30 earlier asks on this job (spread out: under the hourly cap), then one more.
    db.tables.local_agent_event = Array.from({ length: TEAMMATE_MESSAGES_PER_JOB }, (_, i) => ({
      id: 1000 + i, session_id: id, user_id: USER, source: 'server', kind: 'ask', payload: { question: `q${i}`, via: 'message_teammate', key: `old${i}` }, created_at: longAgo,
    }))
    const err = await askTeammate(db as never, { ...ctx(id), text: 'One more?', key: 'k-more' }).catch((e) => e)
    expect(err.details).toEqual({ code: TEAMMATE_CAP_CODE })
    expect(err.message).toContain(`${TEAMMATE_MESSAGES_PER_JOB} times on this job`)
    expect(db.tables.local_agent_event).toHaveLength(TEAMMATE_MESSAGES_PER_JOB)
    // The person's day, across jobs.
    const db3 = seeded()
    const id3 = await running(db3)
    const recent = new Date(Date.now() - 2 * 60 * 60_000).toISOString()
    db3.tables.local_agent_event = Array.from({ length: TEAMMATE_MESSAGES_PER_DAY }, (_, i) => ({
      id: 2000 + i, session_id: `other-${i % 20}`, user_id: USER, source: 'server', kind: 'ask', payload: { question: `q${i}`, via: 'message_teammate', key: `d${i}` }, created_at: recent,
    }))
    const day = await askTeammate(db3 as never, { ...ctx(id3), text: 'Today?', key: 'k-day' }).catch((e) => e)
    expect(day.message).toContain(`${TEAMMATE_MESSAGES_PER_DAY} times today`)
    expect(row(db3, id3).last_signal).toBeNull()
  })

  it('a refused question is never written (the panel shows inserts live): the count and the insert are one step (419’s function)', async () => {
    const db = seeded()
    const id = await running(db)
    const rpc = vi.spyOn(db, 'rpc')
    for (let i = 0; i < TEAMMATE_MESSAGES_PER_HOUR; i++) await askTeammate(db as never, { ...ctx(id), text: `Question ${i}?`, key: `k${i}` })
    expect(rpc).toHaveBeenLastCalledWith('local_agent_teammate_ask', {
      p_session_id: id, p_user_id: USER, p_key: `k${TEAMMATE_MESSAGES_PER_HOUR - 1}`, p_question: `Question ${TEAMMATE_MESSAGES_PER_HOUR - 1}?`,
      p_per_hour: TEAMMATE_MESSAGES_PER_HOUR, p_per_job: TEAMMATE_MESSAGES_PER_JOB, p_per_day: TEAMMATE_MESSAGES_PER_DAY,
    })
    const before = db.writes.filter((w) => w.table === 'local_agent_event').length
    await expect(askTeammate(db as never, { ...ctx(id), text: 'One more?', key: 'k-more' })).rejects.toMatchObject({ details: { code: TEAMMATE_CAP_CODE } })
    // No insert, so no delete either: nothing reached the panel.
    expect(db.writes.filter((w) => w.table === 'local_agent_event').length).toBe(before)
  })

  it('a retry finishes what a crashed call left undone, unless the job moved past the question', async () => {
    // The question was recorded, then the server died before the session or the turn took it.
    const db = seeded()
    const id = await running(db)
    const recorded = (db.tables.local_agent_event ??= [])
    recorded.push({ id: 900, session_id: id, user_id: USER, source: 'server', kind: 'ask', payload: { question: 'Which branch?', via: 'message_teammate', key: 'k1' }, created_at: new Date().toISOString() })
    expect(await askTeammate(db as never, { ...ctx(id), text: 'Which branch?', key: 'k1' })).toMatchObject({ duplicate: true })
    expect(row(db, id)).toMatchObject({ last_signal: 'ask', last_signal_text: 'Which branch?' })
    expect(moves()).toEqual([{ type: 'ask', question: 'Which branch?', from: 'teammate' }])
    expect(db.tables.local_agent_event.filter((e) => e.session_id === id)).toHaveLength(1)
    // Answered since (a message reached the job): the retry changes nothing.
    const answered = seeded()
    const id2 = await running(answered)
    const earlier = (answered.tables.local_agent_event ??= [])
    earlier.push({ id: 901, session_id: id2, user_id: USER, source: 'server', kind: 'ask', payload: { question: 'Which branch?', via: 'message_teammate', key: 'k1' }, created_at: new Date(Date.now() - 5_000).toISOString() })
    const sent = (answered.tables.local_agent_message ??= [])
    sent.push({ id: 'm1', session_id: id2, user_id: USER, author: 'agent', text: 'Use main.', created_at: new Date().toISOString() })
    ledger.moveTurn.mockClear()
    await askTeammate(answered as never, { ...ctx(id2), text: 'Which branch?', key: 'k1' })
    expect(row(answered, id2).last_signal ?? null).toBeNull()
    expect(moves()).toEqual([])
    // A newer question since (either body's): the stale retry doesn't bring the old one back.
    const newer = seeded()
    const id3 = await running(newer)
    await askTeammate(newer as never, { ...ctx(id3), text: 'Which branch?', key: 'k1' })
    await askTeammate(newer as never, { ...ctx(id3), text: 'And the base?', key: 'k2' })
    ledger.moveTurn.mockClear()
    await askTeammate(newer as never, { ...ctx(id3), text: 'Which branch?', key: 'k1' })
    expect(row(newer, id3).last_signal_text).toBe('And the base?')
    expect(moves()).toEqual([])
  })

  it('a retry after the session lapsed (interrupted) brings it back and parks the turn; one after the turn ended leaves it', async () => {
    const ask = { id: 900, source: 'server', kind: 'ask', payload: { question: 'Which branch?', via: 'message_teammate', key: 'k1' }, created_at: new Date().toISOString() }
    // The original wrote the session, then died before the turn took it; the lease lapsed.
    const lapsed = seeded()
    const id = await running(lapsed, { status: 'interrupted', lease_expires_at: null, last_signal: 'ask', last_signal_text: 'Which branch?' })
    const events = (lapsed.tables.local_agent_event ??= [])
    events.push({ ...ask, session_id: id, user_id: USER })
    ledger.turnStatus.mockResolvedValue('needs_input') // parked on the interruption, not on the question
    await askTeammate(lapsed as never, { ...ctx(id), text: 'Which branch?', key: 'k1' })
    expect(row(lapsed, id).status).toBe('running')
    expect(Date.parse(row(lapsed, id).lease_expires_at as string)).toBeGreaterThan(Date.now())
    expect(moves()).toEqual([{ type: 'ask', question: 'Which branch?', from: 'teammate' }])
    // The Mac ended its turn on the question (waiting), and a late retry arrives: nothing changes.
    const ended = seeded()
    const id2 = await running(ended, { status: 'waiting', lease_expires_at: null, last_signal: 'ask', last_signal_text: 'Which branch?' })
    const endedEvents = (ended.tables.local_agent_event ??= [])
    endedEvents.push({ ...ask, session_id: id2, user_id: USER })
    ledger.parkedOnTeammate.mockResolvedValue(true)
    ledger.moveTurn.mockClear()
    await askTeammate(ended as never, { ...ctx(id2), text: 'Which branch?', key: 'k1' })
    expect(row(ended, id2).status).toBe('waiting')
    expect(moves()).toEqual([])
  })

  it('a call whose turn is parked on the same question already (a retry overlapping it) doesn’t park it twice; once the session holds it, a failure keeps the line', async () => {
    const db = seeded()
    const id = await running(db)
    ledger.parkedOnTeammate.mockResolvedValue(true)
    await askTeammate(db as never, { ...ctx(id), text: 'Which branch?', key: 'k1' })
    expect(row(db, id)).toMatchObject({ last_signal: 'ask', last_signal_text: 'Which branch?' })
    expect(moves()).toEqual([])
    // The session took it, then the ledger failed: the line stays for a retry to finish.
    const db2 = seeded()
    const id2 = await running(db2)
    ledger.parkedOnTeammate.mockResolvedValue(false)
    ledger.moveTurn.mockRejectedValueOnce(new Error('ledger down'))
    await expect(askTeammate(db2 as never, { ...ctx(id2), text: 'Which branch?', key: 'k1' })).rejects.toThrow('ledger down')
    expect(db2.tables.local_agent_event.filter((e) => e.session_id === id2)).toHaveLength(1)
    // Before the session took it (the job ended meanwhile), the line is taken back.
    const db3 = seeded()
    const id3 = await running(db3)
    const rpc = db3.rpc.bind(db3)
    db3.rpc = (async (name: string, args?: unknown) => {
      const out = await rpc(name, args)
      row(db3, id3).status = 'cancelled'
      return out
    }) as never
    await expect(askTeammate(db3 as never, { ...ctx(id3), text: 'Which branch?', key: 'k1' })).rejects.toMatchObject({ code: 'conflict' })
    expect((db3.tables.local_agent_event ?? []).filter((e) => e.session_id === id3)).toEqual([])
  })

  it('a job that ends between the read and the function’s lock takes no question (#900 review 7)', async () => {
    const db = seeded()
    const id = await running(db)
    const rpc = db.rpc.bind(db)
    db.rpc = (async (name: string, args?: unknown) => {
      row(db, id).status = 'cancelled'
      return rpc(name, args)
    }) as never
    await expect(askTeammate(db as never, { ...ctx(id), text: 'Which branch?', key: 'k1' })).rejects.toMatchObject({ code: 'conflict', message: expect.stringContaining('has ended') })
    expect((db.tables.local_agent_event ?? []).filter((e) => e.session_id === id)).toEqual([])
    expect(moves()).toEqual([])
  })

  it('before migration 419 (no function) it counts, then inserts: same caps, same once-per-key', async () => {
    const db = seeded()
    const id = await running(db)
    db.rpc = (async () => ({ data: null, error: { message: 'Could not find the function public.local_agent_teammate_ask', code: 'PGRST202' } })) as never
    for (let i = 0; i < TEAMMATE_MESSAGES_PER_HOUR; i++) await askTeammate(db as never, { ...ctx(id), text: `Question ${i}?`, key: `k${i}` })
    expect(db.tables.local_agent_event.filter((e) => e.session_id === id)).toHaveLength(TEAMMATE_MESSAGES_PER_HOUR)
    await expect(askTeammate(db as never, { ...ctx(id), text: 'One more?', key: 'k-more' })).rejects.toMatchObject({ details: { code: TEAMMATE_CAP_CODE } })
    expect(db.tables.local_agent_event.filter((e) => e.session_id === id)).toHaveLength(TEAMMATE_MESSAGES_PER_HOUR)
    ledger.parkedOnTeammate.mockResolvedValue(true)
    expect(await askTeammate(db as never, { ...ctx(id), text: `Question ${TEAMMATE_MESSAGES_PER_HOUR - 1}?`, key: `k${TEAMMATE_MESSAGES_PER_HOUR - 1}` })).toMatchObject({ duplicate: true })
    // Any other database error is an error, not a fallback.
    db.rpc = (async () => ({ data: null, error: { message: 'connection reset', code: '08006' } })) as never
    await expect(askTeammate(db as never, { ...ctx(id), text: 'x', key: 'k-x' })).rejects.toThrow('local agent question failed')
  })

  it('report_to_person is rate limited per job per hour', async () => {
    const db = seeded()
    const id = await running(db)
    for (let i = 0; i < REPORTS_PER_HOUR; i++) await addThreadReport(db as never, { ...ctx(id), text: `Note ${i}`, key: `r${i}` })
    await expect(addThreadReport(db as never, { ...ctx(id), text: 'One more', key: 'r-more' })).rejects.toMatchObject({ details: { code: REPORT_CAP_CODE } })
  })

  it('message_teammate is capped per job per hour: each one starts a paid cloud turn', async () => {
    const db = seeded()
    const id = await running(db)
    for (let i = 0; i < TEAMMATE_MESSAGES_PER_HOUR; i++) await askTeammate(db as never, { ...ctx(id), text: `Question ${i}?`, key: `k${i}` })
    const err = await askTeammate(db as never, { ...ctx(id), text: 'One more?', key: 'k-more' }).catch((e) => e)
    expect(err).toBeInstanceOf(LocalAgentError)
    expect(err.details).toEqual({ code: TEAMMATE_CAP_CODE })
    expect(err.message).toContain('Nothing was sent')
    expect(row(db, id).last_signal_text).toBe(`Question ${TEAMMATE_MESSAGES_PER_HOUR - 1}?`)
    // A retry of one already sent is still answered as sent.
    expect(await askTeammate(db as never, { ...ctx(id), text: 'Question 0?', key: 'k0' })).toMatchObject({ duplicate: true })
    // An hour on, it may ask again.
    for (const e of db.tables.local_agent_event) e.created_at = new Date(Date.now() - 61 * 60_000).toISOString()
    await expect(askTeammate(db as never, { ...ctx(id), text: 'Later?', key: 'k-later' })).resolves.toBeTruthy()
    // Reports don't count against it.
    expect(TEAMMATE_MESSAGES_PER_HOUR).toBe(6)
  })

  it('report_to_person: a note in its own thread, once per key', async () => {
    const db = seeded()
    const id = await running(db)
    await addThreadReport(db as never, { ...ctx(id), text: 'Found the auth middleware; reading its tests next.', key: 'r1' })
    await addThreadReport(db as never, { ...ctx(id), text: 'Found the auth middleware; reading its tests next.', key: 'r1' })
    expect(db.tables.local_agent_event.filter((e) => e.session_id === id)).toEqual([
      expect.objectContaining({ source: 'server', kind: 'report', payload: { text: 'Found the auth middleware; reading its tests next.', via: 'report_to_person', key: 'r1' } }),
    ])
    expect(moves()).toEqual([])
    expect(row(db, id).last_signal).toBeNull()
  })

  it('refuses another workspace’s or person’s session, an ended one, and empty text', async () => {
    const db = seeded()
    const id = await running(db)
    await expect(askTeammate(db as never, { ...ctx(id), workspaceId: '00000000-0000-4000-8000-000000000000', text: 'x', key: 'a' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(addThreadReport(db as never, { ...ctx(id), userId: '22222222-2222-4222-8222-222222222222', text: 'x', key: 'a' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(addThreadReport(db as never, { ...ctx(id), text: '  ', key: 'a' })).rejects.toMatchObject({ code: 'bad_request' })
    row(db, id).status = 'cancelled'
    await expect(askTeammate(db as never, { ...ctx(id), text: 'x', key: 'b' })).rejects.toMatchObject({ code: 'conflict' })
    expect((db.tables.local_agent_event ?? []).filter((e) => e.session_id === id)).toEqual([])
  })
})

describe('the reviewer’s evidence: the person’s words, kept at start and join (migration 418)', () => {
  it('a start keeps them on the session; a join and a typed turn’s message keep them on the message; the person’s own message carries none', async () => {
    const db = db2()
    const words = ['take a look at the repo', 'and fix the login bug']
    const first = await createSession(db as never, { ...base, personWords: words })
    expect(row(db, first.session.id).start_words).toEqual(words)
    await createSession(db as never, { ...base, request: 'Now the tests', personWords: ['check the tests too'] })
    expect(db.tables.local_agent_message.at(-1)).toMatchObject({ author: 'agent', person_words: ['check the tests too'] })
    await addMessage(db as never, { userId: USER, sessionId: first.session.id, author: 'person', text: 'stop after that', policy: 'queue', personWords: ['ignored'] })
    expect(db.tables.local_agent_message.at(-1)!.person_words ?? null).toBeNull()
  })

  it('cleans what the chat sends: strings, trimmed, the newest 3, each cut to 2,000 characters', () => {
    expect(personWordsOf(['a', ' ', 42, ' b ', 'c', 'd'])).toEqual(['b', 'c', 'd'])
    expect(personWordsOf(['x'.repeat(2500)])[0]).toHaveLength(PERSON_WORD_CHARS)
    expect(personWordsOf('nope')).toEqual([])
    expect(personWordsOf(undefined)).toEqual([])
  })

  it('a database without the column still starts the job (the reviewer then has no evidence, and holds)', async () => {
    const db = db2()
    const realFrom = db.from
    db.from = ((table: string) => {
      const q = realFrom(table) as Record<string, unknown>
      const update = q.update as (p: Record<string, unknown>) => unknown
      q.update = (p: Record<string, unknown>) => ('start_words' in p ? { eq: () => ({ eq: async () => ({ error: { message: 'column "start_words" does not exist' } }) }) } : update(p))
      return q
    }) as typeof db.from
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect((await createSession(db as never, { ...base, personWords: ['go'] })).created).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('the pull request and the local model (migration 418)', () => {
  it('keeps the pull request and the model, and reads them back on the row', async () => {
    const db = seeded()
    const { session } = await createSession(db as never, { ...base, mode: 'edit' })
    expect(await recordPullRequest(db as never, USER, session.id, 'https://github.com/o/r/pull/12')).toBe(true)
    await recordLocalModel(db as never, USER, session.id, true)
    const r = row(db, session.id) as unknown as DbSession
    expect(toSessionRow({ ...r, folder: null, device: null })).toMatchObject({ prUrl: 'https://github.com/o/r/pull/12', localModel: true })
    expect(sessionUsesLocalModel(r)).toBe(true)
    // Another person's session is untouched.
    expect(await recordPullRequest(db as never, '22222222-2222-4222-8222-222222222222', session.id, 'https://github.com/o/r/pull/13')).toBe(false)
  })

  it('a row from before the migration reads as no pull request, relay model', () => {
    const r = { id: 'x', status: 'waiting' } as unknown as DbSession
    expect(sessionUsesLocalModel(r)).toBe(false)
    expect(toSessionRow({ ...r, folder: null, device: null } as DbSession)).toMatchObject({ prUrl: null, localModel: false })
  })

  it('a missing column is logged, never thrown (the PR stays open, the claim goes on)', async () => {
    const failing = {
      from: () => ({
        update: () => ({
          eq: () => ({ eq: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'column "pr_url" does not exist' } }) }) }) }),
        }),
      }),
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(await recordPullRequest(failing as never, USER, 'id', 'https://github.com/o/r/pull/1')).toBe(false)
    const failing2 = { from: () => ({ update: () => ({ eq: () => ({ eq: async () => ({ error: { message: 'column "local_model" does not exist' } }) }) }) }) }
    await expect(recordLocalModel(failing2 as never, USER, 'id', true)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })
})

describe('who a job acts for (isAttendedSession)', () => {
  it('only on a positive marker, the same rule as C1’s caller class', () => {
    const cases: Array<[string, string | null]> = [
      ['person', null],
      ['agent', 'local-agent:c1:session:s1:turn:t1:call:x'],
      ['agent', 'local-agent-loop:f1:step:a1:fire:k1'],
      ['agent', null],
      ['agent', 'something-else'],
      ['loop', 'local-agent:c1:session:s1:turn:t1:call:x'],
    ]
    for (const [startedBy, key] of cases) {
      const attended = isAttendedSession({ started_by: startedBy as 'agent', idempotency_key: key })
      expect(attended, `${startedBy} ${key}`).toBe(macCallerClass(startedBy, key) === 'person_remote')
    }
    expect(isAttendedSession({ started_by: 'agent', idempotency_key: 'local-agent-loop:f1:step:a1:fire:k1' })).toBe(false)
  })

  it('a start from a typed chat turn is attended; a loop’s is not', async () => {
    const db = db2()
    const typed = await createSession(db as never, { ...base, idempotencyKey: 'local-agent:c:session:s:turn:t:call:c' })
    expect(typed.session.attended).toBe(true)
    const db3 = db2()
    const loop = await createSession(db3 as never, { ...base, idempotencyKey: 'local-agent-loop:f1:step:a1:fire:k1' })
    expect(loop.session.attended).toBe(false)
  })
})

describe('the teammate’s name', () => {
  it('is Dial8 on its Mac', () => {
    expect(macTeammateName('Liam’s MacBook Pro')).toBe('Dial8 on Liam’s MacBook Pro')
    expect(macTeammateName('  Studio\n Mac ')).toBe('Dial8 on Studio Mac')
    expect(macTeammateName('')).toBe('Dial8 on your Mac')
    expect(macTeammateName(null)).toBe('Dial8 on your Mac')
  })
})

void DEVICE
