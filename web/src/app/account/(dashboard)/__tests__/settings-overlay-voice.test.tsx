// @vitest-environment jsdom
/**
 * Regression tests for reaching the Voice pane from the dashboard settings
 * OVERLAY (Finding 2). Two contracts:
 *
 *   1. Opening the overlay to sub-path 'voice' resolves the Voice view — NOT the
 *      silent Preferences fallback (the 'voice' key was missing from the overlay
 *      registry, so it fell through to '').
 *   2. Navigating to a NON-settings path from overlay context (the Voice view's
 *      "Teach Dial8 your voice" CTA → /account/voice-enrollment) closes the
 *      overlay and router.push()es the full-page route, instead of silently
 *      no-op-ing because handleNavigate only matched ^/account/settings/ paths.
 *
 * The heavy pieces (SettingsShell chrome, Radix Dialog, each lazy settings view)
 * are stubbed so we exercise ONLY the provider's registry + navigation wiring.
 * Rendered standalone with createRoot/act (no @testing-library in this repo).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// --- next/navigation: capture router.push + a controllable pathname ---
const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/account',
}))

// --- navigation-events: inert (the provider subscribes on mount) ---
vi.mock('@/lib/navigation-events', () => ({
  onOAuthCallback: () => () => {},
  onSoftNavigate: () => () => {},
}))

// --- sonner: inert ---
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// --- Radix Dialog: render children only when `open`, expose no portal ---
vi.mock('@radix-ui/react-dialog', () => {
  const React = require('react')
  return {
    Root: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    Portal: ({ children }: { children: React.ReactNode }) =>
      React.createElement(React.Fragment, null, children),
    Content: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    Title: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
  }
})

// --- SettingsShell: render children (the resolved view) and expose its
//     onNavigate/onClose props via test-only buttons so we can drive them. ---
let shellOnNavigate: ((href: string) => void) | undefined
let shellOnClose: (() => void) | undefined
vi.mock('../../settings/settings-shell', () => {
  const React = require('react')
  return {
    SettingsShell: ({
      children,
      onNavigate,
      onClose,
      activeSubPath,
    }: {
      children: React.ReactNode
      onNavigate?: (href: string) => void
      onClose?: () => void
      activeSubPath?: string
    }) => {
      shellOnNavigate = onNavigate
      shellOnClose = onClose
      return React.createElement(
        'div',
        { 'data-active-subpath': activeSubPath ?? '' },
        children,
      )
    },
  }
})

// --- Stub every lazy settings view module the registry imports, so resolution
//     is observable by rendered text and no real (heavy) view loads. ---
function stubView(label: string) {
  const React = require('react')
  const StubView = () => React.createElement('div', null, label)
  StubView.displayName = `StubView(${label})`
  return StubView
}
vi.mock('../../settings/preferences-view', () => ({ PreferencesView: stubView('PREFERENCES_VIEW') }))
vi.mock('../../settings/voice/voice-settings-view', () => ({ VoiceSettingsView: stubView('VOICE_VIEW') }))

import { SettingsOverlayProvider, useSettingsOverlay } from '../settings-overlay'

// A child that surfaces the overlay controls so a test can openSettings('voice').
let overlayApi: ReturnType<typeof useSettingsOverlay> | null = null
function ApiProbe() {
  overlayApi = useSettingsOverlay()
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  push.mockClear()
  shellOnNavigate = undefined
  shellOnClose = undefined
  overlayApi = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

async function renderProvider() {
  await act(async () => {
    root.render(h(SettingsOverlayProvider, null, h(ApiProbe)))
    await Promise.resolve()
  })
}

it("resolves the Voice view (not the Preferences fallback) for sub-path 'voice'", async () => {
  await renderProvider()
  await act(async () => {
    overlayApi!.openSettings('voice')
    // Flush Suspense/lazy resolution of the stubbed module.
    await Promise.resolve()
    await Promise.resolve()
  })
  const text = container.textContent ?? ''
  expect(text).toContain('VOICE_VIEW')
  expect(text).not.toContain('PREFERENCES_VIEW')
  expect(overlayApi!.subPath).toBe('voice')
})

it('navigating to /account/voice-enrollment from the overlay closes it and router.push()es', async () => {
  await renderProvider()
  await act(async () => {
    overlayApi!.openSettings('voice')
    await Promise.resolve()
  })
  expect(overlayApi!.isOpen).toBe(true)
  expect(shellOnNavigate).toBeTypeOf('function')

  await act(async () => {
    shellOnNavigate!('/account/voice-enrollment')
    await Promise.resolve()
  })

  // Full-page route pushed — the CTA is not a silent no-op.
  expect(push).toHaveBeenCalledWith('/account/voice-enrollment')
  // Overlay closed.
  expect(overlayApi!.isOpen).toBe(false)
})

it('navigating to a settings sub-path from the overlay stays inside the overlay (no route change)', async () => {
  await renderProvider()
  await act(async () => {
    overlayApi!.openSettings('voice')
    await Promise.resolve()
  })
  await act(async () => {
    shellOnNavigate!('/account/settings/recording')
    await Promise.resolve()
  })
  // Sub-path switched in place; the overlay stays open and no route push happens.
  expect(push).not.toHaveBeenCalled()
  expect(overlayApi!.isOpen).toBe(true)
  expect(overlayApi!.subPath).toBe('recording')
})
