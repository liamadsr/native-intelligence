import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown, _move: { type: string; [k: string]: unknown }) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
  nextTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  turnStatus: vi.fn(async (): Promise<string | null> => 'running'),
}))
vi.mock('../ledger', async (orig) => ({ ...(await orig<typeof import('../ledger')>()), ...ledger }))

import {
  DEVICE_REMOVED_CODE,
  DEVICE_REMOVED_REASON,
  FOLDER_REMOVED,
  ackMessage,
  claimSession,
  deriveFromEvents,
  heartbeat,
  ingestEvents,
  parseEventUpload,
  parseHeartbeat,
  parseStateUpdate,
  pendingFor,
  updateState,
} from '../device'
import { addMessage, createSession, getSession } from '../store'
import { CONV, DEVICE, FOLDER, OTHER, USER, WS, seeded, type FakeDb } from './fake-db'

const OTHER_DEVICE = '88888888-8888-4888-8888-888888888888'
// One agent per folder (store.ts claimFolder): tests with several sessions put each in its own folder.
const FOLDER_2 = '77777777-7777-4777-8777-777777777772'
const FOLDER_3 = '77777777-7777-4777-8777-777777777773'

function moreFolders(db: FakeDb) {
  for (const [id, grant, label] of [[FOLDER_2, 'g2', 'dial8-desktop'], [FOLDER_3, 'g3', 'notes']] as const) {
    db.tables.device_folder.push({ id, user_id: USER, device_id: DEVICE, grant_id: grant, label, path: `/Users/l/code/${label}`, mode: 'edit', is_git: true, revoked_at: null })
  }
}

async function queued(db: FakeDb, mode: 'read' | 'edit' = 'read', folderId: string = FOLDER) {
  const { session } = await createSession(db as never, {
    userId: USER, workspaceId: WS, folderId, conversationId: CONV, request: 'Take a look', mode, startedBy: 'agent',
  })
  return session.id
}

const moves = () => ledger.moveTurn.mock.calls.map((c) => c[2])

beforeEach(() => {
  for (const f of Object.values(ledger)) f.mockClear()
})

describe('heartbeat', () => {
  it('upserts the device, mirrors grants and revokes the ones the Mac no longer sends', async () => {
    const db = seeded()
    const input = parseHeartbeat({
      deviceId: DEVICE, name: 'Mac', platform: 'macos', appVersion: '0.3.1',
      grants: [
        { grantId: 'g2', label: 'dial8-desktop', path: '/Users/l/code/dial8-desktop', mode: 'read', isGit: true },
        { grantId: 'g2', label: 'dup', path: '/x', mode: 'read', isGit: false },
      ],
    })
    const out = await heartbeat(db as never, USER, input)
    expect(out.folders).toEqual([{ id: expect.any(String), grantId: 'g2', label: 'dial8-desktop', mode: 'read', isGit: true }])
    expect(db.tables.device_folder.find((f) => f.grant_id === 'g1')?.revoked_at).toBeTruthy()
    expect(db.tables.user_device[0]).toMatchObject({ name: 'Mac', app_version: '0.3.1' })
    // Re-granting g1 un-revokes it, on the same row.
    await heartbeat(db as never, USER, { ...input, grants: [...input.grants, { grantId: 'g1', label: 'dial8-website', path: '/p', mode: 'edit', isGit: true }] })
    expect(db.tables.device_folder.find((f) => f.grant_id === 'g1')).toMatchObject({ id: FOLDER, revoked_at: null })
  })

  it('renews the leases of the device’s working sessions (only the live jobs when listed) and beats their turns', async () => {
    const db = seeded()
    moreFolders(db)
    const a = await queued(db)
    const b = await queued(db, 'read', FOLDER_2)
    const past = new Date(Date.now() + 5_000).toISOString()
    for (const s of db.tables.local_agent_session) Object.assign(s, { status: 'running', lease_expires_at: past, run_id: 'r' })
    await heartbeat(db as never, USER, {
      deviceId: DEVICE, name: 'Mac', platform: 'macos', appVersion: '1',
      grants: [{ grantId: 'g1', label: 'x', path: '/p', mode: 'edit', isGit: true }, { grantId: 'g2', label: 'y', path: '/q', mode: 'edit', isGit: true }],
      liveJobIds: [a],
    })
    const rowA = db.tables.local_agent_session.find((s) => s.id === a)!
    const rowB = db.tables.local_agent_session.find((s) => s.id === b)!
    expect(Date.parse(rowA.lease_expires_at as string)).toBeGreaterThan(Date.now() + 100_000)
    expect(rowB.lease_expires_at).toBe(past)
    expect(moves()).toEqual([{ type: 'beat' }])
  })

  it('removing a folder ends its local agents: a turn in flight is cancelled; an idle one ends, its finished turn left alone', async () => {
    const db = seeded()
    moreFolders(db)
    const working = await queued(db)
    const idle = await queued(db, 'edit', FOLDER_2)
    const row = (id: string) => db.tables.local_agent_session.find((s) => s.id === id)!
    Object.assign(row(working), { status: 'running', run_id: 'r' })
    Object.assign(row(idle), { status: 'waiting', run_id: 'r', branch: 'dial8/x-1' })
    ledger.moveTurn.mockClear()
    // The Mac no longer sends g1 (FOLDER): it was removed there.
    await heartbeat(db as never, USER, { deviceId: DEVICE, name: 'Mac', platform: 'macos', appVersion: '1', grants: [] })
    expect(row(working)).toMatchObject({ status: 'cancelled', error: FOLDER_REMOVED, lease_expires_at: null })
    expect(row(idle)).toMatchObject({ status: 'cancelled', error: FOLDER_REMOVED, branch: 'dial8/x-1' })
    // Only the turn in flight is cancelled in the ledger.
    expect(moves()).toEqual([{ type: 'cancel' }])
    expect(ledger.moveTurn.mock.calls[0][1]).toMatchObject({ id: working })
  })

  it('a new Mac’s first beat makes its environment (migration 420); later beats don’t touch it', async () => {
    const db = seeded()
    await heartbeat(db as never, USER, { deviceId: OTHER_DEVICE, name: ' Studio ', platform: 'macos', appVersion: '1', grants: [] })
    expect(db.tables.environment).toEqual([expect.objectContaining({ kind: 'mac', name: 'Studio', owner_user_id: USER, device_id: OTHER_DEVICE })])
    // The person renames it; the next beats (any name the Mac sends) leave it alone: no environment write.
    db.tables.environment[0].name = 'Work Mac'
    const before = db.writes.length
    await heartbeat(db as never, USER, { deviceId: OTHER_DEVICE, name: 'Studio 2', platform: 'macos', appVersion: '1', grants: [] })
    expect(db.tables.environment).toEqual([expect.objectContaining({ name: 'Work Mac' })])
    expect(db.writes.slice(before).some((w) => w.table === 'environment')).toBe(false)
  })

  it('a known Mac (the backfill made its environment) never inserts one', async () => {
    const db = seeded()
    await heartbeat(db as never, USER, { deviceId: DEVICE, name: 'Mac', platform: 'macos', appVersion: '1', grants: [] })
    expect(db.tables.environment ?? []).toEqual([])
  })

  it('an environment insert that fails never fails the heartbeat', async () => {
    const db = seeded()
    const from = db.from
    db.from = (t: string) => {
      if (t === 'environment') throw new Error('environment table down')
      return from(t)
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(heartbeat(db as never, USER, { deviceId: OTHER_DEVICE, name: 'New', platform: 'macos', appVersion: '1', grants: [] })).resolves.toMatchObject({ folders: [] })
    warn.mockRestore()
  })

  describe('a removed Mac ("Remove this Mac", migration 420)', () => {
    function removed() {
      const db = seeded({ environment: [{ id: 'env-mac', kind: 'mac', name: 'Work Mac', owner_user_id: USER, device_id: DEVICE, archived_at: '2026-10-22T00:00:00Z' }] })
      db.tables.user_device[0].removed_at = '2026-10-22T00:00:00Z'
      db.tables.user_device[0].last_seen_at = '2026-10-21T00:00:00Z'
      db.tables.device_folder[0].revoked_at = '2026-10-22T00:00:00Z'
      db.tables.device_folder_setting = [{ device_folder_id: FOLDER, base_branch: 'main', repo_full_name: null }]
      return db
    }
    const beat = (rejoin?: true) => ({ deviceId: DEVICE, name: 'Mac', platform: 'macos', appVersion: '1', grants: [{ grantId: 'g1', label: 'dial8-website', path: '/p', mode: 'edit' as const, isGit: true }], ...(rejoin ? { rejoin } : {}) })

    it('its heartbeat is refused (DEVICE_REMOVED), and writes nothing: the remove sticks', async () => {
      const db = removed()
      await expect(heartbeat(db as never, USER, beat())).rejects.toMatchObject({
        code: 'conflict', message: DEVICE_REMOVED_REASON, details: { code: DEVICE_REMOVED_CODE },
      })
      expect(db.tables.user_device[0]).toMatchObject({ removed_at: '2026-10-22T00:00:00Z', last_seen_at: '2026-10-21T00:00:00Z' })
      expect(db.tables.device_folder[0].revoked_at).toBe('2026-10-22T00:00:00Z')
      expect(db.writes).toEqual([])
    })

    it('a folder added on it (the rejoin beat) brings it back with the same device, folder and environment ids, and its settings', async () => {
      const db = removed()
      const out = await heartbeat(db as never, USER, beat(true))
      expect(out.folders).toEqual([expect.objectContaining({ id: FOLDER, grantId: 'g1' })])
      expect(db.tables.user_device[0].removed_at).toBeNull()
      expect(db.tables.device_folder[0]).toMatchObject({ id: FOLDER, revoked_at: null })
      expect(db.tables.environment).toEqual([expect.objectContaining({ id: 'env-mac', name: 'Work Mac', archived_at: null })])
      expect(db.tables.device_folder_setting).toEqual([expect.objectContaining({ device_folder_id: FOLDER, base_branch: 'main' })])
      // And the next ordinary beat is a beat again.
      await expect(heartbeat(db as never, USER, beat())).resolves.toMatchObject({ folders: [expect.objectContaining({ id: FOLDER })] })
    })

    it('removed Macs don’t count toward the ten; a returning one does', async () => {
      const db = seeded()
      for (let i = 0; i < 10; i++) {
        db.tables.user_device.push({ user_id: USER, id: `00000000-0000-4000-8000-00000000001${i}`, name: `m${i}`, last_seen_at: new Date().toISOString(), removed_at: '2026-10-22T00:00:00Z' })
      }
      // DEVICE plus ten removed ones: removed ones don't count, so a new Mac still fits.
      await expect(heartbeat(db as never, USER, { deviceId: OTHER_DEVICE, name: 'New', platform: 'macos', appVersion: '1', grants: [] })).resolves.toBeTruthy()
      for (let i = 0; i < 8; i++) db.tables.user_device[i + 1].removed_at = null
      // Now ten are active (DEVICE, OTHER_DEVICE and eight): a removed one can't come back.
      await expect(heartbeat(db as never, USER, { deviceId: '00000000-0000-4000-8000-000000000019', name: 'm9', platform: 'macos', appVersion: '1', grants: [], rejoin: true })).rejects.toMatchObject({
        details: { code: 'TOO_MANY_DEVICES' },
      })
    })

    it('parses the rejoin flag only when it is exactly true', () => {
      expect(parseHeartbeat({ deviceId: DEVICE, grants: [], rejoin: true })).toMatchObject({ rejoin: true })
      expect(parseHeartbeat({ deviceId: DEVICE, grants: [], rejoin: 'yes' })).not.toHaveProperty('rejoin')
    })
  })

  it('validates the body', () => {
    expect(() => parseHeartbeat({ deviceId: 'nope', grants: [] })).toThrow(/uuid/)
    expect(() => parseHeartbeat({ deviceId: DEVICE })).toThrow(/grants/)
    expect(() => parseHeartbeat({ deviceId: DEVICE, grants: [{ grantId: 'g', label: 'l', path: '/p', mode: 'write' }] })).toThrow(/mode/)
    expect(() => parseHeartbeat({ deviceId: DEVICE, grants: Array.from({ length: 201 }, () => ({})) })).toThrow(/at most/)
  })
})

describe('pending', () => {
  it('lists starts, messages (with author) and stops for this device only', async () => {
    const db = seeded()
    moreFolders(db)
    const s1 = await queued(db)
    const s2 = await queued(db, 'read', FOLDER_2)
    const s3 = await queued(db, 'read', FOLDER_3)
    const row = (id: string) => db.tables.local_agent_session.find((s) => s.id === id)!
    Object.assign(row(s2), { status: 'running', run_id: 'r', lease_expires_at: new Date(Date.now() + 60_000).toISOString() })
    Object.assign(row(s3), { status: 'waiting', run_id: 'r', stop_requested_at: new Date().toISOString() })
    await addMessage(db as never, { userId: USER, sessionId: s2, author: 'agent', text: 'Steer here', policy: 'steer' })
    await addMessage(db as never, { userId: USER, sessionId: s1, author: 'person', text: 'For later', policy: 'queue' })
    const out = await pendingFor(db as never, USER, DEVICE)
    expect(out.start).toEqual([{ sessionId: s1, grantId: 'g1', mode: 'read', request: 'Take a look', resume: null }])
    expect(out.messages).toEqual([{ id: expect.any(String), sessionId: s2, text: 'Steer here', policy: 'steer', author: 'agent' }])
    expect(out.stops).toEqual([{ sessionId: s3 }])
    expect(await pendingFor(db as never, USER, OTHER_DEVICE)).toEqual({ start: [], messages: [], stops: [] })
    expect(await pendingFor(db as never, OTHER, DEVICE)).toEqual({ start: [], messages: [], stops: [] })
  })

  it('offers a requeued interrupted session with its eve session to resume', async () => {
    const db = seeded()
    const id = await queued(db)
    Object.assign(db.tables.local_agent_session[0], { status: 'interrupted', eve_session_id: 'eve-9', stream_index: 4 })
    await addMessage(db as never, { userId: USER, sessionId: id, author: 'agent', text: 'Resume', policy: 'queue' })
    const out = await pendingFor(db as never, USER, DEVICE)
    expect(out.start[0]).toMatchObject({ sessionId: id, resume: { eveSessionId: 'eve-9', streamIndex: 4 } })
  })

  it('fails a queued session whose folder the Mac revoked', async () => {
    const db = seeded()
    const id = await queued(db)
    db.tables.device_folder[0].revoked_at = new Date().toISOString()
    expect((await pendingFor(db as never, USER, DEVICE)).start).toEqual([])
    expect((await getSession(db as never, USER, id))?.status).toBe('failed')
  })
})

describe('claim', () => {
  it('is a CAS: the first claim wins, a second (or another device’s) gets null', async () => {
    const db = seeded()
    const id = await queued(db)
    expect(await claimSession(db as never, USER, id, { deviceId: OTHER_DEVICE, runId: 'p1' })).toBeNull()
    const first = await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p1' })
    expect(first).toMatchObject({ grantId: 'g1', mode: 'read', request: 'Take a look', resume: null })
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'starting', run_id: 'p1' })
    expect(Date.parse(db.tables.local_agent_session[0].lease_expires_at as string)).toBeGreaterThan(Date.now())
    expect(moves()).toEqual([{ type: 'step', text: 'Starting on your Mac' }])
    expect(await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p2' })).toBeNull()
    expect(await claimSession(db as never, OTHER, id, { deviceId: DEVICE, runId: 'p2' })).toBeNull()
  })

  it('refuses a stop-requested or expired session', async () => {
    const db = seeded()
    const id = await queued(db)
    db.tables.local_agent_session[0].stop_requested_at = new Date().toISOString()
    expect(await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p' })).toBeNull()
    db.tables.local_agent_session[0].stop_requested_at = null
    db.tables.local_agent_session[0].expires_at = new Date(Date.now() - 1).toISOString()
    expect(await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p' })).toBeNull()
  })
})

describe('events', () => {
  async function running(db: FakeDb) {
    const id = await queued(db)
    await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p1' })
    expect(await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r1', previousRunId: 'p1' }))).toEqual({ applied: true, stopRequested: false })
    ledger.moveTurn.mockClear()
    return id
  }
  const upload = (seqs: Array<[number, Record<string, unknown>]>, runId = 'r1') =>
    parseEventUpload({ runId, events: seqs.map(([seq, event]) => ({ seq, event })) })

  it('dedupes a retried or overlapping upload on (session, run, seq)', async () => {
    const db = seeded()
    const id = await running(db)
    const batch = upload([[0, { kind: 'status', status: 'running' }], [1, { kind: 'text', delta: 'Hi' }]])
    expect(await ingestEvents(db as never, USER, id, batch)).toEqual({ stopRequested: false, inserted: 2 })
    expect(await ingestEvents(db as never, USER, id, batch)).toEqual({ stopRequested: false, inserted: 0 })
    const overlap = upload([[1, { kind: 'text', delta: 'Hi' }], [2, { kind: 'text', delta: '!' }]])
    expect((await ingestEvents(db as never, USER, id, overlap)).inserted).toBe(1)
    expect(db.tables.local_agent_event.filter((e) => e.source === 'device')).toHaveLength(3)
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'running', last_seq: 2, last_seq_run_id: 'r1' })
    expect(moves()[0]).toEqual({ type: 'step', text: 'Working on your Mac' })
  })

  it('derives ask, finish, branch and the turn end, and moves the ledger', async () => {
    const db = seeded()
    const id = await running(db)
    await ingestEvents(db as never, USER, id, upload([
      [0, { kind: 'status', status: 'running' }],
      [1, { kind: 'tool', callId: 'c', name: 'read_file', input: '{"path":"src/app/page.tsx"}' }],
      [2, { kind: 'ask', question: 'Which branch?' }],
      [3, { kind: 'status', status: 'waiting' }],
    ]))
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'waiting', last_signal: 'ask', last_signal_text: 'Which branch?', lease_expires_at: null })
    // Collapsed to where the upload leaves the session: one question, no step.
    expect(moves()).toEqual([{ type: 'ask', question: 'Which branch?' }])

    ledger.moveTurn.mockClear()
    await addMessage(db as never, { userId: USER, sessionId: id, author: 'agent', text: 'main', policy: 'queue' })
    await ingestEvents(db as never, USER, id, upload([
      [4, { kind: 'status', status: 'running' }],
      [5, { kind: 'finish', summary: 'Made the change' }],
      [6, { kind: 'branch', branch: 'dial8/fix-ab12', commit: 'abc123', filesChanged: 2, insertions: 5, deletions: 1 }],
      [7, { kind: 'status', status: 'completed' }],
    ]))
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'waiting', last_signal: 'finish', last_signal_text: 'Made the change', branch: 'dial8/fix-ab12', commit_sha: 'abc123' })
    expect(moves().map((m) => m?.type)).toContain('turn_end')
    // A read session's turn is done (reported in the chat), not a review.
    expect(moves().find((m) => m?.type === 'turn_end')).toEqual({ type: 'turn_end', summary: 'Made the change', review: false })
  })

  it('reports the stop request back to the uploader', async () => {
    const db = seeded()
    const id = await running(db)
    db.tables.local_agent_session[0].stop_requested_at = new Date().toISOString()
    expect((await ingestEvents(db as never, USER, id, upload([[0, { kind: 'text', delta: 'x' }]]))).stopRequested).toBe(true)
    await ingestEvents(db as never, USER, id, upload([[1, { kind: 'status', status: 'cancelled' }]]))
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'cancelled' })
    expect(db.tables.local_agent_session[0].ended_at).toBeTruthy()
    expect(moves()).toContainEqual({ type: 'cancel' })
  })

  it('another person cannot upload', async () => {
    const db = seeded()
    const id = await running(db)
    await expect(ingestEvents(db as never, OTHER, id, upload([[0, { kind: 'text', delta: 'x' }]]))).rejects.toMatchObject({ code: 'not_found' })
  })

  it('validates uploads', () => {
    expect(() => parseEventUpload({ events: [] })).toThrow(/runId/)
    expect(() => parseEventUpload({ runId: 'r', events: Array.from({ length: 201 }, (_, i) => ({ seq: i, event: { kind: 'text' } })) })).toThrow(/at most 200/)
    expect(() => parseEventUpload({ runId: 'r', events: [{ seq: -1, event: { kind: 'text' } }] })).toThrow(/seq/)
    expect(() => parseEventUpload({ runId: 'r', events: [{ seq: 1, event: { kind: 'DROP TABLE' } }] })).toThrow(/kind/)
    const big = parseEventUpload({ runId: 'r', events: [{ seq: 1, event: { kind: 'tool_result', output: 'x'.repeat(20_000), nested: { a: 1 } } }] })
    expect((big.events[0].event.output as string).length).toBe(8000)
    expect(big.events[0].event.nested).toBe('{"a":1}')
  })
})

describe('run rebind (/state previousRunId)', () => {
  it('rebinds the claim’s provisional run once; a wrong previousRunId is refused', async () => {
    const db = seeded()
    const id = await queued(db)
    await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p1' })
    expect(await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r1', previousRunId: 'wrong' }))).toEqual({ applied: false, stopRequested: false })
    expect(db.tables.local_agent_session[0].run_id).toBe('p1')
    expect(await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r1', previousRunId: 'p1', deviceId: OTHER_DEVICE }))).toMatchObject({ applied: false })
    expect(await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r1', previousRunId: 'p1', eveSessionId: 'eve-1', streamIndex: 0 }))).toEqual({ applied: true, stopRequested: false })
    expect(db.tables.local_agent_session[0]).toMatchObject({ run_id: 'r1', eve_session_id: 'eve-1', stream_index: 0 })
    // Replayed: already bound, applies as the current run.
    expect((await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r1', previousRunId: 'p1' }))).applied).toBe(true)
    // The provisional run can no longer rebind it elsewhere.
    expect((await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r9', previousRunId: 'p1' }))).applied).toBe(false)
    expect((await getSession(db as never, USER, id))?.runId).toBe('r1')
  })

  it('derives state from the new run’s events after the rebind; a stale run’s events are stored only', async () => {
    const db = seeded()
    const id = await queued(db)
    await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p1' })
    // Before the rebind, the real run's events derive nothing.
    await ingestEvents(db as never, USER, id, parseEventUpload({ runId: 'r1', events: [{ seq: 0, event: { kind: 'status', status: 'running' } }] }))
    expect(db.tables.local_agent_session[0].status).toBe('starting')
    await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r1', previousRunId: 'p1' }))
    await ingestEvents(db as never, USER, id, parseEventUpload({ runId: 'r1', events: [{ seq: 1, event: { kind: 'status', status: 'running' } }] }))
    expect(db.tables.local_agent_session[0].status).toBe('running')
    // Resume-then-send: a new run r2 replaces r1.
    await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r2', previousRunId: 'r1' }))
    ledger.moveTurn.mockClear()
    await ingestEvents(db as never, USER, id, parseEventUpload({ runId: 'r1', events: [{ seq: 2, event: { kind: 'ask', question: 'stale?' } }] }))
    expect(db.tables.local_agent_session[0]).toMatchObject({ last_signal: null, status: 'running' })
    expect(db.tables.local_agent_event.some((e) => e.run_id === 'r1' && e.seq === 2)).toBe(true)
    expect(moves()).toEqual([])
    await ingestEvents(db as never, USER, id, parseEventUpload({ runId: 'r2', events: [{ seq: 3, event: { kind: 'ask', question: 'fresh?' } }] }))
    expect(db.tables.local_agent_session[0]).toMatchObject({ last_signal: 'ask', last_signal_text: 'fresh?' })
  })

  it('a process exit settles the session through /state', async () => {
    const db = seeded()
    const id = await queued(db)
    await claimSession(db as never, USER, id, { deviceId: DEVICE, runId: 'p1' })
    await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r1', previousRunId: 'p1' }))
    ledger.moveTurn.mockClear()
    await updateState(db as never, USER, id, parseStateUpdate({ runId: 'r1', status: 'failed', error: 'node exited 1' }))
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'failed', error: 'node exited 1' })
    expect(moves()).toEqual([{ type: 'fail', message: 'node exited 1' }])
    expect(() => parseStateUpdate({ runId: 'r1', status: 'exploded' })).toThrow(/status/)
  })
})

describe('message ack', () => {
  it('delivers once, idempotently, owner-scoped', async () => {
    const db = seeded()
    const id = await queued(db)
    const { messageId } = await addMessage(db as never, { userId: USER, sessionId: id, author: 'agent', text: 'hi', policy: 'queue' })
    await expect(ackMessage(db as never, OTHER, messageId, { ok: true })).rejects.toMatchObject({ code: 'not_found' })
    expect(await ackMessage(db as never, USER, messageId, { ok: true })).toEqual({ changed: true, status: 'delivered' })
    expect(await ackMessage(db as never, USER, messageId, { ok: false, error: 'late' })).toEqual({ changed: false, status: 'delivered' })
    expect(db.tables.local_agent_message[0].delivered_at).toBeTruthy()
  })
})

describe('deriveFromEvents', () => {
  const idle = { status: 'waiting' as const, last_signal: 'finish' as const, last_signal_text: 'old', error: null }
  it('a new turn clears the last turn’s signal; completed is waiting; interrupted and failed move the ledger', () => {
    const d = deriveFromEvents(idle, [{ kind: 'status', payload: { status: 'running' } }])
    expect(d.patch).toMatchObject({ status: 'running', last_signal: null, last_signal_text: null })
    expect(deriveFromEvents({ ...idle, status: 'running', last_signal: null }, [{ kind: 'message', payload: { text: 'All done.' } }, { kind: 'status', payload: { status: 'completed' } }]).moves).toEqual([{ type: 'turn_end', summary: 'All done.', review: false }])
    expect(deriveFromEvents({ ...idle, status: 'running' }, [{ kind: 'status', payload: { status: 'interrupted' } }]).moves).toEqual([{ type: 'interrupted' }])
    expect(deriveFromEvents({ ...idle, status: 'running' }, [{ kind: 'status', payload: { status: 'failed', reason: 'boom' } }]).moves).toEqual([{ type: 'fail', message: 'boom' }])
    const noText = deriveFromEvents({ ...idle, status: 'running', last_signal: null }, [{ kind: 'status', payload: { status: 'waiting' } }])
    expect(noText.needsLastMessage).toBe(true)
    // A settled session ignores later statuses.
    expect(deriveFromEvents({ ...idle, status: 'cancelled' }, [{ kind: 'status', payload: { status: 'running' } }]).patch.status).toBeUndefined()
  })
})
