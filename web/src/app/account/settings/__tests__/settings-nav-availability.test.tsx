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

import { withMeetingsItem } from '../settings-shell'

it("shows Meetings in Features, after Autonomy, only when the meeting assistant is on (roadmap #12)", () => {
  const sections = [
    { title: 'Account', items: [{ href: '/account/settings/profile', label: 'Profile', icon: null as never }] },
    { title: 'Features', items: [{ href: '/account/settings/autonomy', label: 'Autonomy', icon: null as never }, { href: '/account/settings/memory', label: 'Memory', icon: null as never }] },
  ]
  expect(withMeetingsItem(sections, false, null as never)).toBe(sections)
  const on = withMeetingsItem(sections, true, null as never)
  expect(on[1].items.map((i) => i.label)).toEqual(['Autonomy', 'Meetings', 'Memory'])
  expect(on[1].items[1].href).toBe('/account/settings/meetings')
  expect(sections[1].items).toHaveLength(2)
})

it("the shell never shows Meetings when the server doesn't say it's on", () => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(h(SettingsShell, { isOverlay: true, activeSubPath: 'profile', onNavigate: () => {}, onClose: () => {}, children: h('div') })))
  expect(container.querySelector('a[href="/account/settings/meetings"]')).toBeNull()
  expect(container.textContent ?? '').not.toContain('Meetings')
})
