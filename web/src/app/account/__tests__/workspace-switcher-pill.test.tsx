// @vitest-environment jsdom
/**
 * The header's workspace pill works like the Capture pill beside it: hovering
 * it opens the workspace name AND pours the workspace / account menu out of
 * the pill's liquid — rendered in the pill, not portaled away. A click opens
 * it too, and never shuts it (it's usually already open from the hover).
 * Escape, a press outside, or moving off the pill and the menu put it away.
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
// The liquid is a silhouette painted behind the content; the stand-in keeps
// the structure and the open state.
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

function jsonRes(body: unknown) {
  return { ok: true, json: async () => body } as Response
}

let container: HTMLDivElement
let root: Root

const trigger = () => container.querySelector<HTMLButtonElement>('[aria-label="Workspace and account menu"]')!
const face = () => trigger().parentElement!
const liquid = () => face().parentElement!
const menu = () => container.querySelector<HTMLElement>('[role="menu"]')!
const isOpen = () => liquid().hasAttribute('data-open')

const hover = (el: Element) =>
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  })

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/account/workspace/list') {
        return jsonRes({
          workspaces: [
            { id: 'ws-1', name: "Liam Alizadeh's Workspace", slug: 'liam', logo_url: null, plan: 'pro', role: 'owner' },
            { id: 'ws-2', name: 'Native Intelligence', slug: 'dial8', logo_url: null, plan: 'pro', role: 'member' },
          ],
        })
      }
      if (url === '/api/account/workspace') return jsonRes({ workspace: { id: 'ws-1' }, currentMemberId: 'm-1', members: [] })
      return jsonRes({})
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(h(WorkspaceCacheProvider, null, h(WorkspaceSwitcher, { variant: 'pill' })))
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('the workspace pill', () => {
  it('is the avatar alone: no caret and no name (the name heads the menu it opens)', () => {
    expect(trigger().textContent!.trim()).toBe('L')
    expect(trigger().querySelector('svg')).toBeNull()
    hover(face())
    expect(trigger().textContent!.trim()).toBe('L')
    expect(menu().textContent).toContain("Liam Alizadeh's Workspace")
  })

  it('pours its menu out of the pill on hover', () => {
    expect(isOpen()).toBe(false)
    expect(menu().hasAttribute('inert')).toBe(true)

    hover(face())
    expect(isOpen()).toBe(true)
    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    // The menu is in the pill's liquid — not portaled to <body> — and live.
    expect(liquid().contains(menu())).toBe(true)
    expect(menu().hasAttribute('inert')).toBe(false)
    expect(menu().textContent).toContain('Native Intelligence')
  })

  it('opens on a click too, and a second click leaves it open', () => {
    act(() => trigger().click())
    expect(isOpen()).toBe(true)
    act(() => trigger().click())
    expect(isOpen()).toBe(true)
  })

  it('closes on Escape, on a press outside, and a moment after the pointer leaves', () => {
    hover(face())
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(isOpen()).toBe(false)

    hover(face())
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    })
    expect(isOpen()).toBe(false)

    hover(face())
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { pointerType: 'mouse', clientX: 400, clientY: 600 }))
    })
    act(() => {
      vi.advanceTimersByTime(240)
    })
    expect(isOpen()).toBe(false)
  })
})
