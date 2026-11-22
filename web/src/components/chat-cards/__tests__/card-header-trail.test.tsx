// @vitest-environment jsdom
/**
 * A place inside a page, in its card's header (../card-header-slot.tsx
 * CardHeaderTrail; Liam, 11-22, a spreadsheet open: "this should all move
 * into the header. the back button should just be the breadcrum"): the
 * place follows the title after a chevron, and the title is the way back to
 * the page. With no place, the title is plain text again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Suspense, useState, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// The page: a list with one workbook; opening it draws its name in the header's trail.
vi.mock('@/components/views/unified-view-layout', async () => {
  const React = await import('react')
  const { CardHeaderTrail } = await import('../card-header-slot')
  function Page() {
    const [open, setOpen] = useState(false)
    if (!open) return React.createElement('div', { 'data-list': '' }, React.createElement('button', { type: 'button', onClick: () => setOpen(true) }, 'Open budget'))
    return React.createElement(
      'div',
      { 'data-open': '' },
      React.createElement(CardHeaderTrail, { onBack: () => setOpen(false), backLabel: 'Back to the list', children: React.createElement('span', { 'data-place': '' }, 'Fernhill budget') }),
    )
  }
  return {
    CardSurfaceContext: React.createContext(null),
    WindowFocusProvider: ({ children }: { children: ReactNode }) => children,
    UnifiedViewLayout: Page,
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

const spec: CardSpec = { kind: 'list', title: 'Workbooks', entity_type: 'action', filters: [] }

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

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

async function render() {
  await act(async () => {
    root.render(h(Suspense, { fallback: null }, h(ChatCardHostProvider, { value: { wide: true, store, stage }, children: [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec, count: 1 })] })))
  })
  for (let i = 0; i < 100 && !document.querySelector('[data-list]'); i++) await act(async () => new Promise((r) => setTimeout(r, 20)))
  await settle()
}

const header = () => container.querySelector('[data-chat-card="c1"] [data-card-header]') as HTMLElement
const title = () => header().querySelector('[data-card-header-title]') as HTMLElement

describe('a place inside the page, in the card’s header', () => {
  it('follows the title, which takes the page back; without one the title is plain', async () => {
    await render()
    expect(title().textContent).toBe('Workbooks')
    expect(header().querySelector('[data-card-header-back]')).toBeNull()

    await act(async () => (container.querySelector('[data-list] button') as HTMLButtonElement).click())
    await settle()
    // The place, after the title and a chevron; not in the page.
    const place = header().querySelector('[data-card-header-slot="trail"] [data-place]')
    expect(place?.textContent).toBe('Fernhill budget')
    expect(title().querySelector('svg')).not.toBeNull()
    const back = header().querySelector<HTMLButtonElement>('[data-card-header-back]')!
    expect(back.textContent).toBe('Workbooks')
    expect(back.getAttribute('aria-label')).toBe('Back to the list')

    await act(async () => back.click())
    await settle()
    expect(container.querySelector('[data-list]')).not.toBeNull()
    expect(header().querySelector('[data-card-header-back]')).toBeNull()
    expect(header().querySelector('[data-card-header-slot="trail"]')!.childElementCount).toBe(0)
    expect(title().querySelector('svg')).toBeNull()
  })
})
