// @vitest-environment jsdom
/**
 * "Show all workspaces" in the workspace menu: the app's one workspace-span
 * switch (lib/workspace-span), which Actions, Projects, the bots, agent alerts
 * and the inbox all follow.
 *
 *  • It is a `menuitemcheckbox` whose checked state is the switch's, so its
 *    state is announced, not just drawn.
 *  • A click flips the app-wide answer, saves it to the ACCOUNT (so it follows
 *    the user to other devices), and the menu stays open so the switch can be
 *    seen to move.
 *  • The account's answer arrives with the profile the workspace cache already
 *    fetches at boot — no request of its own.
 *  • It is offered only to someone in more than one workspace: with one,
 *    "all" and "this one" are the same list.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, forwardRef, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => false }))
vi.mock('@/lib/workspace-fetch', () => ({
  setClientWorkspaceId: vi.fn(),
  getClientWorkspaceId: vi.fn(() => 'ws-1'),
  patchFetch: vi.fn(),
}))
vi.mock('@/hooks/recording-context', () => ({ useOptionalRecordingStable: () => null }))
vi.mock('../workspace-transition', () => ({
  useWorkspaceTransition: () => ({ beginTransition: (_target: unknown, commit: () => void) => commit() }),
}))
vi.mock('../(dashboard)/settings-overlay', () => ({ useOptionalSettingsOverlay: () => null }))
vi.mock('../create-workspace-wizard', () => ({ CreateWorkspaceWizard: () => null }))
vi.mock('liquid-gooey', () => {
  const Liquid = Object.assign(
    forwardRef<HTMLDivElement, Record<string, unknown>>(function Liquid(props, ref) {
      const { blur: _b, contrast: _c, fill: _f, shadow: _s, filterPadding: _p, children, ...rest } = props
      return h('div', { ...rest, ref }, children as ReactNode)
    }),
    {
      Item: ({ className, children }: { className?: string; children?: ReactNode }) =>
        h('div', { className, 'data-item': '' }, children),
    },
  )
  return { Liquid }
})

import { WorkspaceCacheProvider, WorkspaceSwitcher } from '../workspace-switcher'
import {
  WORKSPACE_SPAN_STORAGE_KEY,
  getShowAllWorkspaces,
  resetWorkspaceSpanForTests,
} from '@/lib/workspace-span'

function jsonRes(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

const TWO = [
  { id: 'ws-1', name: 'Native Intelligence', slug: 'dial8', logo_url: null, plan: 'pro', role: 'owner' },
  { id: 'ws-2', name: 'Corvanne', slug: 'corvanne', logo_url: null, plan: 'pro', role: 'member' },
]

let container: HTMLDivElement
let root: Root
let requests: { url: string; init?: RequestInit }[] = []

async function mountWith(workspaces: typeof TWO, profile: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, init })
      if (url === '/api/account/workspace/list') return jsonRes({ workspaces })
      if (url === '/api/account/workspace') return jsonRes({ workspace: { id: 'ws-1' }, currentMemberId: 'm-1', members: [] })
      if (url === '/api/account/profile' && !init?.method) return jsonRes(profile)
      return jsonRes({})
    }),
  )
  await act(async () => {
    root.render(h(WorkspaceCacheProvider, null, h(WorkspaceSwitcher, { variant: 'pill' })))
  })
  // Open the menu (a click opens it; the pill also opens on hover).
  act(() => container.querySelector<HTMLButtonElement>('[aria-label="Workspace and account menu"]')!.click())
}

const profileSaves = () =>
  requests
    .filter((r) => r.url === '/api/account/profile' && r.init?.method === 'PATCH')
    .map((r) => JSON.parse(String(r.init!.body)))
const toggle = () => container.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"]')
const menuOpen = () =>
  container.querySelector('[aria-label="Workspace and account menu"]')!.getAttribute('aria-expanded') === 'true'

beforeEach(() => {
  window.localStorage.clear()
  resetWorkspaceSpanForTests()
  requests = []
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

describe('Show all workspaces', () => {
  it('is in the menu, labelled, and off by default', async () => {
    await mountWith(TWO)
    expect(toggle()).not.toBeNull()
    expect(toggle()!.textContent).toContain('Show all workspaces')
    expect(toggle()!.getAttribute('aria-checked')).toBe('false')
  })

  it("shows the account's answer, read from the profile the cache fetches at boot", async () => {
    await mountWith(TWO, { id: 'u1', show_all_workspaces: true })
    expect(toggle()!.getAttribute('aria-checked')).toBe('true')
    // One profile GET — the workspace cache's own; the switch adds none.
    expect(requests.filter((r) => r.url === '/api/account/profile' && !r.init?.method)).toHaveLength(1)
  })

  it('lets the account overrule this device\'s cached answer', async () => {
    window.localStorage.setItem(WORKSPACE_SPAN_STORAGE_KEY, JSON.stringify({ all: true, user: 'u1' }))
    await mountWith(TWO, { id: 'u1', show_all_workspaces: false })
    expect(toggle()!.getAttribute('aria-checked')).toBe('false')
  })

  it('flips the app-wide switch and saves it to the account, leaving the menu open', async () => {
    await mountWith(TWO, { id: 'u1', show_all_workspaces: false })
    await act(async () => toggle()!.click())
    expect(getShowAllWorkspaces()).toBe(true)
    expect(JSON.parse(window.localStorage.getItem(WORKSPACE_SPAN_STORAGE_KEY)!)).toEqual({ all: true, user: 'u1' })
    expect(profileSaves()).toEqual([{ show_all_workspaces: true }])
    expect(toggle()!.getAttribute('aria-checked')).toBe('true')
    expect(menuOpen()).toBe(true)

    await act(async () => toggle()!.click())
    expect(getShowAllWorkspaces()).toBe(false)
    expect(profileSaves()).toEqual([{ show_all_workspaces: true }, { show_all_workspaces: false }])
    expect(toggle()!.getAttribute('aria-checked')).toBe('false')
  })

  it('is not offered to someone with a single workspace', async () => {
    await mountWith(TWO.slice(0, 1))
    expect(container.textContent).toContain('Native Intelligence')
    expect(toggle()).toBeNull()
  })
})
