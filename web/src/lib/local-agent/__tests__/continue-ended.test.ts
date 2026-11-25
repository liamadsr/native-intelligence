/**
 * Continuing an old coding chat (the owner, 11-25: "the chat still loads, so
 * … let the user continue the conversation"). The person's own message to a
 * chat that sat idle past its 24 h, or that they stopped, picks it up again
 * (store.ts reviveSession): back to `waiting`, the Mac resumes the same
 * session, and a fresh token comes only through the usual route. Every other
 * end stays ended, and the refusals that bound credentials stay: an ended row
 * gets no model token and passes no relay check. A revival the Mac refuses
 * ends the chat again with its reason (device.ts endRefusedRevival).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown, _move: { type: string; [k: string]: unknown }) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
  nextTurn: vi.fn(async (_svc: unknown, s: unknown, _o: unknown) => s),
  turnStatus: vi.fn(async (): Promise<string | null> => 'failed'),
}))
vi.mock('../ledger', async (orig) => ({ ...(await orig<typeof import('../ledger')>()), ...ledger }))

import { ackMessage, claimSession, ingestEvents, parseEventUpload, parseStateUpdate, pendingFor, updateState } from '../device'
import { checkSessionToken } from '../relay'
import {
  IDLE_REASON,
  IDLE_TTL_MS,
  LOOP_EXPIRED_REASON,
  MAC_REMOVED_REASON,
  REVIVE_FOLDER_BUSY,
  REVIVE_FOLDER_GONE,
  addMessage,
  createSession,
  loadSession,
  staleness,
  type DbSession,
} from '../store'
import { signModelToken } from '../tokens'
import { CARD_EXPIRED_REASON, CONTINUE_TEXT, canContinueSession, isContinuableEnd, revivalRefusedReason, sessionEndedText } from '../transcript-view'
import { CONV, DEVICE, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

const moves = () => ledger.moveTurn.mock.calls.map((c) => c[2])
const row = (db: FakeDb, id: string) => db.tables.local_agent_session.find((r) => r.id === id)!
const ago = (ms: number) => new Date(Date.now() - ms).toISOString()

/** A chat the person started (Code tab), claimed and run, its turn ended: idle on the Mac. */
async function idleChat(db: FakeDb, opts: { startedBy?: 'person' | 'agent'; key?: string } = {}): Promise<string> {
  const { session } = await createSession(db as never, {
    userId: USER,
    workspaceId: WS,
    folderId: FOLDER,
    conversationId: CONV,
    request: 'Fix the flaky test',
    mode: 'edit',
    startedBy: opts.startedBy ?? 'person',
    ...(opts.key ? { idempotencyKey: opts.key } : {}),
  })
  await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'p1' })
  await updateState(db as never, USER, session.id, parseStateUpdate({ runId: 'r1', previousRunId: 'p1' }))
  await ingestEvents(db as never, USER, session.id, parseEventUpload({ runId: 'r1', events: [
    { seq: 0, event: { kind: 'status', status: 'running' } },
    { seq: 1, event: { kind: 'status', status: 'waiting' } },
  ] }))
  return session.id
}

/** Idle for 25 h, then read: the reaper expires it (IDLE_REASON). */
async function idleExpired(db: FakeDb, id: string): Promise<void> {
  Object.assign(row(db, id), { status: 'waiting', updated_at: ago(IDLE_TTL_MS + 3600_000), lease_expires_at: null })
  const read = await loadSession(db as never, USER, id)
  expect(read).toMatchObject({ status: 'expired', error: IDLE_REASON })
}

/** Stopped by the person: the Mac's `cancelled`, no reason. */
function stopped(db: FakeDb, id: string): void {
  Object.assign(row(db, id), { status: 'cancelled', error: null, stop_requested_at: ago(60_000), ended_at: ago(60_000), lease_expires_at: null })
}

const personSays = (db: FakeDb, id: string, text = 'Now also fix the lint', requestId?: string) =>
  addMessage(db as never, { userId: USER, sessionId: id, author: 'person', text, policy: 'steer', ...(requestId ? { idempotencyKey: `person:${requestId}` } : {}) })

const env = { ...process.env }
beforeEach(() => {
  for (const f of Object.values(ledger)) f.mockClear()
  ledger.turnStatus.mockResolvedValue('failed')
  process.env.LOCAL_AGENT_TOKEN_SECRET = 'continue-test-secret'
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
})
afterEach(() => {
  process.env = { ...env }
  vi.restoreAllMocks()
})

describe('the rule (transcript-view.ts isContinuableEnd)', () => {
  it('idle past its window or stopped, by a chat that acted for the person: continuable', () => {
    expect(isContinuableEnd('expired', IDLE_REASON, true)).toBe(true)
    expect(isContinuableEnd('cancelled', null, true)).toBe(true)
    expect(canContinueSession({ status: 'cancelled', error: null, attended: true })).toBe(true)
    // Live ones take a message as they always did.
    expect(canContinueSession({ status: 'waiting' })).toBe(true)
  })

  it('never: failed, an end with a reason, a queue nobody claimed, an unattended job', () => {
    expect(isContinuableEnd('failed', null, true)).toBe(false)
    expect(isContinuableEnd('failed', 'the launcher exited', true)).toBe(false)
    expect(isContinuableEnd('cancelled', MAC_REMOVED_REASON, true)).toBe(false)
    expect(isContinuableEnd('cancelled', revivalRefusedReason('this job’s data is gone'), true)).toBe(false)
    expect(isContinuableEnd('expired', LOOP_EXPIRED_REASON, true)).toBe(false)
    expect(isContinuableEnd('expired', CARD_EXPIRED_REASON, true)).toBe(false)
    expect(isContinuableEnd('expired', 'Your Mac didn’t pick this up in time.', true)).toBe(false)
    expect(isContinuableEnd('expired', IDLE_REASON, false)).toBe(false)
    expect(isContinuableEnd('cancelled', null, undefined)).toBe(false)
    expect(canContinueSession({ status: 'failed', error: null, attended: true })).toBe(false)
  })

  it('the lines: the ended one says the next message picks it up; a refused revival says a new chat', () => {
    expect(`${sessionEndedText('expired', IDLE_REASON)} ${CONTINUE_TEXT}`).toBe('It sat idle for 24 hours, so it ended. Your next message picks it up again.')
    expect(`${sessionEndedText('cancelled', null)} ${CONTINUE_TEXT}`).toBe('This local agent was stopped. Your next message picks it up again.')
    expect(sessionEndedText('cancelled', revivalRefusedReason('this job’s data is gone.'))).toBe(
      'It ended: your Mac couldn’t pick it up again (this job’s data is gone). Your next message starts a new chat.',
    )
  })
})

describe('the person’s message picks an old chat up again (store.ts addMessage)', () => {
  it('idle past 24 h: back to waiting, the message is the next turn, the Mac is rung and gets it', async () => {
    const db = seeded()
    const id = await idleChat(db)
    await idleExpired(db, id)
    ledger.moveTurn.mockClear()
    db.rings.length = 0

    const out = await personSays(db, id)
    expect(out).toEqual({ messageId: expect.any(String), requeued: false })
    const r = row(db, id)
    expect(r).toMatchObject({ status: 'waiting', error: null, ended_at: null, stop_requested_at: null, lease_expires_at: null })
    // Its activity is now: the reaper's 24 h counts again from here.
    expect(Date.now() - Date.parse(r.updated_at as string)).toBeLessThan(60_000)
    expect(staleness(r as unknown as DbSession)).toBeNull()
    expect(db.tables.local_agent_message).toEqual([expect.objectContaining({ id: out.messageId, author: 'person', status: 'pending' })])
    expect(db.tables.local_agent_event.find((e) => e.kind === 'inbound')).toMatchObject({ source: 'server', payload: { messageId: out.messageId, revived: true } })
    expect(ledger.nextTurn).toHaveBeenCalledTimes(1)
    expect(db.rings.map((x) => (x.msg as { payload: { reason: string } }).payload.reason)).toEqual(['message'])

    // The Mac's next read hands it the message (a parked job resumes on it), and asks no stop.
    const pending = await pendingFor(db as never, USER, DEVICE)
    expect(pending.messages).toEqual([expect.objectContaining({ id: out.messageId, sessionId: id, author: 'person' })])
    expect(pending.stops).toEqual([])
    expect(pending.start).toEqual([])
  })

  it('stopped by the person: the same, its stop cleared', async () => {
    const db = seeded()
    const id = await idleChat(db)
    stopped(db, id)
    const out = await personSays(db, id)
    expect(row(db, id)).toMatchObject({ status: 'waiting', error: null, ended_at: null, stop_requested_at: null })
    const pending = await pendingFor(db as never, USER, DEVICE)
    expect(pending.messages.map((m) => m.id)).toEqual([out.messageId])
    expect(pending.stops).toEqual([])
  })

  it('a retried send (the same requestId) returns the first message and writes nothing more', async () => {
    const db = seeded()
    const id = await idleChat(db)
    await idleExpired(db, id)
    const a = await personSays(db, id, 'again', 'req-1')
    const b = await personSays(db, id, 'again', 'req-1')
    expect(b).toEqual({ messageId: a.messageId, requeued: false, duplicate: true })
    expect(db.tables.local_agent_message).toHaveLength(1)
  })

  const refusedEnds: Array<[string, (db: FakeDb, id: string) => void]> = [
    ['failed', (db, id) => Object.assign(row(db, id), { status: 'failed', error: 'the launcher exited before it started a session' })],
    ['failed with no reason', (db, id) => Object.assign(row(db, id), { status: 'failed', error: null })],
    ['cancelled because its Mac was removed', (db, id) => Object.assign(row(db, id), { status: 'cancelled', error: MAC_REMOVED_REASON })],
    ['cancelled because another job took its folder', (db, id) => Object.assign(row(db, id), { status: 'cancelled', error: 'A new job started in this folder.' })],
    ['expired in a loop’s queue', (db, id) => Object.assign(row(db, id), { status: 'expired', error: LOOP_EXPIRED_REASON })],
    ['expired waiting for a card’s slot', (db, id) => Object.assign(row(db, id), { status: 'expired', error: CARD_EXPIRED_REASON })],
    ['expired in the queue nobody claimed', (db, id) => Object.assign(row(db, id), { status: 'expired', error: 'Your Mac didn’t pick this up in time.' })],
  ]
  for (const [name, end] of refusedEnds) {
    it(`stays ended (409, nothing written): ${name}`, async () => {
      const db = seeded()
      const id = await idleChat(db)
      end(db, id)
      const before = { ...row(db, id) }
      await expect(personSays(db, id)).rejects.toMatchObject({ code: 'conflict' })
      expect(row(db, id)).toEqual(before)
      expect(db.tables.local_agent_message ?? []).toHaveLength(0)
    })
  }

  it('only the person’s own message revives: the chat agent’s is refused', async () => {
    const db = seeded()
    const id = await idleChat(db)
    await idleExpired(db, id)
    await expect(addMessage(db as never, { userId: USER, sessionId: id, author: 'agent', text: 'carry on', policy: 'queue' })).rejects.toMatchObject({ code: 'conflict' })
    expect(row(db, id).status).toBe('expired')
  })

  it('never a job that ran unattended (a loop’s)', async () => {
    const db = seeded()
    const id = await idleChat(db, { startedBy: 'agent', key: 'local-agent-loop:abc:1' })
    await idleExpired(db, id)
    await expect(personSays(db, id)).rejects.toMatchObject({ code: 'conflict' })
    expect(row(db, id).status).toBe('expired')
  })

  it('a folder no longer shared, or a removed Mac: refused, said plainly', async () => {
    const db = seeded()
    const id = await idleChat(db)
    stopped(db, id)
    db.tables.device_folder[0].revoked_at = new Date().toISOString()
    await expect(personSays(db, id)).rejects.toMatchObject({ code: 'conflict', message: REVIVE_FOLDER_GONE })
    db.tables.device_folder[0].revoked_at = null
    db.tables.user_device[0].removed_at = new Date().toISOString()
    await expect(personSays(db, id)).rejects.toMatchObject({ code: 'conflict', message: MAC_REMOVED_REASON })
    expect(row(db, id).status).toBe('cancelled')
  })

  it('another live chat holds the folder: refused (FOLDER_BUSY), the old one stays ended', async () => {
    const db = seeded()
    const id = await idleChat(db)
    stopped(db, id)
    await createSession(db as never, { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Something else', mode: 'edit', startedBy: 'person' })
    await expect(personSays(db, id)).rejects.toMatchObject({ code: 'conflict', message: REVIVE_FOLDER_BUSY, details: { code: 'FOLDER_BUSY' } })
    expect(row(db, id).status).toBe('cancelled')
  })
})

describe('credentials: the refusals that bound them stay', () => {
  const bearer = (id: string) =>
    new Request('http://localhost/api/local-agent/model/x', { headers: { authorization: `Bearer ${signModelToken({ sid: id, uid: USER, wid: WS }).token}` } })

  it('the relay refuses an idle-expired or stopped chat’s token, and serves it once the person revived it', async () => {
    const db = seeded()
    const id = await idleChat(db)
    await idleExpired(db, id)
    expect(await checkSessionToken(bearer(id), db as never)).toMatchObject({ ok: false })
    await personSays(db, id)
    expect(await checkSessionToken(bearer(id), db as never)).toMatchObject({ ok: true, session: { id, status: 'waiting' } })

    stopped(db, id)
    const refused = await checkSessionToken(bearer(id), db as never)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.response.status).toBe(403)
  })

  it('a waiting row idle past 24 h is refused at the relay before any read reaps it (unchanged)', async () => {
    const db = seeded()
    const id = await idleChat(db)
    Object.assign(row(db, id), { status: 'waiting', updated_at: ago(IDLE_TTL_MS + 60_000), lease_expires_at: null })
    expect(await checkSessionToken(bearer(id), db as never)).toMatchObject({ ok: false })
  })
})

describe('the Mac can’t pick it up again (device.ts endRefusedRevival)', () => {
  it('a refused revival ends the chat with the Mac’s reason; the next message is refused (a new chat)', async () => {
    const db = seeded()
    const id = await idleChat(db)
    await idleExpired(db, id)
    const { messageId } = await personSays(db, id)
    ledger.moveTurn.mockClear()

    expect(await ackMessage(db as never, USER, messageId, { ok: false, error: 'this job’s data is gone' })).toEqual({ changed: true, status: 'failed' })
    const r = row(db, id)
    expect(r).toMatchObject({ status: 'cancelled', error: revivalRefusedReason('this job’s data is gone'), lease_expires_at: null })
    expect(r.ended_at).toEqual(expect.any(String))
    expect(moves()).toEqual([{ type: 'undelivered', reason: 'this job’s data is gone' }, { type: 'cancel' }])
    expect(isContinuableEnd(r.status as never, r.error as string, true)).toBe(false)
    await expect(personSays(db, id, 'try again')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('a message that was no revival leaves the chat idle, as before', async () => {
    const db = seeded()
    const id = await idleChat(db)
    const { messageId } = await personSays(db, id)
    await ackMessage(db as never, USER, messageId, { ok: false, error: 'job not live' })
    expect(row(db, id).status).toBe('waiting')
    expect(moves().map((m) => m.type)).not.toContain('cancel')
  })

  it('another of the person’s messages still waits for the Mac: it stays idle', async () => {
    const db = seeded()
    const id = await idleChat(db)
    stopped(db, id)
    const first = await personSays(db, id, 'one')
    await personSays(db, id, 'two')
    await ackMessage(db as never, USER, first.messageId, { ok: false, error: 'try again later' })
    expect(row(db, id).status).toBe('waiting')
  })

  it('delivered: it stays picked up', async () => {
    const db = seeded()
    const id = await idleChat(db)
    stopped(db, id)
    const { messageId } = await personSays(db, id)
    await ackMessage(db as never, USER, messageId, { ok: true })
    expect(row(db, id).status).toBe('waiting')
  })
})
