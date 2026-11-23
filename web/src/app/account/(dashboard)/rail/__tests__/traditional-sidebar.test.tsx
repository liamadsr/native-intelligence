// @vitest-environment jsdom
/**
 * Traditional's sidebar (../traditional-sidebar.tsx; docs/plans/traditional-layout.md):
 * it lists exactly the pages the app rail lists, in the same order, for every
 * edition; a page opens from it as it opens from the rail (the same card
 * asked of the main chat: same spec, same route, same data); each shell draws
 * nothing in the other layout; and a page's sub-nav is drawn into the
 * sidebar's details pane in Traditional (the page panel's own panel, one
 * component in both layouts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { getEdition, type EditionDefinition } from '@/lib/editions/manifest'
import { OPEN_CARD_EVENT, type OpenCardRequest } from '@/lib/chat-cards/open-card'
import { __resetSelectedPlaceForTests } from '../selected-place'
import { __resetPageGroupsForTests } from '../page-groups'
import { __resetRailPrefsForTests } from '@/lib/rail-prefs-store'
import { __resetLayoutModeForTests } from '@/lib/layout-mode-store'
import { LAYOUT_STORAGE_KEY } from '@/lib/layout-mode'
import { resetSidePanelStore } from '../../side-panels/side-panel-store'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { edition, guest } = vi.hoisted(() => ({
  edition: { current: null as EditionDefinition | null },
  guest: { current: false },
}))
vi.mock('@/app/account/workspace-switcher', async () => {
  const React = await import('react')
  return {
    useWorkspaceEdition: () => edition.current,
    useIsWorkspaceGuest: () => guest.current,
    WorkspaceSwitcher: ({ variant }: { variant: string }) => React.createElement('button', { 'aria-label': 'Workspace and account menu', 'data-variant': variant }),
  }
})
vi.mock('@/lib/chat/open-search', () => ({ openSearch: vi.fn(() => true) }))

import { AppRail } from '../app-rail'
import { TraditionalSidebar } from '../traditional-sidebar'
import { PagePanelFrame } from '../../page-panel/page-panel-frame'

let container: HTMLDivElement
let root: Root

const fetchMock = vi.fn(async (..._args: unknown[]) => new Response('{"success":true}', { status: 200 }))

function setLayout(mode: 'default' | 'traditional') {
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(mode))
  __resetLayoutModeForTests()
}

beforeEach(() => {
  localStorage.clear()
  __resetRailPrefsForTests()
  __resetSelectedPlaceForTests()
  __resetPageGroupsForTests()
  __resetLayoutModeForTests()
  resetSidePanelStore()
  vi.stubGlobal('fetch', fetchMock)
  edition.current = getEdition('full')
  guest.current = false
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

async function render(node: Parameters<typeof root.render>[0]) {
  await act(async () => root.render(node))
}
async function remount(node: Parameters<typeof root.render>[0]) {
  act(() => root.unmount())
  root = createRoot(container)
  await render(node)
}

/** The pages each shell lists, by id, in order. */
const railPages = () => Array.from(container.querySelectorAll<HTMLElement>('[data-app-rail-page]')).map((el) => el.dataset.appRailItem)
const NOT_PAGES = new Set(['create', 'search', 'home', 'workspace'])
const sidebarPages = () =>
  Array.from(container.querySelectorAll<HTMLElement>('button[data-sidebar-item]'))
    .map((el) => el.dataset.sidebarItem!)
    .filter((id) => !NOT_PAGES.has(id))

async function opened(click: () => void): Promise<OpenCardRequest[]> {
  const asked: OpenCardRequest[] = []
  const listen = (e: Event) => asked.push((e as CustomEvent<OpenCardRequest>).detail)
  window.addEventListener(OPEN_CARD_EVENT, listen)
  await act(async () => click())
  window.removeEventListener(OPEN_CARD_EVENT, listen)
  return asked
}

describe('Traditional sidebar', () => {
  it.each(['full', 'sales', 'notes', 'brain', 'service'] as const)('lists the same pages as the rail, in its order (%s edition)', async (id) => {
    edition.current = getEdition(id)
    setLayout('default')
    await render(h(AppRail))
    const rail = railPages()
    expect(rail.length).toBeGreaterThan(0)
    setLayout('traditional')
    await remount(h(TraditionalSidebar))
    expect(sidebarPages()).toEqual(rail)
    expect(container.querySelector('button[data-sidebar-item="home"]')).not.toBeNull()
  })

  it('draws nothing in the default layout, and the rail draws nothing in Traditional', async () => {
    setLayout('default')
    await render(h(TraditionalSidebar))
    expect(container.querySelector('[data-ni-sidebar]')).toBeNull()
    setLayout('traditional')
    await remount(h(AppRail))
    expect(container.querySelector('[data-app-rail-nav]')).toBeNull()
    expect(container.querySelector('[data-app-rail-header]')).toBeNull()
  })

  it('opens every page exactly as the rail does (same card, route and data)', async () => {
    setLayout('default')
    await render(h(AppRail))
    const ids = railPages()
    const fromRail: OpenCardRequest[] = []
    for (const id of ids) fromRail.push(...(await opened(() => container.querySelector<HTMLElement>(`[data-app-rail-nav] [data-app-rail-item="${id}"]`)!.click())))
    setLayout('traditional')
    await remount(h(TraditionalSidebar))
    const fromSidebar: OpenCardRequest[] = []
    for (const id of ids) fromSidebar.push(...(await opened(() => container.querySelector<HTMLElement>(`button[data-sidebar-item="${id}"]`)!.click())))
    expect(fromSidebar.length).toBe(ids.length)
    expect(fromSidebar.map((r) => ({ spec: r.spec, from: r.from }))).toEqual(fromRail.map((r) => ({ spec: r.spec, from: r.from })))
  })

  it("draws a page's sub-nav in its details pane in Traditional, and floating beside the rail otherwise", async () => {
    const tree = () =>
      h('div', null, h(TraditionalSidebar), h(PagePanelFrame, { mode: 'room', label: 'Mail', page: 'mail', children: h('p', { 'data-probe': '' }, 'Inbox') }))
    setLayout('traditional')
    await render(tree())
    const probe = container.querySelector('[data-probe]')!
    expect(probe.closest('[data-sidebar-details]')).not.toBeNull()
    expect(probe.closest('[data-page-panel-sidebar]')?.hasAttribute('hidden')).toBe(false)
    setLayout('default')
    await remount(tree())
    const again = container.querySelector('[data-probe]')!
    expect(again.closest('[data-sidebar-details]')).toBeNull()
    expect(again.closest('aside[data-page-panel="mail"]')).not.toBeNull()
  })

  it('hides a sub-nav that is not on screen (its frame off) in the details pane', async () => {
    setLayout('traditional')
    await render(h('div', null, h(TraditionalSidebar), h(PagePanelFrame, { mode: 'off', label: 'Mail', page: 'mail', children: h('p', { 'data-probe': '' }, 'x') })))
    // Never shown yet: not mounted at all, as before.
    expect(container.querySelector('[data-probe]')).toBeNull()
  })
})
