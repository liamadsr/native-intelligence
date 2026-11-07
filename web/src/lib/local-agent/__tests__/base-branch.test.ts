/**
 * Environments E2/E3, the web half of the base branch: a Mac says what its
 * app can do in its heartbeat (user_device.capabilities, known names only,
 * today `baseBranch`); createSession stamps an EDIT job's base branch from its
 * folder's device_folder_setting.base_branch only on a Mac that says so (an
 * older app keeps branching from HEAD); the claim answers it; and the
 * environments list shows `supportsBaseBranch`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
}))
vi.mock('../ledger', async (orig) => ({ ...(await orig<typeof import('../ledger')>()), ...ledger }))

import { claimBaseBranch, claimSession, heartbeat, parseHeartbeat } from '../device'
import { createSession } from '../store'
import { listEnvironments } from '@/lib/environments/store'
import { CONV, DEVICE, FOLDER, USER, WS, seeded, type FakeDb } from './fake-db'

const READ_FOLDER = '77777777-7777-4777-8777-777777777772'

let db: FakeDb

beforeEach(() => {
  db = seeded({
    device_folder_setting: [{ device_folder_id: FOLDER, base_branch: 'develop', repo_full_name: null }],
    member: [{ workspace_id: WS, user_id: USER, role: 'member' }],
  })
  db.tables.device_folder.push({ id: READ_FOLDER, user_id: USER, device_id: DEVICE, grant_id: 'g2', label: 'notes', path: '/Users/l/notes', mode: 'read', is_git: false, revoked_at: null })
  db.tables.device_folder_setting.push({ device_folder_id: READ_FOLDER, base_branch: 'main', repo_full_name: null })
  ledger.moveTurn.mockClear()
})

const beat = (body: Record<string, unknown> = {}) =>
  parseHeartbeat({ deviceId: DEVICE, name: 'Mac', platform: 'macos', appVersion: '0.2.94', grants: [{ grantId: 'g1', label: 'dial8-website', path: '/p', mode: 'edit', isGit: true }], ...body })

const start = (mode: 'read' | 'edit', folderId = FOLDER) =>
  createSession(db as never, { userId: USER, workspaceId: WS, folderId, conversationId: CONV, request: 'Do it', mode, startedBy: 'agent' })

describe('the heartbeat’s capabilities', () => {
  it('keeps only names this server knows, each once; none sent is none', () => {
    expect(beat({ capabilities: ['baseBranch', 'teleport', 'baseBranch', 7] }).capabilities).toEqual(['baseBranch'])
    expect(beat().capabilities).toEqual([])
    // A field of the wrong shape is dropped, never the beat.
    expect(beat({ capabilities: 'baseBranch' }).capabilities).toEqual([])
    expect(beat({ capabilities: { baseBranch: true } }).capabilities).toEqual([])
  })

  it('writes them on the device, and a beat without them clears them (an older relay never keeps a newer one’s word)', async () => {
    await heartbeat(db as never, USER, beat({ capabilities: ['baseBranch'] }))
    expect(db.tables.user_device[0].capabilities).toEqual(['baseBranch'])
    await heartbeat(db as never, USER, beat())
    expect(db.tables.user_device[0].capabilities).toEqual([])
  })

  it('the environments list says supportsBaseBranch only for a Mac whose app said so', async () => {
    const list = async () => (await listEnvironments(db as never, { userId: USER, workspaceId: WS })).find((e) => e.kind === 'mac')
    expect(await list()).toMatchObject({ supportsBaseBranch: false })
    await heartbeat(db as never, USER, beat({ capabilities: ['baseBranch'] }))
    expect(await list()).toMatchObject({ supportsBaseBranch: true })
  })
})

describe('an edit job’s base branch', () => {
  it('stamped from the folder’s setting on a Mac that resolves one, and answered by the claim', async () => {
    db.tables.user_device[0].capabilities = ['baseBranch']
    const { session } = await start('edit')
    expect(db.tables.local_agent_session[0]).toMatchObject({ id: session.id, base_branch: 'develop' })
    const claim = await claimSession(db as never, USER, session.id, { deviceId: DEVICE, runId: 'run-1' })
    expect(claim).toMatchObject({ mode: 'edit', baseBranch: 'develop' })
  })

  it('never on an older app’s Mac, never on a read job, and a later change to the setting never moves a started job', async () => {
    const older = await start('edit')
    expect(db.tables.local_agent_session[0]).not.toHaveProperty('base_branch')
    expect(await claimSession(db as never, USER, older.session.id, { deviceId: DEVICE, runId: 'run-1' })).toMatchObject({ baseBranch: null })

    db.tables.user_device[0].capabilities = ['baseBranch']
    await start('read', READ_FOLDER)
    expect(db.tables.local_agent_session.find((s) => s.folder_id === READ_FOLDER)).not.toHaveProperty('base_branch')

    db.tables.device_folder_setting[0].base_branch = 'release'
    expect(db.tables.local_agent_session[0].base_branch).toBeUndefined()
  })

  it('a setting that no longer matches the strict pattern is no base (HEAD)', async () => {
    db.tables.user_device[0].capabilities = ['baseBranch']
    db.tables.device_folder_setting[0].base_branch = '@{-1}'
    await start('edit')
    expect(db.tables.local_agent_session[0]).not.toHaveProperty('base_branch')
  })

  it('the claim hands on only an edit job’s, and only a name', () => {
    expect(claimBaseBranch({ mode: 'edit', base_branch: 'main' })).toBe('main')
    expect(claimBaseBranch({ mode: 'read', base_branch: 'main' })).toBeNull()
    for (const bad of ['HEAD~1', 'refs/heads/../x', '--upload-pack=x', '', null, undefined]) {
      expect(claimBaseBranch({ mode: 'edit', base_branch: bad as never }), String(bad)).toBeNull()
    }
  })
})
