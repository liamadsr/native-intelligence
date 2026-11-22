// @vitest-environment jsdom
/**
 * The Knowledge card draws the real KnowledgeView, on the claims alone; the
 * Library is its own card since the split (Liam, 11-21). Inline the map is a
 * still; full screen it runs, one card at a time. The Library card draws the
 * real KnowledgeLibrary, opens on the package the agent or a link named, and
 * moves to the package the person opens.
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
      React.createElement('button', { 'data-close-package': '', onClick: () => onPackageChange?.(null) }, 'close'),
    ),
  PromotePackageDialog: () => null,
}))

import KnowledgeCard from '../pages/knowledge-card'
import KnowledgeLibraryCard from '../pages/knowledge-library-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

const spec: PageCardSpec = { kind: 'knowledge', title: 'Knowledge' }

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
  const Body = s.kind === 'knowledge_library' ? KnowledgeLibraryCard : KnowledgeCard
  return React.createElement('section', { 'data-card': id }, React.createElement(Body, { toolCallId: id, spec: s, store, fullScreen }))
}

describe('KnowledgeCard', () => {
  it('draws the claims, never the Library, whatever the old picker remembered', async () => {
    window.localStorage.setItem('knowledge-view-mode:ws-1', 'library')
    const store = makeStore('k1', spec)
    await mount.render(card('k1', store, false))
    expect(mount.container.querySelector('[data-card="k1"] [data-probe-list="claim"]')).not.toBeNull()
    expect(mount.container.querySelector('[data-library]')).toBeNull()
    // Inline, the map is a still with the way to full screen.
    expect(mount.container.querySelector('[data-card="k1"] [data-map]')).toBeNull()
    expect(mount.container.querySelector('[data-card="k1"]')!.textContent).toContain('The knowledge map opens in full screen.')
    await act(async () => (Array.from(mount.container.querySelectorAll('[data-card="k1"] button')).find((b) => b.textContent === 'Open the map') as HTMLElement).click())
    expect(store.fullScreen()).toBe('k1')
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

describe('KnowledgeLibraryCard (the Library, Liam, 11-21)', () => {
  const library: PageCardSpec = { kind: 'knowledge_library', title: 'Library' }

  it('draws the Library, not the claims', async () => {
    await mount.render(card('l1', makeStore('l1', library), false, library))
    expect(mount.container.querySelector('[data-library=""]')).not.toBeNull()
    expect(mount.container.querySelector('[data-probe-list]')).toBeNull()
  })

  it('opens on a package when the agent or a link named one', async () => {
    const pkgSpec: PageCardSpec = { kind: 'knowledge_library', title: 'Playbook', target: { type: 'package', id: 'p1', label: 'Sales playbook' } }
    await mount.render(card('l1', makeStore('l1', pkgSpec), false, pkgSpec))
    expect(mount.container.querySelector('[data-library="p1"]')).not.toBeNull()
  })

  it('moves the card to a package the person opens, and back to the top when they close it', async () => {
    const store = makeStore('l1', library)
    await mount.render(card('l1', store, false, library))
    await act(async () => (mount.container.querySelector('[data-open-package]') as HTMLElement).click())
    const entry = store.contextEntries()[0]
    expect(entry).toMatchObject({ kind: 'knowledge_library', at: { type: 'package', id: 'p2', label: 'Board prep' }, moved: true })
    expect(entry.tab).toBeUndefined()
    expect(mount.container.querySelector('[data-library="p2"]')).not.toBeNull()
    await act(async () => (mount.container.querySelector('[data-close-package]') as HTMLElement).click())
    expect(store.contextEntries()[0].at).toBeUndefined()
  })
})
