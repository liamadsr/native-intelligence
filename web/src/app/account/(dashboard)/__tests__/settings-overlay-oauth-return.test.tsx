// @vitest-environment jsdom
/**
 * The desktop OAuth deep-link return and who it belongs to.
 *
 * A return normally opens Settings › Connectors in the overlay (the connect
 * was started there). A connect started from the chat's Connections panel
 * claims its return (oauth-return-claim.ts): the panel refreshes itself, so
 * the overlay must stay shut. The toast shows either way.
 *
 * Heavy pieces (SettingsShell, Radix Dialog, the lazy views) are stubbed as in
 * settings-overlay-voice.test.tsx; navigation-events is the REAL module so the
 * deep-link event travels the same path it does in the app.
 */
import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/account',
}))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

vi.mock('@radix-ui/react-dialog', () => {
  const React = require('react')
  return {
    Root: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
      open ? React.createElement(React.Fragment, null, children) : null,
    Portal: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    Content: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
    Title: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  }
})

vi.mock('../../settings/settings-shell', () => {
  const React = require('react')
  return {
    SettingsShell: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  }
})

function stubView(label: string) {
  const React = require('react')
  const StubView = () => React.createElement('div', null, label)
  StubView.displayName = `StubView(${label})`
  return StubView
}
vi.mock('../../settings/preferences-view', () => ({ PreferencesView: stubView('PREFERENCES_VIEW') }))
vi.mock('../../settings/connectors/connectors-view', () => ({ ConnectorsView: stubView('CONNECTORS_VIEW') }))

import { SettingsOverlayProvider, useSettingsOverlay } from '../settings-overlay'
import { emitOAuthCallback } from '@/lib/navigation-events'
import { claimOAuthReturn, resetOAuthReturnClaims } from '@/lib/integrations/oauth-return-claim'

let overlayApi: ReturnType<typeof useSettingsOverlay> | null = null
function ApiProbe() {
  overlayApi = useSettingsOverlay()
  return null
}

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  resetOAuthReturnClaims()
  overlayApi = null
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(h(SettingsOverlayProvider, null, h(ApiProbe)))
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

async function deepLink(detail: Parameters<typeof emitOAuthCallback>[0]) {
  await act(async () => {
    emitOAuthCallback(detail)
    await Promise.resolve()
    await Promise.resolve()
  })
}

it('an unclaimed return opens Settings › Connectors, as before', async () => {
  await deepLink({ success: true, provider: 'google', capability: 'calendar' })
  expect(toast.success).toHaveBeenCalledWith('Connected google calendar')
  expect(overlayApi!.isOpen).toBe(true)
  expect(overlayApi!.subPath).toBe('connectors')
  expect(container.textContent).toContain('CONNECTORS_VIEW')
})

it('a return the panel claimed shows the toast but keeps Settings shut', async () => {
  claimOAuthReturn('google', 'calendar')
  await deepLink({ success: true, provider: 'google', capability: 'calendar' })
  expect(toast.success).toHaveBeenCalledWith('Connected google calendar')
  expect(overlayApi!.isOpen).toBe(false)
  expect(container.textContent).not.toContain('CONNECTORS_VIEW')

  // The claim is used up: the next return for the pair opens Settings again.
  await deepLink({ success: true, provider: 'google', capability: 'calendar' })
  expect(overlayApi!.isOpen).toBe(true)
})

it("an error return (no capability) is still the panel's when it claimed the provider", async () => {
  claimOAuthReturn('jira', 'tasks')
  await deepLink({ success: false, provider: 'jira', capability: '', error: 'access_denied' })
  expect(toast.error).toHaveBeenCalledWith('Integration error: access_denied')
  expect(overlayApi!.isOpen).toBe(false)
})

it('a claim for another provider does not swallow this return', async () => {
  claimOAuthReturn('asana', 'tasks')
  await deepLink({ success: true, provider: 'linear', capability: 'tasks' })
  expect(overlayApi!.isOpen).toBe(true)
})

it('an expired claim (over 10 minutes old) no longer holds the overlay shut', async () => {
  claimOAuthReturn('hubspot', 'crm', Date.now() - 11 * 60 * 1000)
  await deepLink({ success: true, provider: 'hubspot', capability: 'crm' })
  expect(overlayApi!.isOpen).toBe(true)
})
