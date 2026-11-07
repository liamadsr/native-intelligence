// @vitest-environment jsdom
/**
 * What the Knowledge page opens on.
 *
 * There are TWO defaults here and they are easy to confuse, which is why both
 * are pinned in one file:
 *
 *   1. the SURFACE — the header pill, Graph or Library (this file);
 *   2. the LAYOUT — how a claim view draws, graph/list/board
 *      (`defaultLayout('claim')`, also asserted here so the pair cannot drift).
 *
 * Getting either wrong produces a page that contradicts itself: a pill reading
 * "Graph" over a list of sentences, or a Library landing for a feature whose
 * saved views all live on the other side.
 *
 * The third rule is that neither default may override a returning viewer. The
 * mode is remembered per workspace, so someone who prefers the Library keeps
 * landing on it — and, separately, a package deep link forces the Library
 * whatever is stored, because the graph has no package panel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { defaultLayout } from '@/lib/views/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))

// The two surfaces, stubbed down to a marker each. This file is about WHICH
// one mounts; what they draw is covered where they live.
vi.mock('../knowledge-library', () => ({
  KnowledgeLibrary: () => h('div', { 'data-surface': 'library' }),
  PromotePackageDialog: () => null,
}))
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: () => h('div', { 'data-surface': 'graph' }),
}))
vi.mock('../knowledge-graph-layout', () => ({ KnowledgeGraphLayout: () => null }))
vi.mock('../knowledge-legacy-graph-mode', () => ({ LegacyGraphMode: () => null }))
vi.mock('../use-map-node-detail', () => ({
  isVirtualKey: () => false,
  useMapNodeDetail: () => ({ state: { status: 'idle' }, retry: () => {}, loadMore: () => {} }),
}))

import { KnowledgeView } from '../knowledge-view'

let container: HTMLDivElement
let root: Root

async function mount(props: Record<string, unknown> = {}) {
  await act(async () => {
    root.render(h(KnowledgeView, props as never))
  })
  return container.querySelector('[data-surface]')?.getAttribute('data-surface')
}

beforeEach(() => {
  window.localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  window.localStorage.clear()
  vi.clearAllMocks()
})

describe('the default surface', () => {
  it('is the GRAPH on a first visit', async () => {
    expect(await mount()).toBe('graph')
  })

  it('is still the graph when localStorage is unreadable', async () => {
    // Private mode / blocked storage. The old code read the stored value into
    // a state that started on 'library', so a throw here landed on the other
    // surface entirely rather than on the default.
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    try {
      expect(await mount()).toBe('graph')
    } finally {
      spy.mockRestore()
    }
  })

  it('is still the graph when the stored value is nonsense', async () => {
    window.localStorage.setItem('knowledge-view-mode:ws-1', 'librarry')
    expect(await mount()).toBe('graph')
  })
})

describe('a returning viewer keeps their own choice', () => {
  it('restores the Library when that is what they last used', async () => {
    window.localStorage.setItem('knowledge-view-mode:ws-1', 'library')
    expect(await mount()).toBe('library')
  })

  it('restores the graph explicitly too', async () => {
    window.localStorage.setItem('knowledge-view-mode:ws-1', 'graph')
    expect(await mount()).toBe('graph')
  })

  it('does not read another workspace’s choice', async () => {
    window.localStorage.setItem('knowledge-view-mode:ws-2', 'library')
    expect(await mount()).toBe('graph')
  })
})

describe('a package deep link still wins', () => {
  it('forces the Library even though the graph is the default', async () => {
    // A work run's package resource chip navigates here; the graph has no
    // PackagePanel, so the link would land on a surface that cannot show it.
    expect(await mount({ initialPackageId: 'pkg-1' })).toBe('library')
  })
})

describe('the layout default agrees with the surface default', () => {
  it('opens a claim view on the map, so the pill and the body say the same thing', () => {
    expect(defaultLayout('claim')).toBe('graph')
  })
})
