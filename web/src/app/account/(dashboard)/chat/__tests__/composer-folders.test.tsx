// @vitest-environment jsdom
/**
 * The main composer's + → Select folder… for local agents
 * (docs/plans/local-agents.md): useComposerFolders (composer-state.ts) over
 * the person's environment (the shared store,
 * src/lib/local-agent/environment-client.ts). The composer shows no chips
 * (Liam, 2026-10-21): + → Select folder… adds, and the side panel's
 * Environment card shows and removes (environment-client.test.ts covers the
 * remove).
 *
 * Pinned:
 *   - Select folder… is offered only in the desktop app with local agents
 *     available there; the + menu opening asks the desktop again;
 *   - it adds to the environment: the Mac's picker, the relay's heartbeat, a
 *     read (with no conversation: nothing is attached per chat);
 *   - on the web there is no Select folder…, and the desktop is never asked;
 *   - a host that disables it reads nothing and offers nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, useEffect } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const toastError = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: toastError, message: vi.fn() }) }))
vi.mock('@/lib/local-agent/relay-core', () => ({ refreshLocalAgentDevice: vi.fn(async () => null) }))

import { useComposerFolders, type ComposerFolders } from '../composer-state'
import {
  ENVIRONMENT_URL,
  configureEnvironment,
  resetEnvironmentStore,
  type EnvironmentDeps,
} from '@/lib/local-agent/environment-client'
import type { LocalAgentStatus } from '@/lib/tauri-bridge'

const THIS_MAC = 'dev-this'
const ROW = { id: 'f-1', deviceId: THIS_MAC, grantId: 'g-1', label: 'native-intelligence', path: '/Users/liam/code/native-intelligence', mode: 'edit', isGit: true, deviceName: "Liam's MacBook Pro", online: true }
const STUDIO = { ...ROW, id: 'f-2', deviceId: 'dev-studio', grantId: 'g-9', label: 'notes', path: '/Users/liam/notes', mode: 'read', deviceName: 'Studio' }
const STATUS = { available: true, reason: null, node: null, agentDir: null, built: true, grants: [], jobs: [] } as LocalAgentStatus

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function server(folders: Array<Record<string, unknown>>) {
  const state = { folders: [...folders] }
  const calls: string[] = []
  const fetch = vi.fn(async (url: string) => {
    calls.push(url)
    if (url !== ENVIRONMENT_URL) return json({ error: 'nope' }, 404)
    return json({ devices: [], folders: state.folders, worktrees: [] })
  })
  return { state, calls, fetch }
}

function deps(s: ReturnType<typeof server>, over: Partial<EnvironmentDeps> = {}): Partial<EnvironmentDeps> {
  return {
    fetch: s.fetch as never,
    isDesktop: () => true,
    status: async () => STATUS,
    device: async () => ({ ok: true as const, value: { deviceId: THIS_MAC, name: "Liam's MacBook Pro", platform: 'macos', appVersion: '0.3.0' } }),
    pickFolder: async () => ({ ok: true as const, value: { id: 'g-1', path: ROW.path, label: 'native-intelligence', mode: 'edit' as const, addedAt: 't', isGit: true } }),
    removeGrant: vi.fn(async () => ({ ok: true as const, value: undefined })),
    refreshMirror: vi.fn(async () => ({ folders: [{ id: 'f-1', grantId: 'g-1', label: 'native-intelligence', mode: 'edit' as const, isGit: true }] })),
    ...over,
  }
}

// ── The hook ────────────────────────────────────────────────────────────────

let current: ComposerFolders | null = null
function Host({ enabled }: { enabled: boolean }) {
  const folders = useComposerFolders({ enabled })
  useEffect(() => {
    current = folders
  })
  return null
}

let container: HTMLDivElement
let root: Root
const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => { await Promise.resolve() })
}

async function mount(enabled = true) {
  await act(async () => {
    root.render(h(Host, { enabled }))
  })
  await flush()
}

beforeEach(() => {
  current = null
  toastError.mockClear()
  resetEnvironmentStore()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  configureEnvironment(null)
})

describe('useComposerFolders', () => {
  it('reads the environment with no conversation; Select folder… in the desktop app with local agents available', async () => {
    const s = server([ROW, STUDIO])
    configureEnvironment(deps(s))
    await mount()
    expect(s.calls).toEqual([ENVIRONMENT_URL])
    expect(current?.canPick).toBe(true)
    expect(current?.picking).toBe(false)
  })

  it('local agents off on this Mac: no Select folder…; the + menu asks again', async () => {
    const s = server([ROW])
    const status = vi.fn(async (): Promise<LocalAgentStatus> => ({ ...STATUS, available: false, reason: 'off' }))
    configureEnvironment(deps(s, { status }))
    await mount()
    expect(current?.canPick).toBe(false)
    status.mockResolvedValueOnce(STATUS)
    await act(async () => current?.recheck())
    await flush()
    expect(status).toHaveBeenCalledTimes(2)
    expect(current?.canPick).toBe(true)
  })

  it('on the web: no Select folder…, and the desktop is never asked', async () => {
    const s = server([ROW])
    const status = vi.fn(async () => STATUS)
    configureEnvironment(deps(s, { isDesktop: () => false, status }))
    await mount()
    expect(current?.canPick).toBe(false)
    expect(status).not.toHaveBeenCalled()
  })

  it('a host that disables it reads nothing and offers nothing', async () => {
    const s = server([ROW])
    configureEnvironment(deps(s))
    await mount(false)
    expect(current?.canPick).toBe(false)
    expect(s.fetch).not.toHaveBeenCalled()
  })

  it('Select folder… adds to the environment: the picker, the heartbeat, a read', async () => {
    const s = server([])
    const d = deps(s)
    configureEnvironment(d)
    await mount()
    s.state.folders = [ROW]
    await act(async () => current?.pickFolder())
    await flush()
    expect(d.refreshMirror).toHaveBeenCalledTimes(1)
    expect(s.calls).toEqual([ENVIRONMENT_URL, ENVIRONMENT_URL])
    expect(current?.picking).toBe(false)
  })
})
