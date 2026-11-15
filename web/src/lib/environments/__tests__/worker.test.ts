/**
 * Who does a Mac's work (migration 658): the person chooses, per Mac
 * environment, Native Intelligence's own agent (null) or one of the coding
 * agents that Mac offers (their own account there). The server:
 *   - lists the choice with the Mac and changes it only for the Mac's owner,
 *     checking only the id's shape (the Mac refuses an id it doesn't offer);
 *   - stamps it on a chat start's session (createSession's macWorker), never
 *     on the other starts, and never moves a started job;
 *   - fails a start whose choice it can't read rather than run it on our own
 *     agent (no fallback), except when the column isn't there yet;
 *   - hands it to the Mac with the claim.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
}))
vi.mock('@/lib/local-agent/ledger', async (orig) => ({ ...(await orig<typeof import('@/lib/local-agent/ledger')>()), ...ledger }))

import { fakeDb, type FakeDb } from '@/lib/local-agent/__tests__/fake-db'
import { WORKER_PAGE_OUTDATED_REASON, claimSession, claimWorker, heartbeat, parseHeartbeat } from '@/lib/local-agent/device'
import { heartbeatBody } from '@/lib/local-agent/relay-core'
import { FOLDER_BUSY_CODE, createSession } from '@/lib/local-agent/store'
import { cleanWorker, listEnvironments, updateEnvironment } from '../store'
import { OFFERED_WORKERS_MAX, cleanWorkerOffers, isWorkerId, workerLabel, type MacEnvironment } from '../types'

const ME = '11111111-1111-4111-8111-111111111111'
const SOMEONE = '22222222-2222-4222-8222-222222222222'
const WS = '55555555-5555-4555-8555-555555555555'
const MAC = '77777777-7777-4777-8777-777777777777'
const THEIR_MAC = '77777777-7777-4777-8777-777777777779'
const FOLDER = '88888888-8888-4888-8888-888888888881'
const MAC_ENV = '99999999-9999-4999-8999-999999999901'
const THEIR_MAC_ENV = '99999999-9999-4999-8999-999999999902'
const CLOUD_ENV = '99999999-9999-4999-8999-999999999903'
const CONV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let db: FakeDb
const svc = () => db as never

const env = (id: string) => db.tables.environment.find((e) => e.id === id)!

beforeEach(() => {
  ledger.moveTurn.mockClear()
  ledger.startTurnRow.mockClear()
  db = fakeDb({
    member: [
      { workspace_id: WS, user_id: ME, role: 'owner' },
      { workspace_id: WS, user_id: SOMEONE, role: 'member' },
    ],
    workspace: [{ id: WS, default_cloud_environment_id: null }],
    user_device: [
      { user_id: ME, id: MAC, name: 'Studio Mac', platform: 'macos', app_version: '0.3.1', last_seen_at: new Date().toISOString() },
      { user_id: SOMEONE, id: THEIR_MAC, name: 'Office Mac', platform: 'macos', app_version: '0.3.1', last_seen_at: new Date().toISOString() },
    ],
    device_folder: [
      { id: FOLDER, user_id: ME, device_id: MAC, grant_id: 'g1', label: 'harbor-site', path: '/Users/ana/code/harbor-site', mode: 'edit', is_git: true, revoked_at: null },
    ],
    environment: [
      {
        id: MAC_ENV, kind: 'mac', name: 'Studio Mac', owner_user_id: ME, device_id: MAC, workspace_id: null, worker: null, archived_at: null, created_at: '2026-10-01', updated_at: '2026-10-01',
        // What the Mac last said it offers (its heartbeat).
        offered_workers: [{ id: 'claude-code', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }],
      },
      { id: THEIR_MAC_ENV, kind: 'mac', name: 'Office Mac', owner_user_id: SOMEONE, device_id: THEIR_MAC, workspace_id: null, worker: null, archived_at: null, created_at: '2026-10-01', updated_at: '2026-10-01' },
      { id: CLOUD_ENV, kind: 'cloud', name: 'Default cloud', workspace_id: WS, created_by: ME, shared: true, network_access: 'restricted', archived_at: null, created_at: '2026-10-02', updated_at: '2026-10-02' },
    ],
    chat_conversations: [{ id: CONV, user_id: ME, workspace_id: WS }],
    local_agent_session: [],
  })
})

/** A chat start's key (the chat tool's scheme), one per call. */
const chatKey = (call: number) => `local-agent:${CONV}:session:s:turn:t:call:${call}`

const start = (over: { macWorker?: boolean; key?: string } = {}) =>
  createSession(svc(), {
    userId: ME,
    workspaceId: WS,
    folderId: FOLDER,
    conversationId: CONV,
    request: 'Tidy up the README',
    mode: 'read',
    startedBy: 'agent',
    ...(over.key ? { idempotencyKey: over.key } : {}),
    ...(over.macWorker === undefined ? {} : { macWorker: over.macWorker }),
  })

/** Make the worker read answer `error`, as PostgREST would. */
function failWorkerRead(error: { message: string; code?: string }) {
  const from = db.from
  db.from = (table: string) => {
    const q = from(table) as Record<string, unknown>
    if (table !== 'environment') return q
    const select = q.select as (p?: string) => unknown
    q.select = (p?: string) => {
      if (p !== 'worker') return select(p)
      const chain: Record<string, unknown> = {}
      chain.eq = () => chain
      chain.maybeSingle = async () => ({ data: null, error })
      return chain
    }
    return q
  }
}

describe('the shape of a worker id', () => {
  it('is the Mac’s own: a lowercase letter, then up to 31 lowercase letters, digits or -', () => {
    for (const ok of ['claude-code', 'codex', 'a', `a${'b'.repeat(31)}`, 'agent-2']) expect(isWorkerId(ok), ok).toBe(true)
    for (const bad of ['', 'Claude', '2fast', '-x', `a${'b'.repeat(32)}`, 'claude code', 'claude_code', ':native', null, 7]) {
      expect(isWorkerId(bad), String(bad)).toBe(false)
    }
  })

  it('cleanWorker: undefined leaves it, null or empty is our own agent, a bad id is a 400', () => {
    expect(cleanWorker(undefined)).toBeUndefined()
    expect(cleanWorker(null)).toBeNull()
    expect(cleanWorker('')).toBeNull()
    expect(cleanWorker('codex')).toBe('codex')
    expect(() => cleanWorker('../../bin/sh')).toThrow(expect.objectContaining({ code: 'bad_request' }))
    expect(() => cleanWorker(['codex'])).toThrow(expect.objectContaining({ code: 'bad_request' }))
  })

  it('a worker’s name: the Mac’s label when it offers it, else one made from the id', () => {
    expect(workerLabel('claude-code')).toBe('Claude Code')
    expect(workerLabel('codex', [{ id: 'codex', label: 'Codex CLI' }])).toBe('Codex CLI')
    expect(workerLabel('codex', [{ id: 'other', label: 'Other' }])).toBe('Codex')
  })
})

describe('the choice on the Mac’s environment', () => {
  const myMac = async () => (await listEnvironments(svc(), { userId: ME, workspaceId: WS })).find((e): e is MacEnvironment => e.kind === 'mac')!

  it('is listed with the Mac: null (our own agent) until the person chooses', async () => {
    expect(await myMac()).toMatchObject({ id: MAC_ENV, worker: null })
    env(MAC_ENV).worker = 'claude-code'
    expect(await myMac()).toMatchObject({ id: MAC_ENV, worker: 'claude-code' })
  })

  it('the owner sets it, clears it (null or empty), and may rename in the same change', async () => {
    expect(await updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { worker: 'codex' } })).toMatchObject({ worker: 'codex' })
    expect(env(MAC_ENV).worker).toBe('codex')
    await updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { worker: null } })
    expect(env(MAC_ENV).worker).toBeNull()
    await updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { name: 'Desk Mac', worker: 'claude-code' } })
    expect(env(MAC_ENV)).toMatchObject({ name: 'Desk Mac', worker: 'claude-code' })
    await updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { worker: '' } })
    expect(env(MAC_ENV).worker).toBeNull()
  })

  it('lists what the Mac last said it offers, and refuses a choice it didn’t offer (or before it said anything)', async () => {
    expect(await myMac()).toMatchObject({ offeredWorkers: [{ id: 'claude-code', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }] })
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { worker: 'gemini-cli' } })).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('doesn’t offer Gemini Cli right now'),
      details: { code: 'WORKER_NOT_OFFERED' },
    })
    env(MAC_ENV).offered_workers = null
    expect(await myMac()).toMatchObject({ offeredWorkers: null })
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { worker: 'codex' } })).rejects.toMatchObject({
      message: expect.stringContaining('hasn’t told Native Intelligence which coding agents it offers yet'),
    })
    // Our own agent needs no offer.
    await updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { worker: null } })
    expect(env(MAC_ENV).worker).toBeNull()
  })

  it('refuses a bad id, someone else’s Mac (as missing) and a cloud environment', async () => {
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { worker: 'Codex' } })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: THEIR_MAC_ENV, patch: { worker: 'codex' } })).rejects.toMatchObject({ code: 'not_found' })
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: CLOUD_ENV, patch: { worker: 'codex' } })).rejects.toMatchObject({ code: 'bad_request' })
    expect(env(MAC_ENV).worker).toBeNull()
    expect(env(THEIR_MAC_ENV).worker).toBeNull()
    expect(env(CLOUD_ENV)).not.toHaveProperty('worker')
  })
})

describe('before PostgREST knows the column (PGRST204) or Postgres does (42703)', () => {
  /** The environment update answers `code`, as PostgREST would. */
  function failWorkerWrite(code: string) {
    const from = db.from
    db.from = (table: string) => {
      const q = from(table) as Record<string, unknown>
      if (table !== 'environment') return q
      const update = q.update as (v: Record<string, unknown>) => unknown
      q.update = (v: Record<string, unknown>) => {
        if (!('worker' in v)) return update(v)
        const chain: Record<string, unknown> = {}
        chain.eq = () => chain
        chain.then = (ok: (r: unknown) => unknown) => Promise.resolve({ data: null, error: { code, message: 'column worker not found' } }).then(ok)
        return chain
      }
      return q
    }
  }

  for (const code of ['PGRST204', '42703']) {
    it(`a worker change answered ${code}: the WORKER_NOT_AVAILABLE sentence, never a bare 500`, async () => {
      failWorkerWrite(code)
      await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { worker: 'codex' } })).rejects.toMatchObject({
        code: 'conflict',
        details: { code: 'WORKER_NOT_AVAILABLE' },
      })
    })
  }
})

describe('a chat start on that Mac', () => {
  it('runs on the chosen coding agent: stamped on the session, and handed to the Mac with the claim', async () => {
    env(MAC_ENV).worker = 'claude-code'
    const { session, created } = await start({ macWorker: true })
    expect(created).toBe(true)
    expect(session.worker).toBe('claude-code')
    expect(db.tables.local_agent_session[0]).toMatchObject({ id: session.id, worker: 'claude-code', environment_id: MAC_ENV })
    const claim = await claimSession(svc(), ME, session.id, { deviceId: MAC, runId: 'run-1', workers: true })
    expect(claim).toMatchObject({ grantId: 'g1', worker: 'claude-code' })
  })

  it('our own agent when none is chosen: no worker on the session, a null one in the claim', async () => {
    const { session } = await start({ macWorker: true })
    expect(db.tables.local_agent_session[0]).not.toHaveProperty('worker')
    expect(session).not.toHaveProperty('worker')
    expect(await claimSession(svc(), ME, session.id, { deviceId: MAC, runId: 'run-1', workers: true })).toMatchObject({ worker: null })
  })

  it('every other start (an action’s Start, a work card, a loop) stays on our own agent, and reads no choice', async () => {
    env(MAC_ENV).worker = 'claude-code'
    failWorkerRead({ message: 'must not be read' })
    const { session } = await start()
    expect(db.tables.local_agent_session[0]).not.toHaveProperty('worker')
    expect(await claimSession(svc(), ME, session.id, { deviceId: MAC, runId: 'run-1', workers: true })).toMatchObject({ worker: null })
  })

  it('a later change of mind never moves a started job', async () => {
    env(MAC_ENV).worker = 'claude-code'
    const { session } = await start({ macWorker: true })
    await updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { worker: null } })
    expect(db.tables.local_agent_session[0].worker).toBe('claude-code')
    expect(await claimSession(svc(), ME, session.id, { deviceId: MAC, runId: 'run-1', workers: true })).toMatchObject({ worker: 'claude-code' })
  })

  it('a choice it can’t read is no start at all, never one on our own agent', async () => {
    env(MAC_ENV).worker = 'claude-code'
    failWorkerRead({ message: 'connection reset', code: '08006' })
    await expect(start({ macWorker: true })).rejects.toThrow('mac worker read failed')
    expect(db.tables.local_agent_session).toEqual([])
  })

  it('before migration 658 (no column yet) no choice can exist: the start runs on our own agent', async () => {
    failWorkerRead({ message: 'column environment.worker does not exist', code: '42703' })
    const { created } = await start({ macWorker: true })
    expect(created).toBe(true)
    expect(db.tables.local_agent_session[0]).not.toHaveProperty('worker')
  })

  it('a retried call gets its first session back, on the agent it started with', async () => {
    env(MAC_ENV).worker = 'codex'
    const first = await start({ macWorker: true, key: 'local-agent:c:session:s:turn:t:call:1' })
    env(MAC_ENV).worker = null
    const again = await start({ macWorker: true, key: 'local-agent:c:session:s:turn:t:call:1' })
    expect(again).toMatchObject({ created: false })
    expect(again.session).toMatchObject({ id: first.session.id, worker: 'codex' })
  })
})

describe('the claim’s worker', () => {
  it('hands on an id, null for none, and refuses anything else (never read as our own agent)', () => {
    expect(claimWorker({ worker: 'claude-code' })).toBe('claude-code')
    expect(claimWorker({ worker: null })).toBeNull()
    expect(claimWorker({})).toBeNull()
    expect(() => claimWorker({ worker: 'Claude Code' })).toThrow('not a coding agent')
    expect(() => claimWorker({ worker: '' })).toThrow('not a coding agent')
  })
})

describe('a chat start in a folder whose job runs on another agent', () => {
  const session = (id: string) => db.tables.local_agent_session.find((r) => r.id === id)!

  it('idle on another agent: that job ends and a new one starts on the chosen agent', async () => {
    const first = await start({ macWorker: true, key: chatKey(1) })
    session(first.session.id).status = 'waiting'
    env(MAC_ENV).worker = 'claude-code'
    const next = await start({ macWorker: true, key: chatKey(2) })
    expect(next).toMatchObject({ created: true })
    expect(next).not.toHaveProperty('joined')
    expect(next.session.id).not.toBe(first.session.id)
    expect(next.session.worker).toBe('claude-code')
    expect(session(first.session.id).status).not.toBe('waiting')
  })

  it('busy on another agent: refused, naming which agent works there and that it must finish or be stopped', async () => {
    env(MAC_ENV).worker = 'claude-code'
    const first = await start({ macWorker: true, key: chatKey(1) })
    env(MAC_ENV).worker = null
    const refused = await start({ macWorker: true, key: chatKey(2) }).catch((e: unknown) => e)
    expect(refused).toMatchObject({
      code: 'conflict',
      details: { code: FOLDER_BUSY_CODE, reason: 'other_worker', session: { id: first.session.id, worker: 'claude-code' } },
    })
    const message = (refused as Error).message
    expect(message).toContain('on the person’s own coding agent (claude-code)')
    expect(message).toContain('this Mac is now set to Native Intelligence’s own agent')
    expect(message).toContain('wait for it to finish, or stop it')
    expect(db.tables.local_agent_session).toHaveLength(1)
  })

  it('the same agent: joined as its next turn, on that agent', async () => {
    env(MAC_ENV).worker = 'codex'
    const first = await start({ macWorker: true, key: chatKey(1) })
    const again = await start({ macWorker: true, key: chatKey(2) })
    expect(again).toMatchObject({ created: false, joined: true })
    expect(again.session).toMatchObject({ id: first.session.id, worker: 'codex' })
  })

  it('every other start keeps today’s rule (no agent check): it joins whatever job it would have', async () => {
    env(MAC_ENV).worker = 'claude-code'
    const first = await start({ macWorker: true, key: chatKey(1) })
    const again = await start({ key: chatKey(2) })
    expect(again).toMatchObject({ joined: true, session: { id: first.session.id } })
  })
})

describe('a claim from a page that predates workers', () => {
  it('fails a job that has a worker, with a sentence telling the person to reload or update; a job without one claims as before', async () => {
    env(MAC_ENV).worker = 'claude-code'
    const { session } = await start({ macWorker: true })
    expect(await claimSession(svc(), ME, session.id, { deviceId: MAC, runId: 'run-1' })).toBeNull()
    expect(db.tables.local_agent_session[0]).toMatchObject({ status: 'failed', error: WORKER_PAGE_OUTDATED_REASON })
    expect(WORKER_PAGE_OUTDATED_REASON).toContain('Reload Native Intelligence on that Mac (or update the app)')

    env(MAC_ENV).worker = null
    const ours = await start({ macWorker: true, key: chatKey(9) })
    expect(await claimSession(svc(), ME, ours.session.id, { deviceId: MAC, runId: 'run-2' })).toMatchObject({ worker: null })
  })
})

describe('the environments list before migration 658', () => {
  it('reads again without the column (every Mac on our own agent) and logs one line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const from = db.from
    db.from = (table: string) => {
      const q = from(table) as Record<string, unknown>
      if (table !== 'environment') return q
      const select = q.select as (p?: string) => unknown
      q.select = (p?: string) => {
        if (!p?.includes('worker')) return select(p)
        const chain: Record<string, unknown> = {}
        chain.eq = () => chain
        chain.then = (ok: (r: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { code: '42703', message: 'column environment.worker does not exist' } }).then(ok)
        return chain
      }
      return q
    }
    env(MAC_ENV).worker = 'claude-code'
    const envs = await listEnvironments(svc(), { userId: ME, workspaceId: WS })
    expect(envs.find((e) => e.id === MAC_ENV)).toMatchObject({ kind: 'mac', name: 'Studio Mac', worker: null })
    await listEnvironments(svc(), { userId: ME, workspaceId: WS })
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('environment.worker is missing')).length).toBeLessThanOrEqual(1)
    warn.mockRestore()
  })
})

describe('what a Mac offers, mirrored from its heartbeat', () => {
  it('cleanWorkerOffers: ids in the worker shape, short plain labels, other keys dropped, each id once, at most 16; not an array: unknown', () => {
    expect(
      cleanWorkerOffers([
        { id: 'claude-code', label: '  Claude\u0007 Code  ', cli: '/bin/sh', extra: 1 },
        { id: 'claude-code', label: 'Again' },
        { id: 'Bad Id', label: 'x' },
        { id: 'codex', label: '' },
        { id: 'long', label: 'L'.repeat(80) },
        // A look-alike of our own agent, in any case or spacing: dropped.
        { id: 'sneaky', label: '  native   INTELLIGENCE ' },
        { id: 'blank', label: '\u0000\u0007' },
        'codex',
        null,
      ]),
    ).toEqual([
      { id: 'claude-code', label: 'Claude Code' },
      { id: 'long', label: 'L'.repeat(40) },
    ])
    expect(cleanWorkerOffers(Array.from({ length: 30 }, (_, i) => ({ id: `agent-${i}`, label: `A ${i}` })))).toHaveLength(OFFERED_WORKERS_MAX)
    expect(cleanWorkerOffers([])).toEqual([])
    for (const raw of [undefined, null, 'claude-code', { id: 'codex' }]) expect(cleanWorkerOffers(raw)).toBeNull()
  })

  const beat = (workers?: unknown) =>
    parseHeartbeat({
      deviceId: MAC, name: 'Studio Mac', platform: 'macos', appVersion: '0.3.1',
      grants: [{ grantId: 'g1', label: 'harbor-site', path: '/p', mode: 'edit', isGit: true }],
      ...(workers === undefined ? {} : { workers }),
    })

  it('the heartbeat writes the list on the Mac’s environment only when it changed; a beat that doesn’t say makes it unknown', async () => {
    const writes = () => db.writes.filter((w) => w.table === 'environment' && w.op === 'update').length
    const before = writes()
    await heartbeat(svc(), ME, beat([{ id: 'claude-code', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }]))
    expect(writes()).toBe(before) // the same as stored: nothing written
    await heartbeat(svc(), ME, beat([{ id: 'codex', label: 'Codex', path: '/usr/bin/codex' }]))
    expect(env(MAC_ENV).offered_workers).toEqual([{ id: 'codex', label: 'Codex' }])
    expect(writes()).toBe(before + 1)
    await heartbeat(svc(), ME, beat())
    expect(env(MAC_ENV).offered_workers).toBeNull()
    // Someone else's Mac is never touched.
    expect(env(THEIR_MAC_ENV).offered_workers).toBeUndefined()
  })

  it('the relay sends the list from the desktop’s status, and nothing when the desktop doesn’t list agents', () => {
    const device = { deviceId: MAC, name: 'Studio Mac', platform: 'macos', appVersion: '0.3.1' }
    expect(heartbeatBody(device, { grants: [], jobs: [], workers: [{ id: 'codex', label: 'Codex' }] })).toMatchObject({ workers: [{ id: 'codex', label: 'Codex' }] })
    expect(heartbeatBody(device, { grants: [], jobs: [] })).not.toHaveProperty('workers')
  })
})
