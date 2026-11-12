// @vitest-environment jsdom
/**
 * Availability left Settings for its own page under Calendar (Liam, 11-11:
 * "Availability (Right now it's in the settings but it needs to be it's own
 * page under Calendar)"). The overlay no longer has it, and every settings
 * way to it opens the Availability page's card instead: openSettings, a link
 * inside the overlay, the desktop's soft navigation. Heavy pieces stubbed as
 * in settings-overlay-voice.test.tsx.
 */
import { it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const push = vi.fn()
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
  usePathname: () => '/account',
}))

let softNavigate: ((e: { path: string }) => void) | undefined
vi.mock('@/lib/navigation-events', () => ({
  onOAuthCallback: () => () => {},
  onSoftNavigate: (fn: (e: { path: string }) => void) => {
    softNavigate = fn
    return () => {}
  },
}))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock('@radix-ui/react-dialog', () => {
  const React = require('react')
  return {
    Root: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? React.createElement(React.Fragment, null, children) : null),
    Portal: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    Content: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
    Title: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  }
})

let shellOnNavigate: ((href: string) => void) | undefined
vi.mock('../../settings/settings-shell', () => {
  const React = require('react')
  return {
    SettingsShell: ({ children, onNavigate }: { children: React.ReactNode; onNavigate?: (href: string) => void }) => {
      shellOnNavigate = onNavigate
      return React.createElement('div', null, children)
    },
  }
})

vi.mock('../../settings/preferences-view', () => {
  const React = require('react')
  return { PreferencesView: () => React.createElement('div', null, 'PREFERENCES_VIEW') }
})
vi.mock('../../settings/voice/voice-settings-view', () => {
  const React = require('react')
  return { VoiceSettingsView: () => React.createElement('div', null, 'VOICE_VIEW') }
})

import { SettingsOverlayProvider, movedSettingsPage, resolveView, useSettingsOverlay } from '../settings-overlay'
import { OPEN_CARD_EVENT, type OpenCardRequest } from '@/lib/chat-cards/open-card'

let overlayApi: ReturnType<typeof useSettingsOverlay> | null = null
function ApiProbe() {
  overlayApi = useSettingsOverlay()
  return null
}

let container: HTMLDivElement
let root: Root
let opened: OpenCardRequest[] = []
const onOpen = (e: Event) => opened.push((e as CustomEvent<OpenCardRequest>).detail)

beforeEach(() => {
  push.mockClear()
  opened = []
  window.addEventListener(OPEN_CARD_EVENT, onOpen)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  window.removeEventListener(OPEN_CARD_EVENT, onOpen)
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

const AVAILABILITY_CARD = { kind: 'availability', title: 'Availability' }

it('has no Availability view any more; the sub-path names the Availability page', () => {
  expect(resolveView('availability')).toBeNull()
  expect(movedSettingsPage('availability')).toBe('availability')
  expect(movedSettingsPage('availability/')).toBe('availability')
  expect(movedSettingsPage('availability?from=tray')).toBe('availability')
  expect(movedSettingsPage('voice')).toBeNull()
  expect(movedSettingsPage('')).toBeNull()
})

it("openSettings('availability') opens the Availability page's card, not the overlay", async () => {
  await renderProvider()
  await act(async () => {
    overlayApi!.openSettings('availability')
    await Promise.resolve()
  })
  expect(overlayApi!.isOpen).toBe(false)
  expect(opened).toEqual([{ spec: AVAILABILITY_CARD, from: 'settings' }])
})

it('a link to it from inside the overlay closes the overlay and opens the page', async () => {
  await renderProvider()
  await act(async () => {
    overlayApi!.openSettings('voice')
    await Promise.resolve()
  })
  expect(overlayApi!.isOpen).toBe(true)
  await act(async () => {
    shellOnNavigate!('/account/settings/availability')
    await Promise.resolve()
  })
  expect(overlayApi!.isOpen).toBe(false)
  expect(push).not.toHaveBeenCalled()
  expect(opened).toEqual([{ spec: AVAILABILITY_CARD, from: 'settings' }])
})

it("the desktop's soft navigation to the old settings path opens the page", async () => {
  await renderProvider()
  await act(async () => {
    softNavigate!({ path: '/account/settings/availability' })
    await Promise.resolve()
  })
  expect(overlayApi!.isOpen).toBe(false)
  expect(opened).toEqual([{ spec: AVAILABILITY_CARD, from: 'desktop' }])
})
