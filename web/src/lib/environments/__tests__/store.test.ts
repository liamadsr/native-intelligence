/**
 * The environments library (migration 420) against the in-memory service
 * client: who sees and changes what (owner, member, creator, admin, for both
 * kinds), the masks, the validation at the boundary, defaults, and "Remove
 * this Mac". The SQL's own rules are pinned in migration-420.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const ledger = vi.hoisted(() => ({
  moveTurn: vi.fn(async (_svc: unknown, s: unknown) => s),
  startTurnRow: vi.fn(async () => 'job-1'),
}))
vi.mock('@/lib/local-agent/ledger', async (orig) => ({ ...(await orig<typeof import('@/lib/local-agent/ledger')>()), ...ledger }))

import { fakeDb, type FakeDb, type Row } from '@/lib/local-agent/__tests__/fake-db'
import {
  archiveEnvironment,
  createCloudEnvironment,
  ensureMacEnvironment,
  getDefault,
  getEnvironment,
  listEnvironments,
  removeMac,
  setDefault,
  setFolderSetting,
  updateEnvironment,
} from '../store'
import { EnvironmentError, MAC_BUSY_CODE, ENVIRONMENT_IN_USE_CODE, type CloudEnvironment, type MacEnvironment } from '../types'

const ME = '11111111-1111-4111-8111-111111111111'
const TEAMMATE = '22222222-2222-4222-8222-222222222222'
const ADMIN = '33333333-3333-4333-8333-333333333333'
const OUTSIDER = '44444444-4444-4444-8444-444444444440'
const WS = '55555555-5555-4555-8555-555555555555'
const OTHER_WS = '66666666-6666-4666-8666-666666666666'
const MAC = '77777777-7777-4777-8777-777777777777'
const OLD_MAC = '77777777-7777-4777-8777-777777777778'
const TEAMMATE_MAC = '77777777-7777-4777-8777-777777777779'
const FOLDER = '88888888-8888-4888-8888-888888888881'
const FOLDER_GONE = '88888888-8888-4888-8888-888888888882'
const FOLDER_TEAMMATE = '88888888-8888-4888-8888-888888888883'
const MAC_ENV = '99999999-9999-4999-8999-999999999901'
const TEAMMATE_MAC_ENV = '99999999-9999-4999-8999-999999999902'
const SHARED = '99999999-9999-4999-8999-999999999903'
const MINE_ONLY = '99999999-9999-4999-8999-999999999904'
const THEIRS_ONLY = '99999999-9999-4999-8999-999999999905'
const ARCHIVED = '99999999-9999-4999-8999-999999999906'
const ELSEWHERE = '99999999-9999-4999-8999-999999999907'
const PROJECT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CONV = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

const recent = () => new Date(Date.now() - 30_000).toISOString()
const stale = '2026-01-01T00:00:00.000Z'

function cloud(id: string, over: Row = {}): Row {
  return {
    id, kind: 'cloud', name: `env ${id.slice(-2)}`, workspace_id: WS, created_by: TEAMMATE, shared: true,
    network_access: 'restricted', env_vars: 'TOKEN=abc', setup_script: 'npm ci', archived_at: null,
    owner_user_id: null, device_id: null, created_at: `2026-10-0${id.slice(-1)}T00:00:00Z`, updated_at: '2026-10-10T00:00:00Z',
    ...over,
  }
}

function mac(id: string, userId: string, deviceId: string, name: string): Row {
  return {
    id, kind: 'mac', name, owner_user_id: userId, device_id: deviceId, workspace_id: null, created_by: null, shared: null,
    network_access: null, env_vars: null, setup_script: null, archived_at: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  }
}

let db: FakeDb
const svc = () => db as never

beforeEach(() => {
  for (const f of Object.values(ledger)) f.mockClear()
  db = fakeDb({
    member: [
      { workspace_id: WS, user_id: ME, role: 'member' },
      { workspace_id: WS, user_id: TEAMMATE, role: 'member' },
      { workspace_id: WS, user_id: ADMIN, role: 'admin' },
      { workspace_id: OTHER_WS, user_id: ME, role: 'owner' },
    ],
    workspace: [{ id: WS, default_cloud_environment_id: SHARED }, { id: OTHER_WS, default_cloud_environment_id: null }],
    user_device: [
      { user_id: ME, id: MAC, name: 'Liam’s MacBook Pro', platform: 'macos', app_version: '0.2.93', last_seen_at: recent() },
      { user_id: ME, id: OLD_MAC, name: '', platform: 'macos', app_version: '0.2.80', last_seen_at: stale },
      { user_id: TEAMMATE, id: TEAMMATE_MAC, name: 'Dana’s Mac', platform: 'macos', app_version: '0.2.93', last_seen_at: recent() },
    ],
    device_folder: [
      { id: FOLDER, user_id: ME, device_id: MAC, grant_id: 'g1', label: 'dial8-website', path: '/Users/l/code/dial8-website', mode: 'edit', is_git: true, revoked_at: null },
      { id: FOLDER_GONE, user_id: ME, device_id: MAC, grant_id: 'g2', label: 'old', path: '/Users/l/old', mode: 'read', is_git: false, revoked_at: stale },
      { id: FOLDER_TEAMMATE, user_id: TEAMMATE, device_id: TEAMMATE_MAC, grant_id: 'g3', label: 'theirs', path: '/Users/d/x', mode: 'edit', is_git: true, revoked_at: null },
    ],
    device_folder_setting: [{ device_folder_id: FOLDER, base_branch: 'main', repo_full_name: 'dial8/website' }],
    environment: [
      // OLD_MAC has no environment yet: it heartbeat between migration 420 and the deploy.
      mac(MAC_ENV, ME, MAC, 'Liam’s MacBook Pro'),
      mac(TEAMMATE_MAC_ENV, TEAMMATE, TEAMMATE_MAC, 'Dana’s Mac'),
      cloud(SHARED),
      cloud(MINE_ONLY, { created_by: ME, shared: false }),
      cloud(THEIRS_ONLY, { shared: false }),
      cloud(ARCHIVED, { archived_at: stale }),
      cloud(ELSEWHERE, { workspace_id: OTHER_WS }),
    ],
    projects: [{ id: PROJECT, workspace_id: WS, environment_id: SHARED }],
    chat_conversations: [{ id: CONV, user_id: ME, workspace_id: WS, environment_id: SHARED }],
    environment_default: [],
    local_agent_session: [],
  })
})

const cloudOf = (envs: Awaited<ReturnType<typeof listEnvironments>>) => envs.filter((e): e is CloudEnvironment => e.kind === 'cloud')
const macsOf = (envs: Awaited<ReturnType<typeof listEnvironments>>) => envs.filter((e): e is MacEnvironment => e.kind === 'mac')

describe('listEnvironments', () => {
  it('my Macs first (most recently online first), each with its live folders and their settings, never a path', async () => {
    const envs = await listEnvironments(svc(), { userId: ME, workspaceId: WS })
    expect(envs.map((e) => e.kind)).toEqual(['mac', 'mac', 'cloud', 'cloud'])
    const [mine, old] = macsOf(envs)
    expect(mine).toMatchObject({ id: MAC_ENV, name: 'Liam’s MacBook Pro', deviceId: MAC, online: true, appVersion: '0.2.93' })
    expect(mine.folders).toEqual([{ id: FOLDER, label: 'dial8-website', mode: 'edit', isGit: true, baseBranch: 'main', repoFullName: 'dial8/website' }])
    expect(JSON.stringify(envs)).not.toContain('/Users/')
    // The Mac with no environment got one, named by the fallback.
    expect(old).toMatchObject({ deviceId: OLD_MAC, name: 'My Mac', online: false, folders: [] })
    expect(db.tables.environment.filter((e) => e.device_id === OLD_MAC)).toHaveLength(1)
    // Never a teammate's Mac.
    expect(envs.some((e) => e.id === TEAMMATE_MAC_ENV)).toBe(false)
  })

  it('a member sees the shared ones and their own "only me", never someone else’s, an archived or another workspace’s', async () => {
    const ids = cloudOf(await listEnvironments(svc(), { userId: ME, workspaceId: WS })).map((e) => e.id)
    expect(ids).toEqual([SHARED, MINE_ONLY])
  })

  it('an admin sees every one of the workspace', async () => {
    const ids = cloudOf(await listEnvironments(svc(), { userId: ADMIN, workspaceId: WS })).map((e) => e.id)
    expect(ids).toEqual([SHARED, MINE_ONLY, THEIRS_ONLY])
  })

  it('env vars and setup script: in full for the creator and admins, masked for other members', async () => {
    const mine = cloudOf(await listEnvironments(svc(), { userId: ME, workspaceId: WS }))
    expect(mine.find((e) => e.id === SHARED)).toMatchObject({
      canEdit: false, envVars: null, setupScript: null, secretsHidden: true, hasEnvVars: true, hasSetupScript: true,
      isWorkspaceDefault: true, projectCount: 1,
    })
    expect(mine.find((e) => e.id === MINE_ONLY)).toMatchObject({ canEdit: true, envVars: 'TOKEN=abc', setupScript: 'npm ci', secretsHidden: false, shared: false })
    const admin = cloudOf(await listEnvironments(svc(), { userId: ADMIN, workspaceId: WS }))
    expect(admin.find((e) => e.id === SHARED)).toMatchObject({ canEdit: true, envVars: 'TOKEN=abc', secretsHidden: false })
  })

  it('someone outside the workspace sees only their own Macs', async () => {
    expect(await listEnvironments(svc(), { userId: OUTSIDER, workspaceId: WS })).toEqual([])
  })
})

describe('getEnvironment', () => {
  it('my Mac, my workspace’s visible cloud ones; nothing of anyone else’s', async () => {
    expect((await getEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV }))?.kind).toBe('mac')
    expect(await getEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: TEAMMATE_MAC_ENV })).toBeNull()
    expect(await getEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: THEIRS_ONLY })).toBeNull()
    expect(await getEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: ELSEWHERE })).toBeNull()
    expect(await getEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: 'not-a-uuid' })).toBeNull()
    // An archived one is still readable by id (a run's page names it).
    expect(await getEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: ARCHIVED })).toMatchObject({ kind: 'cloud', archivedAt: stale })
  })
})

describe('createCloudEnvironment', () => {
  it('defaults to restricted and shared, made by the caller', async () => {
    const env = await createCloudEnvironment(svc(), { userId: ME, workspaceId: WS, name: '  Staging  ' })
    expect(env).toMatchObject({ kind: 'cloud', name: 'Staging', networkAccess: 'restricted', shared: true, createdBy: ME, canEdit: true })
  })

  it('"only me", and every field validated at the boundary', async () => {
    expect((await createCloudEnvironment(svc(), { userId: ME, workspaceId: WS, name: 'Me', shared: false, networkAccess: 'isolated', envVars: 'A=1', setupScript: 'make' }))).toMatchObject({ shared: false, networkAccess: 'isolated', envVars: 'A=1', setupScript: 'make' })
    for (const bad of [{ name: '' }, { name: 'x'.repeat(81) }, { name: 'ok', networkAccess: 'open' }, { name: 'ok', shared: 'yes' }, { name: 42 }]) {
      await expect(createCloudEnvironment(svc(), { userId: ME, workspaceId: WS, ...bad })).rejects.toMatchObject({ code: 'bad_request' })
    }
  })

  it('an 80-character name counts characters, not UTF-16 units', async () => {
    const name = '🙂'.repeat(80)
    expect((await createCloudEnvironment(svc(), { userId: ME, workspaceId: WS, name })).name).toBe(name)
  })

  it('a non-member can’t', async () => {
    await expect(createCloudEnvironment(svc(), { userId: OUTSIDER, workspaceId: WS, name: 'x' })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('updateEnvironment', () => {
  it('a Mac: its owner renames it; nothing else may be set on it', async () => {
    const env = await updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { name: 'Work Mac' } })
    expect(env).toMatchObject({ kind: 'mac', name: 'Work Mac' })
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { envVars: 'NODE_OPTIONS=--require x' } })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { setupScript: 'curl x | sh' } })).rejects.toMatchObject({ code: 'bad_request' })
    expect(db.tables.environment.find((e) => e.id === MAC_ENV)).toMatchObject({ env_vars: null, setup_script: null })
  })

  it('someone else’s Mac reads as missing', async () => {
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: TEAMMATE_MAC_ENV, patch: { name: 'Mine' } })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('a cloud one: a member who didn’t make it may not change it; its creator and an admin may', async () => {
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: SHARED, patch: { networkAccess: 'trusted' } })).rejects.toMatchObject({ code: 'forbidden' })
    expect(await updateEnvironment(svc(), { userId: TEAMMATE, workspaceId: WS, environmentId: SHARED, patch: { networkAccess: 'isolated' } })).toMatchObject({ networkAccess: 'isolated' })
    expect(await updateEnvironment(svc(), { userId: ADMIN, workspaceId: WS, environmentId: SHARED, patch: { envVars: 'B=2', setupScript: null } })).toMatchObject({ envVars: 'B=2', setupScript: null })
  })

  it('one I can’t see reads as missing, and so does another workspace’s or an archived one', async () => {
    for (const id of [THEIRS_ONLY, ELSEWHERE, ARCHIVED]) {
      await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: id, patch: { name: 'x' } })).rejects.toMatchObject({ code: 'not_found' })
    }
  })

  it('one a project or the workspace default uses stays shared', async () => {
    await expect(updateEnvironment(svc(), { userId: ADMIN, workspaceId: WS, environmentId: SHARED, patch: { shared: false } })).rejects.toMatchObject({
      code: 'conflict', details: { code: ENVIRONMENT_IN_USE_CODE },
    })
    db.tables.projects[0].environment_id = null
    await expect(updateEnvironment(svc(), { userId: ADMIN, workspaceId: WS, environmentId: SHARED, patch: { shared: false } })).rejects.toMatchObject({ code: 'conflict' })
    db.tables.workspace[0].default_cloud_environment_id = null
    expect(await updateEnvironment(svc(), { userId: ADMIN, workspaceId: WS, environmentId: SHARED, patch: { shared: false } })).toMatchObject({ shared: false })
  })

  it('a project linked between the check and the write (environment_guard refuses, 42501) is the same 409', async () => {
    db.tables.projects[0].environment_id = null
    db.tables.workspace[0].default_cloud_environment_id = null
    const from = db.from
    db.from = (t: string) => {
      const c = from(t) as Record<string, unknown>
      if (t === 'environment') {
        c.update = () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ error: { code: '42501', message: 'must stay shared' } }) }) }) })
      }
      return c
    }
    await expect(updateEnvironment(svc(), { userId: ADMIN, workspaceId: WS, environmentId: SHARED, patch: { shared: false } })).rejects.toMatchObject({
      code: 'conflict', details: { code: ENVIRONMENT_IN_USE_CODE },
    })
  })

  it('nothing to change is a 400', async () => {
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MINE_ONLY, patch: {} })).rejects.toBeInstanceOf(EnvironmentError)
  })
})

describe('archiveEnvironment', () => {
  it('a Mac is removed, not archived', async () => {
    await expect(archiveEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV })).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('a member who didn’t make it can’t', async () => {
    await expect(archiveEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: SHARED })).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('refused while a project or the workspace default uses it, saying how many and which: nothing is moved for the person', async () => {
    const env = () => db.tables.environment.find((e) => e.id === SHARED)!
    await expect(archiveEnvironment(svc(), { userId: ADMIN, workspaceId: WS, environmentId: SHARED })).rejects.toMatchObject({
      code: 'conflict',
      message: 'This environment can’t be archived while 1 project uses it, and it is the workspace’s default cloud environment. Pick another environment for them first.',
      details: { code: ENVIRONMENT_IN_USE_CODE, projects: 1, workspaceDefault: true },
    })
    db.tables.projects[0].environment_id = null
    await expect(archiveEnvironment(svc(), { userId: ADMIN, workspaceId: WS, environmentId: SHARED })).rejects.toMatchObject({
      details: { projects: 0, workspaceDefault: true },
    })
    expect(env().archived_at).toBeNull()
    expect(db.tables.workspace[0].default_cloud_environment_id).toBe(SHARED)
  })

  it('once nothing starts runs in it, an admin archives it; chats and personal defaults naming it are left to fall back when read', async () => {
    db.tables.projects[0].environment_id = null
    db.tables.workspace[0].default_cloud_environment_id = null
    db.tables.environment_default.push({ id: 'd1', user_id: ME, workspace_id: WS, project_id: null, environment_id: SHARED })
    expect(await archiveEnvironment(svc(), { userId: ADMIN, workspaceId: WS, environmentId: SHARED })).toEqual({ archived: true })
    expect(db.tables.environment.find((e) => e.id === SHARED)?.archived_at).toEqual(expect.any(String))
    expect(db.tables.chat_conversations[0].environment_id).toBe(SHARED)
    expect(await getDefault(svc(), { userId: ME, workspaceId: WS })).toBeNull()
    // Archiving twice is a no-op.
    expect(await archiveEnvironment(svc(), { userId: ADMIN, workspaceId: WS, environmentId: SHARED })).toEqual({ archived: true })
  })

  it('a project linked between the check and the write (environment_guard refuses, 42501) is the same 409', async () => {
    db.tables.projects[0].environment_id = null
    db.tables.workspace[0].default_cloud_environment_id = null
    const from = db.from
    db.from = (t: string) => {
      const c = from(t) as Record<string, unknown>
      if (t === 'environment') c.update = () => ({ eq: () => ({ eq: () => ({ eq: async () => ({ error: { code: '42501', message: 'can’t be archived' } }) }) }) })
      return c
    }
    await expect(archiveEnvironment(svc(), { userId: ADMIN, workspaceId: WS, environmentId: SHARED })).rejects.toMatchObject({
      code: 'conflict', details: { code: ENVIRONMENT_IN_USE_CODE },
    })
  })
})

describe('setFolderSetting', () => {
  it('the owner sets a base branch and a linked repo; a missing key keeps one, null clears it', async () => {
    expect(await setFolderSetting(svc(), { userId: ME, deviceFolderId: FOLDER, baseBranch: 'release/2026-10' })).toEqual({
      deviceFolderId: FOLDER, baseBranch: 'release/2026-10', repoFullName: 'dial8/website',
    })
    expect(await setFolderSetting(svc(), { userId: ME, deviceFolderId: FOLDER, repoFullName: null })).toMatchObject({ baseBranch: 'release/2026-10', repoFullName: null })
    expect(await setFolderSetting(svc(), { userId: ME, deviceFolderId: FOLDER, baseBranch: '' })).toMatchObject({ baseBranch: null })
  })

  it.each(['@{-1}', 'HEAD~1', '--upload-pack=x', '-x', 'a..b', 'main.lock', 'main/', 'main.', 'a//b', 'x'.repeat(101), 'two words'])(
    'refuses %s as a base branch',
    async (baseBranch) => {
      await expect(setFolderSetting(svc(), { userId: ME, deviceFolderId: FOLDER, baseBranch })).rejects.toMatchObject({ code: 'bad_request' })
    },
  )

  it.each(['dial8', 'a/b/c', 'https://github.com/a/b', 'x'.repeat(40) + '/repo'])('refuses %s as a linked repo', async (repoFullName) => {
    await expect(setFolderSetting(svc(), { userId: ME, deviceFolderId: FOLDER, repoFullName })).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('someone else’s folder, or one the Mac no longer shares, reads as missing', async () => {
    await expect(setFolderSetting(svc(), { userId: ME, deviceFolderId: FOLDER_TEAMMATE, baseBranch: 'main' })).rejects.toMatchObject({ code: 'not_found' })
    await expect(setFolderSetting(svc(), { userId: ME, deviceFolderId: FOLDER_GONE, baseBranch: 'main' })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('setDefault / getDefault', () => {
  it('my workspace default: my Mac, then a shared cloud one (one row, updated)', async () => {
    expect(await setDefault(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV })).toEqual({ environmentId: MAC_ENV, projectId: null })
    expect(await getDefault(svc(), { userId: ME, workspaceId: WS })).toBe(MAC_ENV)
    await setDefault(svc(), { userId: ME, workspaceId: WS, environmentId: SHARED })
    expect(db.tables.environment_default).toHaveLength(1)
    expect(await getDefault(svc(), { userId: ME, workspaceId: WS })).toBe(SHARED)
  })

  it('my own "only me" one is allowed; someone else’s Mac or "only me", another workspace’s or an archived one are not', async () => {
    expect((await setDefault(svc(), { userId: ME, workspaceId: WS, environmentId: MINE_ONLY })).environmentId).toBe(MINE_ONLY)
    for (const id of [TEAMMATE_MAC_ENV, THEIRS_ONLY, ELSEWHERE]) {
      await expect(setDefault(svc(), { userId: ME, workspaceId: WS, environmentId: id })).rejects.toMatchObject({ code: 'not_found' })
    }
    await expect(setDefault(svc(), { userId: ME, workspaceId: WS, environmentId: ARCHIVED })).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('a project default ("run this project’s work on my Mac") is my own Mac only', async () => {
    expect(await setDefault(svc(), { userId: ME, workspaceId: WS, projectId: PROJECT, environmentId: MAC_ENV })).toEqual({ environmentId: MAC_ENV, projectId: PROJECT })
    expect(await getDefault(svc(), { userId: ME, workspaceId: WS, projectId: PROJECT })).toBe(MAC_ENV)
    await expect(setDefault(svc(), { userId: ME, workspaceId: WS, projectId: PROJECT, environmentId: SHARED })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(setDefault(svc(), { userId: ME, workspaceId: WS, projectId: '00000000-0000-4000-8000-000000000000', environmentId: MAC_ENV })).rejects.toMatchObject({ code: 'not_found' })
    // The workspace default is a separate row.
    expect(await getDefault(svc(), { userId: ME, workspaceId: WS })).toBeNull()
  })

  it('null clears it; a default that can’t be used any more reads as none', async () => {
    await setDefault(svc(), { userId: ME, workspaceId: WS, environmentId: SHARED })
    db.tables.environment.find((e) => e.id === SHARED)!.archived_at = stale
    expect(await getDefault(svc(), { userId: ME, workspaceId: WS })).toBeNull()
    expect(await setDefault(svc(), { userId: ME, workspaceId: WS, environmentId: null })).toEqual({ environmentId: null, projectId: null })
    expect(db.tables.environment_default).toEqual([])
  })

  it('a non-member can’t set one', async () => {
    await expect(setDefault(svc(), { userId: OUTSIDER, workspaceId: WS, environmentId: SHARED })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('ensureMacEnvironment', () => {
  it('makes one per Mac, once, named after it', async () => {
    const NEW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    db.tables.user_device.push({ user_id: ME, id: NEW, name: '  Studio  ', last_seen_at: recent() })
    const id = await ensureMacEnvironment(svc(), ME, NEW, '  Studio  ')
    expect(await ensureMacEnvironment(svc(), ME, NEW, 'Renamed on the Mac')).toBe(id)
    const rows = db.tables.environment.filter((e) => e.device_id === NEW)
    expect(rows).toEqual([expect.objectContaining({ id, kind: 'mac', name: 'Studio', owner_user_id: ME })])
  })
})

describe('removeMac (a soft remove: nothing is deleted)', () => {
  function session(status: string, over: Row = {}): Row {
    return {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', user_id: ME, workspace_id: WS, device_id: MAC, folder_id: FOLDER, conversation_id: CONV,
      started_by: 'person', mode: 'read', request: 'look', status, current_turn: 1, idempotency_key: null,
      lease_expires_at: new Date(Date.now() + 60_000).toISOString(), expires_at: new Date(Date.now() + 3600_000).toISOString(),
      updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
      ...over,
    }
  }
  const device = () => db.tables.user_device.find((d) => d.id === MAC)!

  it('refused while a job is open on it, and its mark is taken back', async () => {
    db.tables.local_agent_session.push(session('running'))
    await expect(removeMac(svc(), ME, MAC)).rejects.toMatchObject({ code: 'conflict', details: { code: MAC_BUSY_CODE } })
    expect(device().removed_at ?? null).toBeNull()
    expect(db.tables.device_folder.find((f) => f.id === FOLDER)?.revoked_at).toBeNull()
    expect(db.tables.environment.find((e) => e.id === MAC_ENV)?.archived_at).toBeNull()
  })

  it('a job the reaper settles (queued past its expiry) doesn’t hold it', async () => {
    db.tables.local_agent_session.push(session('queued', { expires_at: stale, lease_expires_at: null }))
    expect(await removeMac(svc(), ME, MAC)).toEqual({ removed: true })
  })

  it('marks the Mac removed, revokes its folders and archives its environment; its history, ids and settings stay', async () => {
    db.tables.local_agent_session.push(session('waiting', { status: 'cancelled', branch: 'dial8/x-1', pr_url: 'https://github.com/a/b/pull/1' }))
    expect(await removeMac(svc(), ME, MAC)).toEqual({ removed: true })
    expect(device().removed_at).toEqual(expect.any(String))
    expect(db.tables.device_folder.find((f) => f.id === FOLDER)?.revoked_at).toEqual(expect.any(String))
    expect(db.tables.environment.find((e) => e.id === MAC_ENV)?.archived_at).toEqual(expect.any(String))
    // Nothing deleted: the session (its branch and PR), the folder row and its setting, the environment row.
    expect(db.tables.local_agent_session[0]).toMatchObject({ branch: 'dial8/x-1', pr_url: 'https://github.com/a/b/pull/1' })
    expect(db.tables.device_folder_setting).toEqual([expect.objectContaining({ device_folder_id: FOLDER, base_branch: 'main' })])
    expect(db.writes.some((w) => w.op === 'delete')).toBe(false)
    // It leaves the lists, and can't be renamed or made a default.
    expect(macsOf(await listEnvironments(svc(), { userId: ME, workspaceId: WS })).map((m) => m.deviceId)).toEqual([OLD_MAC])
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV, patch: { name: 'x' } })).rejects.toMatchObject({ code: 'not_found' })
    await expect(setDefault(svc(), { userId: ME, workspaceId: WS, environmentId: MAC_ENV })).rejects.toMatchObject({ code: 'bad_request' })
  })

  it('removing a removed Mac is a no-op', async () => {
    await removeMac(svc(), ME, MAC)
    const at = device().removed_at
    expect(await removeMac(svc(), ME, MAC)).toEqual({ removed: true })
    expect(device().removed_at).toBe(at)
  })

  it('someone else’s Mac reads as missing', async () => {
    await expect(removeMac(svc(), ME, TEAMMATE_MAC)).rejects.toMatchObject({ code: 'not_found' })
    await expect(removeMac(svc(), ME, 'nope')).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('env vars and setup script sizes', () => {
  it('at most 64 KB each, in bytes (migration 420’s checks)', async () => {
    const big = 'é'.repeat(32_769) // 65,538 bytes
    await expect(createCloudEnvironment(svc(), { userId: ME, workspaceId: WS, name: 'x', envVars: big })).rejects.toMatchObject({ code: 'bad_request' })
    await expect(updateEnvironment(svc(), { userId: ME, workspaceId: WS, environmentId: MINE_ONLY, patch: { setupScript: big } })).rejects.toMatchObject({ code: 'bad_request' })
    expect((await createCloudEnvironment(svc(), { userId: ME, workspaceId: WS, name: 'x', envVars: 'a'.repeat(65_536) })).envVars).toHaveLength(65_536)
  })
})
