// @vitest-environment jsdom
/**
 * The knowledge card draws the real KnowledgeView beside the real page. The
 * surface it is on is the card's: switching it never writes the page's
 * remembered choice, and the page's choice never moves the card. Inline the
 * map is a still; full screen it runs, one card at a time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as React from 'react'
import { act } from 'react'
import { makeStore, mountRoot, stubFetch } from './page-card-harness'

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/components/views/unified-view-layout', async (orig) => (await import('./page-card-harness')).probeListModule(orig))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/app/account/(dashboard)/views/knowledge-graph-layout', () => ({
  KnowledgeGraphLayout: () => React.createElement('canvas', { 'data-map': '' }),
}))
vi.mock('@/app/account/(dashboard)/views/knowledge-legacy-graph-mode', () => ({ LegacyGraphMode: () => null }))
vi.mock('@/app/account/(dashboard)/views/knowledge-library', () => ({
  KnowledgeLibrary: ({ initialPackageId, onPackageChange }: { initialPackageId?: string; onPackageChange?: (p: { id: string; name?: string } | null) => void }) =>
    React.createElement(
      'div',
      { 'data-library': initialPackageId ?? '' },
      React.createElement('button', { 'data-open-package': '', onClick: () => onPackageChange?.({ id: 'p2', name: 'Board prep' }) }, 'open'),
    ),
  PromotePackageDialog: () => null,
}))

import KnowledgeCard from '../pages/knowledge-card'
import { KnowledgeView } from '@/app/account/(dashboard)/views/knowledge-view'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const spec: PageCardSpec = { kind: 'knowledge', title: 'Knowledge' }
const MODE_KEY = 'knowledge-view-mode:ws-1'

let mount: ReturnType<typeof mountRoot>
beforeEach(() => {
  window.localStorage.clear()
  vi.stubGlobal('fetch', stubFetch({}).fn)
  mount = mountRoot()
})
afterEach(() => {
  mount.unmount()
  vi.unstubAllGlobals()
})

function card(id: string, store: ReturnType<typeof makeStore>, fullScreen: boolean, s: PageCardSpec = spec) {
  return React.createElement('section', { 'data-card': id }, React.createElement(KnowledgeCard, { toolCallId: id, spec: s, store, fullScreen }))
}

describe('KnowledgeCard', () => {
  it("keeps its surface to itself: the page's remembered choice is neither read nor written", async () => {
    window.localStorage.setItem(MODE_KEY, 'library')
    const store = makeStore('k1', spec)
    await mount.render(
      React.createElement('div', null, React.createElement('section', { 'data-real-page': '' }, React.createElement(KnowledgeView)), card('k1', store, false)),
    )
    // The page restored its library; the card stays on the claims.
    expect(mount.container.querySelector('[data-real-page] [data-library]')).not.toBeNull()
    expect(mount.container.querySelector('[data-card="k1"] [data-probe-list="claim"]')).not.toBeNull()
    // Inline, the map is a still with the way to full screen.
    expect(mount.container.querySelector('[data-card="k1"] [data-map]')).toBeNull()
    expect(mount.container.querySelector('[data-card="k1"]')!.textContent).toContain('The knowledge map opens in full screen.')
    await act(async () => (Array.from(mount.container.querySelectorAll('[data-card="k1"] button')).find((b) => b.textContent === 'Open the map') as HTMLElement).click())
    expect(store.fullScreen()).toBe('k1')
    expect(window.localStorage.getItem(MODE_KEY)).toBe('library')
  })

  it('opens on a package in the library when the agent named one', async () => {
    const pkgSpec: PageCardSpec = { kind: 'knowledge', title: 'Playbook', target: { type: 'package', id: 'p1', label: 'Sales playbook' }, tab: 'library' }
    await mount.render(card('k1', makeStore('k1', pkgSpec), false, pkgSpec))
    expect(mount.container.querySelector('[data-library="p1"]')).not.toBeNull()
  })

  it('moves the card to a package the person opens in the library', async () => {
    const libSpec: PageCardSpec = { kind: 'knowledge', title: 'Library', tab: 'library' }
    const store = makeStore('k1', libSpec)
    await mount.render(card('k1', store, false, libSpec))
    await act(async () => (mount.container.querySelector('[data-open-package]') as HTMLElement).click())
    expect(store.contextEntries()[0]).toMatchObject({ at: { type: 'package', id: 'p2', label: 'Board prep' }, moved: true, tab: 'library' })
  })

  it('runs the map full screen, and only one card at a time', async () => {
    const a = makeStore('k1', spec)
    const b = makeStore('k2', spec)
    await mount.render(React.createElement('div', null, card('k1', a, true), card('k2', b, true)))
    expect(mount.container.querySelectorAll('[data-map]')).toHaveLength(1)
    expect(mount.container.querySelector('[data-card="k1"] [data-map]')).not.toBeNull()
    // The first leaves full screen: the second takes the map.
    await mount.render(React.createElement('div', null, card('k1', a, false), card('k2', b, true)))
    expect(mount.container.querySelectorAll('[data-map]')).toHaveLength(1)
    expect(mount.container.querySelector('[data-card="k2"] [data-map]')).not.toBeNull()
  })
})
