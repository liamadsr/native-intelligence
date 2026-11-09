// @vitest-environment jsdom
/**
 * A full-screen card takes the whole window: its layer sits on <body>, over the
 * top bar and the composer, with the frosted backdrop (tailwind.css
 * .card-focus-backdrop, a soft grey veil, not a dark one) behind the card, an
 * X in the corner and a big button under the card to put it back. Inline, the
 * card's Full screen and Close are big round buttons over its corner.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Suspense, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/views/unified-view-layout', async () => {
  const React = await import('react')
  return {
    CardSurfaceContext: React.createContext(null),
    WindowFocusProvider: ({ children }: { children: ReactNode }) => children,
    UnifiedViewLayout: () => React.createElement('div', { 'data-list': '' }),
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
import { FRONT_CARD_ATTR, closeFrontCards, frontCard } from '../front-card'
import type { CardSpec } from '@/lib/chat-cards/kinds'

const spec: CardSpec = { kind: 'list', title: 'Open actions', entity_type: 'action', filters: [] }

let container: HTMLDivElement
let stage: HTMLDivElement
let root: Root
let store: ChatCardStore

beforeEach(() => {
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

async function render() {
  await act(async () => {
    root.render(h(Suspense, { fallback: null }, h(ChatCardHostProvider, { value: { wide: true, store, stage }, children: [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec, count: 3 })] })))
  })
  for (let i = 0; i < 100 && !document.querySelector('[data-list]'); i++) await act(async () => new Promise((r) => setTimeout(r, 20)))
}

const buttons = (scope: ParentNode, label: string) => Array.from(scope.querySelectorAll(`button[aria-label="${label}"]`)) as HTMLButtonElement[]

describe('a full-screen card', () => {
  it('opens from the big Full screen button over the inline card, not the header', async () => {
    await render()
    const card = container.querySelector('[data-chat-card="c1"]')!
    expect(buttons(card.querySelector('[data-card-header]')!, 'Full screen')).toHaveLength(0)
    const [full] = buttons(card, 'Full screen')
    expect(full.className).toContain('rounded-full')
    expect(buttons(card, 'Close')).toHaveLength(1)
    await act(async () => full.click())
    expect(document.querySelector('[data-chat-card-fullscreen="c1"]')).not.toBeNull()
  })

  it('takes the whole window over a frosted backdrop, and its X or the button under it puts it back', async () => {
    await render()
    await act(async () => store.enterFullScreen('c1'))
    const layer = document.querySelector('[data-chat-card-fullscreen="c1"]')!
    expect(layer.parentElement).toBe(document.body)
    expect(layer.className).toContain('fixed')
    expect(layer.classList.contains('card-focus-backdrop')).toBe(true)
    expect(layer.className).not.toContain('bg-black')
    expect(stage.contains(layer)).toBe(false)

    const back = buttons(layer, 'Back into the chat')
    expect(back).toHaveLength(2)
    await act(async () => back[0].click())
    expect(document.querySelector('[data-chat-card-fullscreen="c1"]')).toBeNull()

    await act(async () => store.enterFullScreen('c1'))
    await act(async () => buttons(document.querySelector('[data-chat-card-fullscreen="c1"]')!, 'Back into the chat')[1].click())
    expect(document.querySelector('[data-chat-card-fullscreen="c1"]')).toBeNull()
  })

  it('starts at the app rail’s edge, as the layer the rail keeps its veil off (card-page-layer)', async () => {
    await render()
    await act(async () => store.enterFullScreen('c1'))
    const layer = document.querySelector<HTMLElement>('[data-chat-card-fullscreen="c1"]')!
    expect(layer.classList.contains('card-page-layer')).toBe(true)
    expect(layer.style.left).toBe('var(--app-rail-w, 0px)')
    expect(layer.className).toContain('right-0')
    expect(layer.className).not.toContain('inset-0')
  })

  it('is the card in front while full screen: the rail lights it, <html> is marked, and its close puts it back', async () => {
    await render()
    expect(frontCard()).toBeNull()
    await act(async () => store.enterFullScreen('c1'))
    expect(frontCard()?.id).toBe('c1')
    expect(frontCard()?.spec).toEqual(spec)
    expect(document.documentElement.hasAttribute(FRONT_CARD_ATTR)).toBe(true)
    await act(async () => closeFrontCards())
    expect(store.fullScreen()).toBeNull()
    expect(document.querySelector('[data-chat-card-fullscreen="c1"]')).toBeNull()
    expect(frontCard()).toBeNull()
    expect(document.documentElement.hasAttribute(FRONT_CARD_ATTR)).toBe(false)
  })

  it('its close leaves alone another card that went full screen since', async () => {
    await render()
    await act(async () => store.enterFullScreen('c1'))
    const close = frontCard()!.close
    store.setCards([{ id: 'c1', spec }, { id: 'c2', spec }])
    await act(async () => store.enterFullScreen('c2'))
    close()
    expect(store.fullScreen()).toBe('c2')
    await act(async () => store.exitFullScreen())
  })

  it('folds to its pill from the big Close button', async () => {
    await render()
    await act(async () => buttons(container.querySelector('[data-chat-card="c1"]')!, 'Close')[0].click())
    expect(container.querySelector('[data-chat-card-pill="c1"]')).not.toBeNull()
  })
})
