/**
 * Shared by the page-card render tests: a root to mount into, a store with one
 * card, and a stand-in for UnifiedViewLayout (mocked in each test file with
 * `probeListModule`) that resolves its card options exactly as the real one
 * does (its own `card` prop, else the card surface around it) and shows what
 * it got, so a test can tell a card list from the real page's list.
 */
import * as React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ChatCardStore } from '../card-store'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import type { CardLayoutOptions, CardSurface } from '@/components/views/unified-view-layout'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** What every probe list saw, by its data-probe id, newest render last. */
export const probeSeen: Array<{ entityType: string; key: string; card: CardLayoutOptions | undefined }> = []

/**
 * The mocked module: the real one's exports, with UnifiedViewLayout swapped
 * for a probe. Use as `vi.mock('@/components/views/unified-view-layout', probeListModule)`.
 */
export async function probeListModule(importOriginal: () => Promise<unknown>) {
  const actual = (await importOriginal()) as Record<string, unknown> & { CardSurfaceContext: React.Context<CardSurface | null> }
  function ProbeList(props: {
    entityType: string
    teamId?: string
    viewScope?: { type: string; id: string }
    card?: CardLayoutOptions
    onItemSelect?: (id: string, title: string) => void
    renderGraph?: (args: { filters: unknown[]; search: string }) => React.ReactNode
  }) {
    const surface = React.useContext(actual.CardSurfaceContext)
    const key = `${props.entityType}:${props.viewScope ? `${props.viewScope.type}:${props.viewScope.id}` : (props.teamId ?? '')}`
    const card = props.card ?? surface?.listOptions(props.entityType as never, key)
    probeSeen.push({ entityType: props.entityType, key, card })
    return React.createElement(
      'div',
      { 'data-probe-list': props.entityType, 'data-card': card ? 'yes' : 'no', 'data-key': key },
      React.createElement('button', { type: 'button', 'data-probe-open': '', onClick: () => props.onItemSelect?.('00000000-0000-4000-8000-00000000abcd', 'Row one') }, 'open'),
      // A list that can draw a graph layout draws it, as if the person picked it.
      props.renderGraph ? React.createElement('div', { 'data-probe-graph': '' }, props.renderGraph({ filters: [], search: '' })) : null,
    )
  }
  return { ...actual, UnifiedViewLayout: ProbeList }
}

export function makeStore(id: string, spec: CardSpec): ChatCardStore {
  const store = new ChatCardStore()
  store.setCards([{ id, spec }])
  return store
}

export function mountRoot() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  return {
    container,
    async render(node: React.ReactNode) {
      await act(async () => {
        root.render(React.createElement(React.Suspense, { fallback: null }, node))
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0))
      })
    },
    unmount() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

/** A fetch that answers every request with an empty JSON body of the given shape. */
export function stubFetch(body: Record<string, unknown> = {}) {
  const calls: string[] = []
  const fn = async (input: unknown) => {
    calls.push(String(input))
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return { fn, calls }
}
