// @vitest-environment jsdom
/**
 * A workspace switch runs behind the wipe curtain unless the caller already
 * has the app out of sight: the workspaces veil passes `{ curtain: false }`
 * and the switch happens at once, with no curtain of its own on top.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const curtain = vi.hoisted(() => ({ begin: null as unknown as ReturnType<typeof vi.fn> }))

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
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
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('useSwitchWorkspace', () => {
  it('switches behind the curtain by default', async () => {
    expect(currentId).toBe('ws-a')
    let started = false
    await act(async () => {
      started = switchTo!('ws-b')
    })

    expect(started).toBe(true)
    expect(curtain.begin).toHaveBeenCalledWith({ id: 'ws-b', name: 'ws-b', logoUrl: null }, expect.any(Function))
    // Nothing has switched until the curtain commits.
    expect(currentId).toBe('ws-a')
    expect(switchPosts()).toHaveLength(0)

    await act(async () => {
      curtain.begin.mock.calls[0][1]()
    })
    expect(currentId).toBe('ws-b')
    expect(switchPosts()).toHaveLength(1)
  })

  it('switches at once, with no curtain, for a caller that hides the switch itself', async () => {
    let started = false
    await act(async () => {
      started = switchTo!('ws-b', { curtain: false })
    })

    expect(started).toBe(true)
    expect(curtain.begin).not.toHaveBeenCalled()
    expect(currentId).toBe('ws-b')
    expect(switchPosts()).toHaveLength(1)
  })
})
