// @vitest-environment jsdom
/**
 * The card header, with the real card and the real page body, on what the
 * review of the restored controls found:
 *   - a record card's X folds it after a Details / Cloud switch (the card's own
 *     record is not a record opened over it), and the switch is still a step;
 *   - a card's steps survive it mounting again (one opened during a turn
 *     joining the thread once the turn settles);
 *   - only the card the focus is in (or the full-screen one) holds its
 *     Properties locked open;
 *   - the focus never falls to <body> inside a card (a record opening over the
 *     list makes it inert; Back to the first step disables Back), so ⌘/Ctrl+[
 *     keeps working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, Suspense, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const flags = vi.hoisted(() => ({ locked: false }))

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('@/components/views/unified-view-layout', async () => {
  const React = await import('react')
  return {
    CardSurfaceContext: React.createContext(null),
    WindowFocusProvider: ({ children }: { children: ReactNode }) => children,
    UnifiedViewLayout: ({ onItemSelect }: { onItemSelect: (id: string, title: string) => void }) =>
      React.createElement('div', { 'data-list': '' }, React.createElement('button', { type: 'button', onClick: () => onItemSelect('a1', 'First') }, 'Open row')),
  }
})
vi.mock('@/app/account/(dashboard)/views/action-detail-panel', async () => {
  const React = await import('react')
  const { WindowProperties } = await import('@/components/views/window-properties')
  return {
    ActionDetailPanel: ({
      actionId,
      section,
      onSectionChange,
      onClose,
    }: {
      actionId: string
      section?: string
      onSectionChange?: (s: 'cloud' | undefined) => void
      onClose?: () => void
    }) =>
      React.createElement(
        'div',
        { 'data-action': actionId, 'data-section': section ?? 'details' },
        React.createElement('button', { type: 'button', onClick: () => onSectionChange?.('cloud') }, 'Cloud'),
        React.createElement('button', { type: 'button', 'aria-label': 'Close panel', onClick: () => onClose?.() }, 'X'),
        React.createElement(WindowProperties, { title: `Action ${actionId}`, locked: flags.locked, children: React.createElement('span', null, 'Priority: High') }),
      ),
  }
})
const { stub } = vi.hoisted(() => ({ stub: (name: string) => () => ({ [name]: () => null }) }))
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

const listSpec: CardSpec = { kind: 'list', title: 'Open actions', entity_type: 'action', filters: [] }
const recordSpec: CardSpec = { kind: 'record', title: 'Fix the login', record: { type: 'action', id: 'a1' } }

let container: HTMLDivElement
let stage: HTMLDivElement
let outside: HTMLButtonElement
let root: Root
let store: ChatCardStore

beforeEach(() => {
  window.localStorage.clear()
  flags.locked = false
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })))
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  container = document.createElement('div')
  stage = document.createElement('div')
  outside = document.createElement('button')
  outside.textContent = 'Composer'
  document.body.append(container, stage, outside)
  root = createRoot(container)
  store = new ChatCardStore()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  stage.remove()
  outside.remove()
  vi.unstubAllGlobals()
})

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

async function until(found: () => unknown) {
  for (let i = 0; i < 100 && !found(); i++) await act(async () => new Promise((r) => setTimeout(r, 20)))
  await settle()
}

/** The card, drawn in `slot` ('thread' or 'pending': a different parent, as the chat panel's two places are). */
async function render(spec: CardSpec, slot: 'thread' | 'pending' = 'thread') {
  store.setCards([{ id: 'c1', spec }])
  const card = h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec, count: 3 })
  await act(async () => {
    root.render(
      h(Suspense, { fallback: null }, h(ChatCardHostProvider, { value: { wide: true, store, stage }, children: slot === 'thread' ? h('section', null, card) : h('aside', null, card) })),
    )
  })
  await until(() => document.querySelector('[data-list], [data-action]'))
}

function inCard(): Element {
  return document.querySelector('[data-chat-card-fullscreen="c1"]') ?? container.querySelector('[data-chat-card="c1"]')!
}
function button(label: string, scope: ParentNode = inCard()): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === label || b.textContent === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found as HTMLButtonElement
}
/** A person's click: the focus, then the click. */
async function press(label: string, scope: ParentNode = inCard()) {
  const b = button(label, scope)
  await act(async () => {
    b.focus()
    b.click()
  })
  await settle()
}
function header(): HTMLElement {
  return inCard().querySelector('[data-card-header]') as HTMLElement
}
function shown(): string {
  const panel = inCard().querySelector('[data-action]')
  return panel ? `${panel.getAttribute('data-action')}:${panel.getAttribute('data-section')}` : 'list'
}
function popoverOpen(): boolean {
  return !!document.querySelector('[role="dialog"][aria-label="Action a1 properties"]')
}

describe('a record card’s X', () => {
  it('folds the card in one press after a Details / Cloud switch, which is still a step', async () => {
    await render(recordSpec)
    expect(shown()).toBe('a1:details')
    await press('Cloud')
    expect(shown()).toBe('a1:cloud')
    await press('Go back', header())
    expect(shown()).toBe('a1:details')
    await press('Go forward', header())
    expect(shown()).toBe('a1:cloud')

    await press('Close panel')
    expect(store.isCollapsed('c1')).toBe(true)
    expect(container.querySelector('[data-chat-card-pill="c1"]')).not.toBeNull()
  })
})

describe('a card’s steps', () => {
  it('survive the card mounting again elsewhere (a card opened during a turn joining the thread)', async () => {
    await render(listSpec, 'pending')
    await press('Open row')
    expect(shown()).toBe('a1:details')

    await render(listSpec, 'thread')
    expect(container.querySelector('aside')).toBeNull()
    expect(shown()).toBe('a1:details')
    expect(button('Go back', header()).disabled).toBe(false)
    await press('Go back', header())
    expect(shown()).toBe('list')
  })
})

describe('the card’s Properties popover, locked open', () => {
  it('holds open only while the focus is in the inline card', async () => {
    flags.locked = true
    await render(recordSpec)
    // Nothing in the card has the focus: not the card in front.
    outside.focus()
    await settle()
    expect(popoverOpen()).toBe(false)

    await act(async () => button('Cloud').focus())
    await settle()
    expect(popoverOpen()).toBe(true)

    // Into the popover (a portal): still the card's.
    const field = document.querySelector('[role="dialog"][aria-label="Action a1 properties"]') as HTMLElement
    await act(async () => {
      field.setAttribute('tabindex', '-1')
      field.focus()
    })
    await settle()
    expect(popoverOpen()).toBe(true)

    // The person clicks the composer: the lock goes with the focus.
    await act(async () => outside.focus())
    await settle()
    expect(popoverOpen()).toBe(false)
  })

  it('holds open full screen, wherever the focus is', async () => {
    flags.locked = true
    await render(recordSpec)
    await act(async () => store.enterFullScreen('c1'))
    await until(() => document.querySelector('[data-action]'))
    expect(popoverOpen()).toBe(true)
  })
})

describe('the focus inside a card', () => {
  it('goes to the record over the list (the list goes inert), and back to the row once it closes', async () => {
    await render(listSpec)
    const row = button('Open row')
    await press('Open row')
    expect(shown()).toBe('a1:details')
    const overlay = inCard().querySelector('[data-action]')!.closest('[tabindex="-1"]') as HTMLElement
    expect(document.activeElement).toBe(overlay)
    expect(inCard().contains(document.activeElement)).toBe(true)

    // So ⌘/Ctrl+[ still finds the card.
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true })))
    await settle()
    expect(shown()).toBe('list')
    expect(document.activeElement).toBe(row)
  })

  it('moves off a history button that its own step disabled', async () => {
    await render(listSpec)
    await press('Open row')
    await press('Go back', header())
    expect(shown()).toBe('list')
    expect(button('Go back', header()).disabled).toBe(true)
    expect(document.activeElement).toBe(button('Go forward', header()))

    await press('Go forward', header())
    expect(shown()).toBe('a1:details')
    expect(button('Go forward', header()).disabled).toBe(true)
    expect(document.activeElement).toBe(button('Go back', header()))

    // ⌘/Ctrl+[ keeps walking, the focus still in the card.
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true })))
    await settle()
    expect(shown()).toBe('list')
  })

  it('the inline card’s frame holds the focus (a click on its glass), and the keys with it', async () => {
    await render(listSpec)
    await press('Open row')
    const frame = container.querySelector('[data-chat-card="c1"]') as HTMLElement
    expect(frame.getAttribute('tabindex')).toBe('-1')
    await act(async () => frame.focus())
    expect(document.activeElement).toBe(frame)
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true })))
    await settle()
    expect(shown()).toBe('list')
  })
})
