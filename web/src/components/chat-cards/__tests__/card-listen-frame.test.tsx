// @vitest-environment jsdom
/**
 * Listen mode's pulse goes around the whole card, its header too. The pulse
 * fills the box it is drawn in; when the header moved out of the card's body
 * (the header's Back, Forward and Properties) it was drawn around the body
 * alone, and lit everything but the header. It is now drawn in the card's
 * frame, beside the header and the page, inline and full screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Suspense, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/read-aloud/listen-frame', async (importOriginal) => {
  const React = await import('react')
  const actual = await importOriginal<typeof import('@/components/read-aloud/listen-frame')>()
  return {
    ...actual,
    // Where the real pulse draws: over the box it is in.
    ListenFramePulseHere: () => React.createElement('div', { 'data-listen-pulse-here': '' }),
  }
})
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

/** One pulse in the card, in the box that holds its header and its page. */
function expectFramedTogether(card: Element) {
  const pulses = card.querySelectorAll('[data-listen-pulse-here]')
  expect(pulses).toHaveLength(1)
  const frame = pulses[0].parentElement!
  expect(frame.querySelector('[data-card-header]')).not.toBeNull()
  expect(frame.querySelector('[data-list]')).not.toBeNull()
}

describe('listen mode’s pulse around a card', () => {
  it('wraps an inline card’s header with its body', async () => {
    await render()
    expectFramedTogether(container.querySelector('[data-chat-card="c1"]')!)
  })

  it('wraps a full-screen card’s header with its body', async () => {
    await render()
    await act(async () => store.enterFullScreen('c1'))
    for (let i = 0; i < 100 && !document.querySelector('[data-chat-card-fullscreen="c1"] [data-list]'); i++) await act(async () => new Promise((r) => setTimeout(r, 20)))
    expectFramedTogether(document.querySelector('[data-chat-card-fullscreen="c1"]')!)
    // The inline placeholder left behind draws no pulse of its own.
    expect(container.querySelector('[data-listen-pulse-here]')).toBeNull()
  })
})
