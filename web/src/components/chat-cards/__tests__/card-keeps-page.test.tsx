// @vitest-environment jsdom
/**
 * A card's page stays the same instance when the card goes full screen and
 * back: its node moves between the inline frame and the full-screen layer, so
 * nothing mounts again (a calendar or a mailbox used to load again on every
 * expand). Its scroll position comes along. Folding the card to its pill still
 * lets the page go.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Suspense, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { mounts } = vi.hoisted(() => ({ mounts: { count: 0 } }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/views/unified-view-layout', async () => {
  const React = await import('react')
  return {
    CardSurfaceContext: React.createContext(null),
    WindowFocusProvider: ({ children }: { children: ReactNode }) => children,
    UnifiedViewLayout: () => {
      React.useEffect(() => {
        mounts.count += 1
      }, [])
      return React.createElement('div', { 'data-list': '' })
    },
  }
})
const { stub } = vi.hoisted(() => ({ stub: (name: string) => () => ({ [name]: () => null }) }))
vi.mock('@/app/account/(dashboard)/views/action-detail-panel', stub('ActionDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/capture-detail-panel', stub('CaptureDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/document-detail-panel', stub('DocumentDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/contact-detail-panel', stub('ContactDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/company-detail-panel', stub('CompanyDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/project-detail-panel', stub('ProjectDetailPanel'))
vi.mock('@/app/account/(dashboard)/views/initiative-detail-panel', stub('InitiativeDetailPanel'))
vi.mock('../pages/page-card', () => ({ PageGate: () => null }))

import { ShowToolCard } from '../show-tool-card'
import { ChatCardHostProvider } from '../card-host'
import { ChatCardStore } from '../card-store'
import type { CardSpec } from '@/lib/chat-cards/kinds'

const spec: CardSpec = { kind: 'list', title: 'Open actions', entity_type: 'action', filters: [] }

let container: HTMLDivElement
let stage: HTMLDivElement
let root: Root
let store: ChatCardStore

beforeEach(() => {
  mounts.count = 0
  window.localStorage.clear()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div')
  stage = document.createElement('div')
  document.body.append(container, stage)
  root = createRoot(container)
  store = new ChatCardStore()
  store.setCards([{ id: 'c1', spec }])
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  stage.remove()
  vi.unstubAllGlobals()
})

async function listShown() {
  for (let i = 0; i < 100 && !document.querySelector('[data-list]'); i++) await act(async () => new Promise((r) => setTimeout(r, 20)))
}

async function render() {
  await act(async () => {
    root.render(h(Suspense, { fallback: null }, h(ChatCardHostProvider, { value: { wide: true, store, stage }, children: [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec, count: 3 })] })))
  })
  await listShown()
}

describe('a card’s page across full screen', () => {
  it('stays the same instance, mounted once, and keeps its scroll', async () => {
    await render()
    const list = document.querySelector('[data-list]') as HTMLElement
    expect(container.querySelector('[data-chat-card="c1"]')!.contains(list)).toBe(true)
    expect(mounts.count).toBe(1)
    list.scrollTop = 300

    await act(async () => store.enterFullScreen('c1'))
    expect(document.querySelector('[data-chat-card-fullscreen="c1"] [data-list]')).toBe(list)
    expect(mounts.count).toBe(1)
    expect(list.scrollTop).toBe(300)

    await act(async () => store.exitFullScreen())
    expect(container.querySelector('[data-chat-card="c1"] [data-list]')).toBe(list)
    expect(mounts.count).toBe(1)
  })

  it('lets the page go when the card folds to its pill', async () => {
    await render()
    await act(async () => store.collapse('c1'))
    expect(document.querySelector('[data-list]')).toBeNull()
    await act(async () => store.expand('c1'))
    await listShown()
    expect(document.querySelector('[data-list]')).not.toBeNull()
    expect(mounts.count).toBe(2)
  })
})
