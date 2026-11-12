// @vitest-environment jsdom
/**
 * Settings' nav (../settings-shell.tsx) no longer lists Availability: it is
 * its own page under Calendar now (Liam, 11-11: "Availability (Right now
 * it's in the settings but it needs to be it's own page under Calendar)").
 */
import { afterEach, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/account/settings/profile' }))
vi.mock('@/components/desktop-titlebar', () => ({ useIsDesktop: () => false }))

import { SettingsShell } from '../settings-shell'

let root: Root | null = null
let container: HTMLDivElement | null = null

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it('lists the other settings, and not Availability', () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(h(SettingsShell, { isOverlay: true, activeSubPath: 'profile', onNavigate: () => {}, onClose: () => {}, children: h('div') })))
  const text = container.textContent ?? ''
  expect(text).toContain('Profile')
  expect(text).toContain('Preferences')
  expect(text).not.toContain('Availability')
  expect(container.querySelector('a[href="/account/settings/availability"]')).toBeNull()
})
