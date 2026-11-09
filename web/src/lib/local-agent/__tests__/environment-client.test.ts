// @vitest-environment jsdom
/**
 * The person's environment on the client (src/lib/local-agent/environment-client.ts):
 * the shared store the side panel's Environment card and the composer's chips read.
 *
 * Pinned:
 *   - the route's answer parsed (malformed rows dropped, presence without lastSeenAt);
 *   - a path's parent with HOME as `~`, a branch cut in the middle;
 *   - one read at a time, a fresh read skipped, a forced one after an add or a remove;
 *   - add: the Mac's picker, the heartbeat (the mirror gives the grant an id), a read;
 *   - remove: on THIS Mac only (removeGrant), the heartbeat, a read; Rust's refusal
 *     (a local agent working there) is the toast and the folder stays; a grant Rust
 *     no longer knows counts as removed; a removed folder stays hidden while the
 *     server still lists it;
 *   - the web: nothing to add or remove.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: toastError, success: vi.fn() }) }))
vi.mock('../relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))

import {
  ENVIRONMENT_URL,
  abbreviateHome,
  addEnvironmentFolder,
  checkLocalAgents,
  configureEnvironment,
  folderParent,
  getEnvironmentSnapshot,
  parseEnvironment,
  refreshEnvironment,
  removeEnvironmentFolder,
  resetEnvironmentStore,
  truncateMiddle,
  type EnvironmentDeps,
} from '../environment-client'
import type { LocalAgentStatus } from '@/lib/tauri-bridge'

const THIS_MAC = 'dev-this'
const FOLDER = {
  id: 'f-1',
  deviceId: THIS_MAC,
  grantId: 'g-1',
  label: 'dial8-website',
  path: '/Users/liam/code/dial8-v2/dial8-website',
  mode: 'edit',
  isGit: true,
  deviceName: "Liam's MacBook Pro",
  online: true,
}
const OTHER_MAC_FOLDER = { ...FOLDER, id: 'f-2', deviceId: 'dev-studio', grantId: 'g-9', label: 'notes', deviceName: 'Studio', mode: 'read' }
const STATUS = { available: true, reason: null, node: null, agentDir: null, built: true, grants: [], jobs: [] } as LocalAgentStatus

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** The route, with folders the test moves. */
function server(folders: Array<Record<string, unknown>> = [FOLDER]) {
  const state = { folders: [...folders], worktrees: [] as Array<Record<string, unknown>> }
  const fetch = vi.fn(async (url: string) => {
    if (url !== ENVIRONMENT_URL) return json({ error: 'nope' }, 404)
    return json({ devices: [{ id: THIS_MAC, name: "Liam's MacBook Pro", online: true, lastSeenAt: new Date().toISOString() }], folders: state.folders, worktrees: state.worktrees })
  })
  return { state, fetch }
}

let now = 1_000_000
function deps(s: ReturnType<typeof server>, over: Partial<EnvironmentDeps> = {}): Partial<EnvironmentDeps> {
  return {
    fetch: s.fetch as never,
    isDesktop: () => true,
    status: async () => STATUS,
    device: async () => ({ ok: true as const, value: { deviceId: THIS_MAC, name: "Liam's MacBook Pro", platform: 'macos', appVersion: '0.3.0' } }),
    pickFolder: async () => ({ ok: true as const, value: { id: 'g-1', path: FOLDER.path, label: 'dial8-website', mode: 'edit' as const, addedAt: 't', isGit: true } }),
    removeGrant: vi.fn(async () => ({ ok: true as const, value: undefined })),
    refreshMirror: vi.fn(async () => ({ folders: [{ id: 'f-1', grantId: 'g-1', label: 'dial8-website', mode: 'edit' as const, isGit: true }] })),
    stop: vi.fn(async () => ({ ok: true as const, value: undefined })),
    now: () => now,
    sleep: async (ms: number) => {
      now += ms
    },
    ...over,
  }
}

/** A Rust job in a folder, as `local_agent_status` lists it. */
const job = (over: Record<string, unknown>) =>
  ({ id: 'job-1', grantId: 'g-1', request: 'r', mode: 'edit', sessionId: 's', streamIndex: 1, status: 'waiting', live: true, lastSeq: 3, runId: 'run', branch: null, commit: null, createdAt: 't', endedAt: null, ...over }) as never

beforeEach(() => {
  resetEnvironmentStore()
  toastError.mockClear()
  now = 1_000_000
})
afterEach(() => configureEnvironment(null))

describe('the pure pieces', () => {
  it('parses the route’s answer, dropping malformed rows; null when it is not one', () => {
    const env = parseEnvironment({
      devices: [{ id: 'd', name: 'Mac', online: true, lastSeenAt: 'x' }, { name: 'no id' }],
      folders: [FOLDER, { label: 'no id' }, null, { ...FOLDER, id: 'f-x', mode: 'admin' }],
      worktrees: [{ sessionId: 's', folderId: 'f-1', branch: 'dial8/x', live: true }, { sessionId: 's2', folderId: 'f-1' }],
    })
    expect(env?.devices).toEqual([{ id: 'd', name: 'Mac', online: true }])
    expect(env?.folders.map((f) => [f.id, f.mode])).toEqual([['f-1', 'edit'], ['f-x', 'read']])
    expect(env?.worktrees).toEqual([{ sessionId: 's', folderId: 'f-1', branch: 'dial8/x', live: true }])
    expect(parseEnvironment({ error: 'x' })).toBeNull()
    expect(parseEnvironment(null)).toBeNull()
  })

  it('HOME as ~, a folder’s parent, a branch cut in the middle', () => {
    expect(abbreviateHome('/Users/liam/code')).toBe('~/code')
    expect(abbreviateHome('/Users/liam')).toBe('~')
    expect(abbreviateHome('/Volumes/Work/x')).toBe('/Volumes/Work/x')
    expect(folderParent('/Users/sam/code/dial8-v2/dial8-website')).toBe('~/code/dial8-v2')
    expect(folderParent('/Users/liam/notes/')).toBe('~')
    expect(folderParent('/srv')).toBe('')
    const cut = truncateMiddle('claude/agent-orchestration-local-fc09cf', 26)
    expect(cut).toHaveLength(26)
    expect(cut.startsWith('claude/agent-')).toBe(true)
    expect(cut.endsWith('cal-fc09cf')).toBe(true)
    expect(cut).toContain('…')
    expect(truncateMiddle('dial8/short', 26)).toBe('dial8/short')
  })
})

describe('reading', () => {
  it('one read at a time; a fresh one skipped; a forced one runs after the one in flight', async () => {
    const s = server()
    configureEnvironment(deps(s))
    await Promise.all([refreshEnvironment(), refreshEnvironment()])
    expect(s.fetch).toHaveBeenCalledTimes(1)
    expect(getEnvironmentSnapshot()).toMatchObject({ loaded: true })
    expect(getEnvironmentSnapshot().folders.map((f) => f.id)).toEqual(['f-1'])
    await refreshEnvironment({ maxAgeMs: 5000 })
    expect(s.fetch).toHaveBeenCalledTimes(1)
    now += 6000
    await refreshEnvironment({ maxAgeMs: 5000 })
    expect(s.fetch).toHaveBeenCalledTimes(2)
    await Promise.all([refreshEnvironment(), refreshEnvironment({ force: true })])
    expect(s.fetch).toHaveBeenCalledTimes(4)
  })

  it('an unchanged read keeps the same snapshot (no redraw); a failed one keeps what is shown', async () => {
    const s = server()
    configureEnvironment(deps(s))
    await refreshEnvironment()
    const first = getEnvironmentSnapshot()
    await refreshEnvironment({ force: true })
    expect(getEnvironmentSnapshot()).toBe(first)
    s.fetch.mockResolvedValueOnce(json({ error: 'x' }, 500))
    await refreshEnvironment({ force: true })
    expect(getEnvironmentSnapshot()).toBe(first)
  })

  it('the web: shown, never editable', async () => {
    const s = server()
    const status = vi.fn(async () => STATUS)
    configureEnvironment(deps(s, { isDesktop: () => false, status }))
    await checkLocalAgents()
    await refreshEnvironment()
    expect(getEnvironmentSnapshot()).toMatchObject({ canEdit: false, thisDeviceId: null })
    expect(status).not.toHaveBeenCalled()
    await removeEnvironmentFolder('f-1')
    expect(toastError).toHaveBeenCalledWith("Remove dial8-website in Native Intelligence on Liam's MacBook Pro")
  })
})

describe('adding', () => {
  it('the Mac’s picker, then the heartbeat, then a read', async () => {
    const s = server([])
    const d = deps(s)
    configureEnvironment(d)
    await checkLocalAgents()
    await refreshEnvironment()
    s.state.folders = [FOLDER]
    await addEnvironmentFolder()
    expect(d.refreshMirror).toHaveBeenCalledTimes(1)
    // A rejoin: a Mac removed from Native Intelligence comes back when a folder is added on it.
    expect(d.refreshMirror).toHaveBeenCalledWith({ rejoin: true })
    expect(getEnvironmentSnapshot().folders.map((f) => f.id)).toEqual(['f-1'])
    expect(getEnvironmentSnapshot().picking).toBe(false)
  })

  it('a cancelled picker reads nothing; a grant the heartbeat did not register says so', async () => {
    const s = server([])
    configureEnvironment(deps(s, { pickFolder: async () => ({ ok: true as const, value: null }) }))
    await addEnvironmentFolder()
    expect(s.fetch).not.toHaveBeenCalled()
    expect(toastError).not.toHaveBeenCalled()
    configureEnvironment(deps(s, { refreshMirror: async () => ({ folders: [] }) }))
    await addEnvironmentFolder()
    expect(toastError).toHaveBeenCalledWith("Couldn't add the folder", { description: 'Native Intelligence did not register it. Try again.' })
    configureEnvironment(deps(s, { refreshMirror: async () => null }))
    await addEnvironmentFolder()
    expect(toastError).toHaveBeenCalledWith("Couldn't add the folder", { description: "Native Intelligence couldn't be reached. Try again." })
  })
})

describe('removing', () => {
  async function ready(over: Partial<EnvironmentDeps> = {}, folders = [FOLDER, OTHER_MAC_FOLDER]) {
    const s = server(folders)
    const d = deps(s, over)
    configureEnvironment(d)
    await checkLocalAgents()
    await refreshEnvironment()
    return { s, d }
  }

  it('on this Mac: removeGrant, the heartbeat (the mirror revokes), a read', async () => {
    const { s, d } = await ready()
    const removing = removeEnvironmentFolder('f-1')
    expect(getEnvironmentSnapshot().folders.map((f) => f.id)).toEqual(['f-2'])
    s.state.folders = [OTHER_MAC_FOLDER]
    await removing
    expect(d.removeGrant).toHaveBeenCalledWith('g-1')
    expect(d.refreshMirror).toHaveBeenCalledTimes(1)
    expect(getEnvironmentSnapshot()).toMatchObject({ removing: [] })
    expect(getEnvironmentSnapshot().folders.map((f) => f.id)).toEqual(['f-2'])
  })

  it('Rust refuses while a local agent works there: the toast, and the folder stays', async () => {
    const { d } = await ready({ removeGrant: vi.fn(async () => ({ ok: false as const, unavailable: false, error: 'a local agent is running in this folder; stop it first' })) })
    await removeEnvironmentFolder('f-1')
    expect(toastError).toHaveBeenCalledWith("Couldn't remove dial8-website", { description: 'A local agent is running in this folder; stop it first.' })
    expect(d.refreshMirror).not.toHaveBeenCalled()
    expect(getEnvironmentSnapshot().folders.map((f) => f.id)).toEqual(['f-1', 'f-2'])
  })

  it('a local agent idle in the folder (its turn ended) is stopped without asking, then the folder goes', async () => {
    let live = true
    const removeGrant = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, unavailable: false, error: 'a local agent is running in this folder; stop it first' })
      .mockResolvedValue({ ok: true as const, value: undefined })
    const stop = vi.fn(async () => {
      live = false
      return { ok: true as const, value: undefined }
    })
    const status = vi.fn(async () => ({ ...STATUS, jobs: [job({ status: 'waiting', live }), job({ id: 'other', grantId: 'g-9' })] }))
    const { s } = await ready({ removeGrant, stop, status })
    s.state.folders = [OTHER_MAC_FOLDER]
    await removeEnvironmentFolder('f-1')
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledWith('job-1')
    expect(removeGrant).toHaveBeenCalledTimes(2)
    expect(toastError).not.toHaveBeenCalled()
    expect(getEnvironmentSnapshot().folders.map((f) => f.id)).toEqual(['f-2'])
  })

  it('a local agent still working: asked first (Stop and remove), stopped only on the action', async () => {
    let live = true
    const removeGrant = vi
      .fn()
      .mockResolvedValueOnce({ ok: false as const, unavailable: false, error: 'a local agent is running in this folder; stop it first' })
      .mockResolvedValueOnce({ ok: false as const, unavailable: false, error: 'a local agent is running in this folder; stop it first' })
      .mockResolvedValue({ ok: true as const, value: undefined })
    const stop = vi.fn(async () => {
      live = false
      return { ok: true as const, value: undefined }
    })
    const status = vi.fn(async () => ({ ...STATUS, jobs: [job({ status: 'running', live })] }))
    await ready({ removeGrant, stop, status })
    await removeEnvironmentFolder('f-1')
    expect(stop).not.toHaveBeenCalled()
    expect(removeGrant).toHaveBeenCalledTimes(1)
    const [title, opts] = toastError.mock.calls[0] as [string, { description: string; action: { label: string; onClick: () => void } }]
    expect(title).toBe('A local agent is working in dial8-website')
    expect(opts.action.label).toBe('Stop and remove')
    expect(getEnvironmentSnapshot().folders.map((f) => f.id)).toEqual(['f-1', 'f-2'])
    // The person chose Stop and remove.
    await removeEnvironmentFolder('f-1', { stopWorking: true })
    expect(stop).toHaveBeenCalledWith('job-1')
    expect(removeGrant).toHaveBeenCalledTimes(3)
    expect(getEnvironmentSnapshot().folders.map((f) => f.id)).toEqual(['f-2'])
  })

  it('a grant Rust no longer knows counts as removed; hidden while the server still lists it', async () => {
    await ready({ removeGrant: vi.fn(async () => ({ ok: false as const, unavailable: false, error: 'unknown folder' })), refreshMirror: vi.fn(async () => null) })
    await removeEnvironmentFolder('f-1')
    expect(toastError).not.toHaveBeenCalled()
    // The heartbeat didn't land: the server still lists it, and it stays hidden.
    expect(getEnvironmentSnapshot().folders.map((f) => f.id)).toEqual(['f-2'])
  })

  it('a folder on another Mac is removed there', async () => {
    const { d } = await ready()
    await removeEnvironmentFolder('f-2')
    expect(d.removeGrant).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith('Remove notes in Native Intelligence on Studio')
  })
})
