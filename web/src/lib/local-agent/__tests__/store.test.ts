import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown, _move?: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
  nextTurn: vi.fn(async (_svc: unknown, s: Record<string, unknown>) => ({ ...s, currentTurn: (s.currentTurn as number) + 1 })),
  turnStatus: vi.fn(async (): Promise<string | null> => 'running'),
}))
vi.mock('../ledger', async (orig) => ({ ...(await orig<typeof import('../ledger')>()), ...ledger }))

import {
  addMessage,
  createSession,
  getSession,
  listDevices,
  listFolders,
  listSessions,
  listWorktrees,
  readEnvironment,
  requestStop,
  MAC_REMOVED_REASON,
  WORKTREE_RECENT_MS,
} from '../store'
import { CONV, DEVICE, FOLDER, OTHER, USER, WS, fakeDb, seeded, type FakeDb } from './fake-db'

const base = { userId: USER, workspaceId: WS, folderId: FOLDER, conversationId: CONV, request: 'Take a look at this repository', mode: 'read' as const, startedBy: 'agent' as const }

function session(db: FakeDb) {
  return db.tables.local_agent_session[0]
}

beforeEach(() => {
  for (const f of Object.values(ledger)) f.mockClear()
  ledger.turnStatus.mockResolvedValue('running')
})

describe('createSession', () => {
  it('queues a session on the folder’s device, records turn 1 and rings device:<uid>', async () => {
    const db = seeded()
    const out = await createSession(db as never, base)
    expect(out.created).toBe(true)
    expect(out.deviceOnline).toBe(true)
    expect(out.session).toMatchObject({ status: 'queued', deviceId: DEVICE, folderLabel: 'dial8-website', deviceName: 'Liam’s MacBook', trackedJobId: 'job-1', mode: 'read', conversationId: CONV })
    expect(session(db)).toMatchObject({ device_id: DEVICE, tracked_job_id: 'job-1', current_tracked_job_id: 'job-1', started_by: 'agent' })
    expect(Date.parse(session(db).expires_at as string) - Date.now()).toBeGreaterThan(5.9 * 3600_000)
    expect(ledger.startTurnRow).toHaveBeenCalledWith(db, expect.objectContaining({ id: out.session.id, folderLabel: 'dial8-website' }), { turn: 1, text: base.request, status: 'queued' })
    expect(db.rings).toEqual([{ topic: `device:${USER}`, msg: { type: 'broadcast', event: 'local-agent', payload: { reason: 'start', sessionId: out.session.id } } }])
  })

  it('returns the existing session for a retried idempotency key', async () => {
    const db = seeded()
    const key = `local-agent:${CONV}:session:s:turn:t:call:c`
    const a = await createSession(db as never, { ...base, idempotencyKey: key })
    const b = await createSession(db as never, { ...base, idempotencyKey: key })
    expect(b.created).toBe(false)
    expect(b.session.id).toBe(a.session.id)
    expect(db.tables.local_agent_session).toHaveLength(1)
    expect(ledger.startTurnRow).toHaveBeenCalledTimes(1)
  })

  it('refuses edits on a read-only folder, a revoked or foreign folder, a foreign conversation and an oversized request', async () => {
    const db = seeded()
    db.tables.device_folder[0].mode = 'read'
    await expect(createSession(db as never, { ...base, mode: 'edit' })).rejects.toMatchObject({ code: 'forbidden' })
    db.tables.device_folder[0].revoked_at = new Date().toISOString()
    await expect(createSession(db as never, base)).rejects.toMatchObject({ code: 'not_found' })
    db.tables.device_folder[0].revoked_at = null
    await expect(createSession(db as never, { ...base, userId: OTHER })).rejects.toMatchObject({ code: 'not_found' })
    db.tables.chat_conversations[0].user_id = OTHER
    await expect(createSession(db as never, base)).rejects.toMatchObject({ code: 'not_found' })
    db.tables.chat_conversations[0].user_id = USER
    await expect(createSession(db as never, { ...base, request: 'x'.repeat(20_001) })).rejects.toMatchObject({ code: 'bad_request' })
    expect(db.tables.local_agent_session ?? []).toHaveLength(0)
  })

  it('allows edits on an edit folder', async () => {
    const db = seeded()
    const out = await createSession(db as never, { ...base, mode: 'edit' })
    expect(out.session.mode).toBe('edit')
  })

  it('records the Mac environment of its device when it starts (migration 420)', async () => {
    const db = seeded({ environment: [{ id: 'env-mac', kind: 'mac', name: 'Liam’s MacBook', owner_user_id: USER, device_id: DEVICE }] })
    await createSession(db as never, base)
    expect(session(db).environment_id).toBe('env-mac')
    expect(db.tables.environment).toHaveLength(1)
  })

  it('a device with no environment yet gets one as the session starts', async () => {
    const db = seeded()
    await createSession(db as never, base)
    const [env] = db.tables.environment
    expect(env).toMatchObject({ kind: 'mac', owner_user_id: USER, device_id: DEVICE, name: 'Liam’s MacBook' })
    expect(session(db).environment_id).toBe(env.id)
  })

  it('refuses a removed Mac ("Remove this Mac"), even one whose folders weren’t revoked yet', async () => {
    const db = seeded()
    db.tables.user_device[0].removed_at = new Date().toISOString()
    await expect(createSession(db as never, base)).rejects.toMatchObject({ code: 'conflict', message: MAC_REMOVED_REASON, details: { code: 'DEVICE_REMOVED' } })
    expect(db.tables.local_agent_session ?? []).toEqual([])
  })

  it('a remove that lands between the check and the insert ends the new job at once, and refuses the start', async () => {
    const db = seeded()
    db.interleave((q) => q.table === 'local_agent_session' && q.op === 'insert', async () => {
      db.tables.user_device[0].removed_at = new Date().toISOString()
    })
    await expect(createSession(db as never, base)).rejects.toMatchObject({ details: { code: 'DEVICE_REMOVED' } })
    expect(session(db)).toMatchObject({ status: 'cancelled', error: MAC_REMOVED_REASON })
    expect(ledger.startTurnRow).not.toHaveBeenCalled()
    expect(db.rings).toEqual([])
  })

  it('lists no removed Mac', async () => {
    const db = seeded()
    db.tables.user_device[0].removed_at = new Date().toISOString()
    expect(await listDevices(db as never, USER)).toEqual([])
  })

  it('an environment lookup that fails still starts the job, without one', async () => {
    const db = seeded()
    const from = db.from
    db.from = (t: string) => {
      if (t === 'environment') throw new Error('environment table down')
      return from(t)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const out = await createSession(db as never, base)
    warn.mockRestore()
    expect(out.created).toBe(true)
    expect(session(db).environment_id).toBeUndefined()
  })
})

describe('reading sessions, with lazy reaping', () => {
  it('another person sees nothing', async () => {
    const db = seeded()
    const { session: s } = await createSession(db as never, base)
    expect(await getSession(db as never, OTHER, s.id)).toBeNull()
    expect(await listSessions(db as never, OTHER)).toEqual([])
  })

  it('expires a queued session past its TTL and fails its turn', async () => {
    const db = seeded()
    const { session: s } = await createSession(db as never, base)
    session(db).expires_at = new Date(Date.now() - 1000).toISOString()
    const row = await getSession(db as never, USER, s.id)
    expect(row?.status).toBe('expired')
    expect(row?.error).toMatch(/didn't connect within 6 hours/)
    expect(ledger.moveTurn).toHaveBeenCalledWith(db, expect.anything(), { type: 'fail', message: "your Mac didn't connect within 6 hours" })
  })

  it('interrupts a running session whose lease lapsed', async () => {
    const db = seeded()
    const { session: s } = await createSession(db as never, base)
    Object.assign(session(db), { status: 'running', lease_expires_at: new Date(Date.now() - 1000).toISOString() })
    const [row] = await listSessions(db as never, USER, { conversationId: CONV })
    expect(row.status).toBe('interrupted')
    expect(ledger.moveTurn).toHaveBeenCalledWith(db, expect.objectContaining({ id: s.id }), { type: 'interrupted' })
    expect(await listSessions(db as never, USER, { live: true })).toEqual([])
  })
})

describe('addMessage', () => {
  async function started(status: string, extra: Record<string, unknown> = {}) {
    const db = seeded()
    const { session: s } = await createSession(db as never, base)
    Object.assign(session(db), { status, lease_expires_at: new Date(Date.now() + 60_000).toISOString(), run_id: 'r1', ...extra })
    db.rings.length = 0
    return { db, s }
  }

  it('writes the message and its inbound event, and rings', async () => {
    const { db, s } = await started('running')
    const out = await addMessage(db as never, { userId: USER, sessionId: s.id, author: 'person', text: 'Also check the tests', policy: 'steer' })
    expect(out.requeued).toBe(false)
    expect(db.tables.local_agent_message[0]).toMatchObject({ id: out.messageId, author: 'person', policy: 'steer', status: 'pending', user_id: USER })
    expect(db.tables.local_agent_event[0]).toMatchObject({ source: 'server', kind: 'inbound', payload: { author: 'person', text: 'Also check the tests', policy: 'steer', messageId: out.messageId } })
    expect(db.rings[0].msg).toMatchObject({ payload: { reason: 'message', sessionId: s.id } })
    expect(ledger.nextTurn).not.toHaveBeenCalled()
  })

  it('puts an interrupted session back in the queue to resume', async () => {
    const { db, s } = await started('interrupted', { eve_session_id: 'eve-1', expires_at: new Date(Date.now() - 1000).toISOString(), lease_expires_at: null })
    ledger.turnStatus.mockResolvedValue('needs_input')
    const out = await addMessage(db as never, { userId: USER, sessionId: s.id, author: 'agent', text: 'Carry on', policy: 'queue' })
    expect(out.requeued).toBe(true)
    expect(session(db)).toMatchObject({ status: 'queued', lease_expires_at: null, eve_session_id: 'eve-1' })
    expect(Date.parse(session(db).expires_at as string)).toBeGreaterThan(Date.now())
    // The interrupted turn stays parked until the Mac claims it.
    expect(ledger.moveTurn).not.toHaveBeenCalledWith(db, expect.anything(), { type: 'resume' })
    expect(ledger.nextTurn).not.toHaveBeenCalled()
  })

  it('answers an open question: resume(), and the ask signal closes', async () => {
    const { db, s } = await started('waiting', { last_signal: 'ask', last_signal_text: 'Which branch?' })
    ledger.turnStatus.mockResolvedValue('needs_input')
    await addMessage(db as never, { userId: USER, sessionId: s.id, author: 'agent', text: 'main', policy: 'queue' })
    expect(ledger.moveTurn).toHaveBeenCalledWith(db, expect.anything(), { type: 'resume' })
    expect(session(db)).toMatchObject({ last_signal: null, last_signal_text: null, status: 'waiting' })
  })

  it('opens the next turn for an idle session whose turn settled', async () => {
    const { db, s } = await started('waiting', { last_signal: 'finish', last_signal_text: 'Done' })
    ledger.turnStatus.mockResolvedValue('needs_review')
    await addMessage(db as never, { userId: USER, sessionId: s.id, author: 'person', text: 'Now fix the bug', policy: 'queue' })
    expect(ledger.nextTurn).toHaveBeenCalledWith(db, expect.objectContaining({ id: s.id }), { text: 'Now fix the bug', status: 'queued' })
  })

  it('refuses an ended session and bad input', async () => {
    const { db, s } = await started('cancelled')
    await expect(addMessage(db as never, { userId: USER, sessionId: s.id, author: 'person', text: 'hi', policy: 'queue' })).rejects.toMatchObject({ code: 'conflict' })
    await expect(addMessage(db as never, { userId: OTHER, sessionId: s.id, author: 'person', text: 'hi', policy: 'queue' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(addMessage(db as never, { userId: USER, sessionId: s.id, author: 'person', text: ' ', policy: 'queue' })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(addMessage(db as never, { userId: USER, sessionId: s.id, author: 'person', text: 'x', policy: 'now' as never })).rejects.toMatchObject({ code: 'bad_request' })
    expect(db.tables.local_agent_message ?? []).toHaveLength(0)
  })
})

describe('requestStop', () => {
  it('cancels a queued session at once', async () => {
    const db = seeded()
    const { session: s } = await createSession(db as never, base)
    const row = await requestStop(db as never, USER, s.id)
    expect(row.status).toBe('cancelled')
    expect(row.endedAt).not.toBeNull()
    expect(ledger.moveTurn).toHaveBeenCalledWith(db, expect.anything(), { type: 'cancel' })
  })

  it('asks the Mac to stop a running session', async () => {
    const db = seeded()
    const { session: s } = await createSession(db as never, base)
    Object.assign(session(db), { status: 'running', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
    db.rings.length = 0
    const row = await requestStop(db as never, USER, s.id)
    expect(row.status).toBe('running')
    expect(session(db).stop_requested_at).toBeTruthy()
    expect(db.rings[0].msg).toMatchObject({ payload: { reason: 'stop', sessionId: s.id } })
  })
})

describe('devices and folders', () => {
  it('lists devices with presence', async () => {
    const db = seeded()
    db.tables.user_device.push({ user_id: USER, id: '99999999-9999-4999-8999-999999999999', name: 'Old Mac', platform: 'macos', app_version: '0.1', last_seen_at: new Date(Date.now() - 600_000).toISOString() })
    const devices = await listDevices(db as never, USER)
    expect(devices.map((d) => [d.name, d.online])).toEqual([['Liam’s MacBook', true], ['Old Mac', false]])
  })

  it('lists the person’s folders (their environment), whatever the chat; another person’s read as none', async () => {
    const db = seeded()
    const [f] = await listFolders(db as never, USER)
    expect(f).toMatchObject({ id: FOLDER, label: 'dial8-website', mode: 'edit', isGit: true, deviceName: 'Liam’s MacBook', online: true })
    expect(await listFolders(db as never, OTHER)).toEqual([])
  })

  it('hides revoked folders', async () => {
    const db = seeded()
    db.tables.device_folder[0].revoked_at = new Date().toISOString()
    expect(await listFolders(db as never, USER)).toEqual([])
    expect(await listFolders(fakeDb() as never, USER)).toEqual([])
  })

  it('worktrees: edit sessions with a branch, live or from the last 7 days, newest first, one per folder and branch', async () => {
    const db = seeded()
    const at = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()
    const row = (id: string, over: Record<string, unknown>) => ({ id, user_id: USER, folder_id: FOLDER, mode: 'edit', status: 'waiting', branch: null, updated_at: at(1000), ...over })
    db.tables.local_agent_session = [
      row('s-new', { branch: 'dial8/fix-header-1a2b', status: 'cancelled', updated_at: at(60_000) }),
      row('s-old-turn', { branch: 'dial8/fix-header-1a2b', updated_at: at(120_000) }),
      row('s-live', { branch: 'dial8/add-tests-3c4d', status: 'running', updated_at: at(5_000) }),
      row('s-nobranch', { branch: null }),
      row('s-read', { mode: 'read', branch: 'dial8/x' }),
      row('s-stale', { branch: 'dial8/old-5e6f', updated_at: at(WORKTREE_RECENT_MS + 60_000) }),
      row('s-other', { user_id: OTHER, branch: 'dial8/theirs' }),
    ]
    const rows = await listWorktrees(db as never, USER)
    expect(rows.map((w) => [w.sessionId, w.branch, w.live])).toEqual([
      ['s-live', 'dial8/add-tests-3c4d', true],
      ['s-new', 'dial8/fix-header-1a2b', false],
    ])
  })

  it('the environment: devices, live folders, and only the branches of folders still in it', async () => {
    const db = seeded()
    db.tables.local_agent_session = [
      { id: 's-1', user_id: USER, folder_id: FOLDER, mode: 'edit', status: 'waiting', branch: 'dial8/a', updated_at: new Date().toISOString() },
    ]
    const env = await readEnvironment(db as never, USER)
    expect(env.devices.map((d) => d.id)).toEqual([DEVICE])
    expect(env.folders.map((f) => f.id)).toEqual([FOLDER])
    expect(env.worktrees.map((w) => w.branch)).toEqual(['dial8/a'])
    db.tables.device_folder[0].revoked_at = new Date().toISOString()
    expect(await readEnvironment(db as never, USER)).toMatchObject({ folders: [], worktrees: [] })
  })
})
