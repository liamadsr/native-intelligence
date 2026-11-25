// @vitest-environment jsdom
/**
 * A Studio take belongs to the workspace it started in: while one records or is being saved, the switch is refused
 * with "Stop and switch", which stops it, waits for it to be saved, then switches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const curtain = vi.hoisted(() => ({ begin: null as unknown as ReturnType<typeof vi.fn> }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
const sonner = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock('sonner', () => ({ toast: sonner }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => false }))
vi.mock('@/lib/workspace-fetch', () => ({
  setClientWorkspaceId: vi.fn(),
  getClientWorkspaceId: vi.fn(() => 'ws-a'),
  patchFetch: vi.fn(),
}))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => null }))
// The curtain HOLDS the commit, the way the real one does until it covers the
// panel — so a test can tell a curtained switch from an immediate one.
vi.mock('../workspace-transition', () => ({
  useWorkspaceTransition: () => ({ beginTransition: curtain.begin }),
}))
vi.mock('../(dashboard)/settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))
vi.mock('../create-workspace-wizard', () => ({ CreateWorkspaceWizard: () => null }))

import { registerRecordingGuard } from '@/lib/studio/recording-bus'
import { WorkspaceCacheProvider, useSwitchWorkspace, useWorkspaces } from '../workspace-switcher'

function jsonRes(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

let container: HTMLDivElement
let root: Root
let fetchMock: ReturnType<typeof vi.fn>
let switchTo: ReturnType<typeof useSwitchWorkspace> | null = null
let currentId: string | null = null

function Probe() {
  switchTo = useSwitchWorkspace()
  currentId = useWorkspaces().currentId
  return null
}

const switchPosts = () => fetchMock.mock.calls.filter(([url]) => url === '/api/account/workspace/switch')

beforeEach(async () => {
  curtain.begin = vi.fn()
  // The server's active workspace: the switch POST moves it, and the refresh
  // that follows a switch reads it back.
  let active = 'ws-a'
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/account/workspace/list') {
      return jsonRes({
        workspaces: ['ws-a', 'ws-b'].map((id) => ({ id, name: id, slug: id, logo_url: null, plan: 'pro', role: 'owner' })),
      })
    }
    if (url === '/api/account/workspace/switch') active = JSON.parse(String(init?.body)).workspace_id
    if (url === '/api/account/workspace') return jsonRes({ workspace: { id: active, settings: {} }, currentMemberId: 'm-1', members: [] })
    return jsonRes({})
  })
  vi.stubGlobal('fetch', fetchMock)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      <WorkspaceCacheProvider>
        <Probe />
      </WorkspaceCacheProvider>,
    )
  })
})

afterEach(() => {
  registerRecordingGuard(null)
  sonner.error.mockReset()
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('switching workspaces while a Studio take records', () => {
  it('is refused, and Stop and switch stops the take, waits for it to be saved, then switches', async () => {
    let busy = true
    const stopAndSettle = vi.fn(async () => { busy = false })
    registerRecordingGuard({ busy: () => busy, stopAndSettle, reset: vi.fn() })
    let started = true
    await act(async () => { started = switchTo!('ws-b', { curtain: false }) })
    expect(started).toBe(false)
    expect(currentId).toBe('ws-a')
    expect(switchPosts()).toHaveLength(0)
    const [text, opts] = sonner.error.mock.calls[0]!
    expect(text).toBe('A recording is running in the Studio. Stop it to switch workspaces.')
    expect(opts.action.label).toBe('Stop and switch')
    await act(async () => { opts.action.onClick(); await new Promise((r) => setTimeout(r, 0)) })
    expect(stopAndSettle).toHaveBeenCalledWith(60_000)
    expect(currentId).toBe('ws-b')
    expect(switchPosts()).toHaveLength(1)
  })

  it('does not switch when the take is still being saved after the wait', async () => {
    registerRecordingGuard({ busy: () => true, stopAndSettle: vi.fn(async () => {}), reset: vi.fn() })
    await act(async () => { switchTo!('ws-b', { curtain: false }) })
    await act(async () => { sonner.error.mock.calls[0]![1].action.onClick(); await new Promise((r) => setTimeout(r, 0)) })
    expect(currentId).toBe('ws-a')
    expect(sonner.error.mock.calls.at(-1)![0]).toBe('The recording is still being saved. Switch again in a moment.')
  })

  it('switches as before with no take', async () => {
    registerRecordingGuard({ busy: () => false, stopAndSettle: vi.fn(), reset: vi.fn() })
    await act(async () => { switchTo!('ws-b', { curtain: false }) })
    expect(currentId).toBe('ws-b')
  })
})
