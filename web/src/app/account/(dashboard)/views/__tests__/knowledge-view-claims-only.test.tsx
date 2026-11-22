// @vitest-environment jsdom
/**
 * Knowledge is the claims alone (Liam, 11-21: "split the Knowledge page into
 * two pages"). It had a Graph / Library picker in its header; the Library is
 * its own page now (components/chat-cards/pages/knowledge-library-card.tsx),
 * so Knowledge draws the claims every time, with no picker: in its card the
 * card header holds only the search. A choice remembered by the old picker
 * moves nothing, and nothing writes one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'
import { defaultLayout } from '@/lib/views/types'
import { CardHeaderSlotsProvider } from '@/components/chat-cards/card-header-slot'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1' }))
vi.mock('@/hooks/use-entity-sync', () => ({ useEntityListSync: () => {} }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// The claims, stubbed down to a marker; the Library too, so a stray mount of
// it would show. What they draw is covered where they live.
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

async function mount(props: Record<string, unknown> = {}, wrap?: (node: ReactNode) => ReactNode) {
  const node = h(KnowledgeView, props as never)
  await act(async () => {
    root.render(wrap ? wrap(node) : node)
  })
  return [...container.querySelectorAll('[data-surface]')].map((el) => el.getAttribute('data-surface'))
}

/** Anything that reads as the old picker: a menu trigger, or a pill named Graph or Library. */
function pickers(scope: ParentNode): Element[] {
  const named = [...scope.querySelectorAll('button')].filter((b) => /^(Graph|Library)$/.test(b.textContent?.trim() ?? ''))
  return [...scope.querySelectorAll('[aria-haspopup="menu"]'), ...named]
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

describe('Knowledge has no surface picker', () => {
  it('draws the claims, never the Library, and offers no Graph / Library picker', async () => {
    expect(await mount()).toEqual(['graph'])
    expect(pickers(container)).toEqual([])
    expect(container.querySelector('h1')?.textContent).toBe('Knowledge')
  })

  it('an old remembered choice of the Library moves nothing, and nothing is written', async () => {
    window.localStorage.setItem('knowledge-view-mode:ws-1', 'library')
    const setItem = vi.spyOn(Storage.prototype, 'setItem')
    try {
      expect(await mount()).toEqual(['graph'])
      expect(setItem.mock.calls.some(([key]) => String(key).startsWith('knowledge-view-mode:'))).toBe(false)
    } finally {
      setItem.mockRestore()
    }
  })

  it('in its card, the card header holds the search alone', async () => {
    const left = document.createElement('div')
    const right = document.createElement('div')
    document.body.append(left, right)
    try {
      const card = { mapAllowed: true, onWantMap: () => {} }
      const surfaces = await mount({ card }, (node) => h(CardHeaderSlotsProvider, { value: { left, right } }, node))
      expect(surfaces).toEqual(['graph'])
      // The search's own button, and nothing beside it.
      expect([...right.querySelectorAll('button, [role="button"]')].map((b) => b.getAttribute('aria-label'))).toEqual(['Search knowledge'])
      expect(pickers(right)).toEqual([])
      expect(left.childElementCount).toBe(0)
      // A record open over the page owns the header: the search leaves it.
      await mount({ card: { ...card, covered: true } }, (node) => h(CardHeaderSlotsProvider, { value: { left, right } }, node))
      expect(right.childElementCount).toBe(0)
    } finally {
      left.remove()
      right.remove()
    }
  })
})

describe('the layout default', () => {
  it('opens a claim view on the map', () => {
    expect(defaultLayout('claim')).toBe('graph')
  })
})
