// @vitest-environment jsdom
/**
 * The deep-link handler is mounted in the root layout, so it runs in the HUD
 * windows too (/hud/agent, the live agent's always-on-top window).
 *
 * Pinned: on a /hud/* page it does nothing at all — no auth sync, no tray
 * navigation, no deep links — whatever the window-label election would say,
 * since a navigation there would put an app page in an overlay window.
 * Everywhere else it still starts all three.
 *
 * The real @tauri-apps/api runs against stubbed shell internals, so what's
 * asserted is what the shell would be asked for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement as h } from 'react'
import { createRoot, type Root } from 'react-dom/client'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  createClient: vi.fn(() => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  })),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => true }))
vi.mock('@/lib/supabase/client', () => ({ createClient: mocks.createClient }))
vi.mock('@/lib/tauri-bridge', () => ({
  tauriBridge: { setAuthToken: vi.fn(async () => {}) },
  // A failed label lookup reads as null, which the election treats as elected.
  getThisWebviewLabel: vi.fn(async () => null),
}))
vi.mock('@/lib/navigation-events', () => ({ emitOAuthCallback: vi.fn(), emitSoftNavigate: vi.fn() }))

import { DeepLinkHandler } from '../deep-link-handler'

const shell = {
  invoke: vi.fn(async (_cmd: string, _args?: Record<string, unknown>) => 1),
  transformCallback: vi.fn(() => 1),
}
const listened = () =>
  shell.invoke.mock.calls.filter(([cmd]) => cmd === 'plugin:event|listen').map(([, args]) => args?.event)

describe('DeepLinkHandler on a HUD page', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    shell.invoke.mockClear()
    mocks.createClient.mockClear()
    Object.assign(window, {
      __TAURI_INTERNALS__: shell,
      __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: vi.fn() },
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    window.history.replaceState(null, '', '/')
  })

  async function mountAt(path: string) {
    // Loaded up front, so the handler's own dynamic imports of it resolve at
    // once and "nothing listened" can't just mean "not loaded yet".
    await import('@tauri-apps/api/event')
    window.history.replaceState(null, '', path)
    await act(async () => root.render(h(DeepLinkHandler)))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
  }

  it('does nothing in a HUD window', async () => {
    await mountAt('/hud/agent')
    expect(listened()).toEqual([])
    expect(mocks.createClient).not.toHaveBeenCalled()
  })

  it('still listens everywhere else', async () => {
    await mountAt('/account/chat')
    await vi.waitFor(() => expect(listened().sort()).toEqual(['deep-link-auth', 'navigate']))
    expect(mocks.createClient).toHaveBeenCalled()
  })
})
