// @vitest-environment jsdom
/**
 * The card header's controls, with the real card and the real page body: a
 * list card's row opens its record inside the card, the record's inner
 * section is a step too, and the header's Back and Forward (and ⌘/Ctrl+[ and
 * ]) walk list → record → section, keeping the steps across a move to full
 * screen. Nothing inside the card draws a Back row of its own. The record's
 * properties and actions go in the header's Properties popover, as they went
 * in a window's.
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
    UnifiedViewLayout: ({ onItemSelect, obscured }: { onItemSelect: (id: string, title: string) => void; obscured?: boolean }) =>
      React.createElement('div', { 'data-list': '', 'data-obscured': String(!!obscured) }, React.createElement('button', { type: 'button', onClick: () => onItemSelect('a1', 'First') }, 'Open row')),
  }
})
vi.mock('@/app/account/(dashboard)/views/action-detail-panel', async () => {
  const React = await import('react')
  const { WindowActions, WindowProperties } = await import('@/components/views/window-properties')
  return {
    ActionDetailPanel: ({
      actionId,
      section,
      onSectionChange,
      onSelectAction,
    }: {
      actionId: string
      section?: string
      onSectionChange?: (s: 'cloud' | undefined) => void
      onSelectAction?: (id: string, title: string) => void
    }) =>
      React.createElement(
        'div',
        { 'data-action': actionId, 'data-section': section ?? 'details' },
        React.createElement('button', { type: 'button', onClick: () => onSectionChange?.('cloud') }, 'Cloud'),
        React.createElement('button', { type: 'button', onClick: () => onSelectAction?.('a2', 'Second') }, 'Open second'),
        React.createElement(WindowActions, { className: 'toolbar', children: React.createElement('button', { type: 'button' }, 'Copy ID') }),
        React.createElement(WindowProperties, { title: `Action ${actionId}`, children: React.createElement('span', null, 'Priority: High') }),
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

async function settle() {
  for (let i = 0; i < 3; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

/** Until the lazy page has loaded into the card. */
async function bodyLoaded() {
  for (let i = 0; i < 100 && !document.querySelector('[data-list]'); i++) await act(async () => new Promise((r) => setTimeout(r, 20)))
  await settle()
}

async function render() {
  await act(async () => {
    root.render(h(Suspense, { fallback: null }, h(ChatCardHostProvider, { value: { wide: true, store, stage }, children: [h(ShowToolCard, { key: 'c1', toolCallId: 'c1', spec, count: 3 })] })))
  })
  await bodyLoaded()
}

function inCard(): Element {
  return document.querySelector('[data-chat-card-fullscreen="c1"]') ?? container.querySelector('[data-chat-card="c1"]')!
}
function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = Array.from(scope.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === label || b.textContent === label)
  if (!found) throw new Error(`Missing button: ${label}`)
  return found as HTMLButtonElement
}
async function click(label: string, scope: ParentNode = inCard()) {
  await act(async () => button(label, scope).click())
  await settle()
}
function header(): HTMLElement {
  return inCard().querySelector('[data-card-header]') as HTMLElement
}
function shown(): string {
  const panel = inCard().querySelector('[data-action]')
  return panel ? `${panel.getAttribute('data-action')}:${panel.getAttribute('data-section')}` : 'list'
}

describe('the card header’s Back and Forward', () => {
  it('walk list → record → inner section, and a new step drops Forward', async () => {
    await render()
    const back = () => button('Go back', header())
    const forward = () => button('Go forward', header())
    expect(back().disabled).toBe(true)
    expect(forward().disabled).toBe(true)
    expect(back().title).toBe('Go back (⌘/Ctrl+[)')
    expect(forward().title).toBe('Go forward (⌘/Ctrl+])')

    await click('Open row')
    expect(shown()).toBe('a1:details')
    await click('Cloud')
    expect(shown()).toBe('a1:cloud')
    expect(store.state('c1').open).toMatchObject({ type: 'action', id: 'a1', section: 'cloud' })

    await click('Go back', header())
    expect(shown()).toBe('a1:details')
    await click('Go back', header())
    expect(shown()).toBe('list')
    expect(back().disabled).toBe(true)
    // What the card keeps follows Back: the list, no record.
    expect(store.state('c1').open).toBeNull()

    await click('Go forward', header())
    expect(shown()).toBe('a1:details')
    await click('Go forward', header())
    expect(shown()).toBe('a1:cloud')
    expect(forward().disabled).toBe(true)

    await click('Go back', header())
    await click('Open second')
    expect(shown()).toBe('a2:details')
    expect(forward().disabled).toBe(true)
    await click('Go back', header())
    expect(shown()).toBe('a1:details')
  })

  it('draws no Back row inside the card: the header’s Back replaces it', async () => {
    await render()
    await click('Open row')
    expect(inCard().textContent).not.toMatch(/Back to/)
    expect(Array.from(inCard().querySelectorAll('button')).filter((b) => /back/i.test(b.textContent ?? ''))).toEqual([])
  })

  it('opens the record over the list as main’s windows did: the list invisible, the overlay clear over the glass', async () => {
    await render()
    await click('Open row')
    const list = inCard().querySelector('[data-list]') as HTMLElement
    expect(list.parentElement!.className).toContain('invisible')
    expect(list.parentElement!.hasAttribute('inert')).toBe(true)
    const overlay = inCard().querySelector('[data-action]')!.closest('.absolute') as HTMLElement
    expect(overlay.className).not.toContain('bg-background')
    await click('Go back', header())
    expect((inCard().querySelector('[data-list]') as HTMLElement).parentElement!.className).not.toContain('invisible')
  })

  it('keeps its steps across full screen, where ⌘/Ctrl+[ and ] walk them (not the Shift chords)', async () => {
    await render()
    await click('Open row')
    await click('Full screen')
    expect(document.querySelector('[data-chat-card-fullscreen="c1"]')).not.toBeNull()
    expect(shown()).toBe('a1:details')
    expect(button('Go back', header()).disabled).toBe(false)

    // ⌘⇧[ is the tab bar's previous chat: not a step back.
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true, shiftKey: true })))
    expect(shown()).toBe('a1:details')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true })))
    await settle()
    expect(shown()).toBe('list')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', ctrlKey: true })))
    await settle()
    expect(shown()).toBe('a1:details')
  })

  it('an inline card takes the keys only while the focus is in it', async () => {
    await render()
    await click('Open row')
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true })))
    expect(shown()).toBe('a1:details')
    button('Cloud', inCard()).focus()
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true })))
    await settle()
    expect(shown()).toBe('list')
    outside.remove()
  })
})

describe('the card header’s Properties popover', () => {
  it('holds the record’s properties and, under Actions, its toolbar actions', async () => {
    await render()
    expect(header().querySelector('[aria-label="Properties"]')).toBeNull()
    await click('Open row')
    const props = button('Properties', header())
    // In the header's right slot, before Save as view.
    expect(props.closest('[data-card-header-slot="right"]')).not.toBeNull()
    // Not drawn in the page: no inline sidebar, no toolbar row.
    expect(inCard().querySelector('.toolbar')).toBeNull()
    expect(inCard().textContent).not.toContain('Priority: High')

    await act(async () => props.click())
    await settle()
    const dialog = document.querySelector('[role="dialog"][aria-label="Action a1 properties"]')!
    expect(dialog).not.toBeNull()
    expect(dialog.textContent).toContain('Priority: High')
    const group = dialog.querySelector('[role="group"][aria-label="Actions"]')!
    expect(group.textContent).toContain('Copy ID')
  })
})
