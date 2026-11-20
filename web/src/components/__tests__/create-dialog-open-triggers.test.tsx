// @vitest-environment jsdom
/**
 * What opens the create dialog. The rail's + and the app-wide `c` (Liam,
 * 11-20: back after 10-20's removal) fire `open-create`, on Action unless a
 * type is named. `c` is skipped while typing and while another dialog or menu
 * has the focus, and is never prevented, so Mail's own `c` (New email,
 * `open-create-email`) still sees it and lands on Email. The old top bar's
 * `open-create-action` stays retired.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/app/account/teams-context', () => ({ useTeams: () => ({ teams: [] }) }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({ useScopedLabels: () => ({ labels: [] }) }))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget: vi.fn() }))
vi.mock('@/calendar/hooks/use-calendar-events', () => ({ patchCalendarEventsCache: vi.fn() }))
vi.mock('@/calendar/adapters', () => ({ calendarEventToIEvent: vi.fn() }))
vi.mock('@/components/email/email-recipient-input', () => ({ EmailRecipientInput: () => null }))
vi.mock('@/components/ui/datetime-picker', () => ({ DateTimePicker: () => null }))

import { CreateDialog } from '../create-dialog'

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  container = document.createElement('div')
  document.body.appendChild(container)
  act(() => {
    root = createRoot(container)
    root.render(h(CreateDialog))
  })
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  container.remove()
  vi.unstubAllGlobals()
})

const dialog = () => document.body.querySelector('[data-create-dialog]')

const press = (target: EventTarget = document.body, init: KeyboardEventInit = {}) => {
  const ev = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(ev)
  return ev
}
const typeLabel = () => document.body.querySelector('[data-create-type-trigger]')?.textContent ?? ''

describe('CreateDialog open triggers', () => {
  it('opens on a bare `c` anywhere in the app, on Action', async () => {
    await act(async () => void press())
    expect(dialog()).not.toBeNull()
    expect(typeLabel()).toContain('New action')
  })

  it('leaves the `c` unprevented, so Mail’s own `c` (New email) still sees it', async () => {
    let ev: KeyboardEvent | null = null
    await act(async () => void (ev = press()))
    expect(ev!.defaultPrevented).toBe(false)
  })

  it('lands on Email when Mail answers the same `c`', async () => {
    // Mail's listener is on window, after the document's: it fires open-create-email.
    const mail = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && e.key === 'c') document.dispatchEvent(new Event('open-create-email'))
    }
    window.addEventListener('keydown', mail)
    await act(async () => void press())
    window.removeEventListener('keydown', mail)
    expect(typeLabel()).toContain('New email')
  })

  it('ignores `c` typed in a field, a contenteditable, a menu or another dialog', async () => {
    const input = document.createElement('input')
    const editable = document.createElement('div')
    editable.contentEditable = 'true'
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    const menuItem = document.createElement('button')
    menu.appendChild(menuItem)
    const other = document.createElement('div')
    other.setAttribute('role', 'dialog')
    const otherButton = document.createElement('button')
    other.appendChild(otherButton)
    document.body.append(input, editable, menu, other)
    for (const el of [input, editable, menuItem, otherButton]) {
      await act(async () => void press(el))
      expect(dialog()).toBeNull()
    }
    // A modified `c` (⌘C, Shift+C) is never the shortcut.
    await act(async () => void press(document.body, { metaKey: true }))
    await act(async () => void press(document.body, { shiftKey: true }))
    expect(dialog()).toBeNull()
    input.remove(); editable.remove(); menu.remove(); other.remove()
  })

  it('opens on `open-create`, on the type it names', async () => {
    await act(async () => void document.dispatchEvent(new CustomEvent('open-create', { detail: { type: 'project' } })))
    expect(typeLabel()).toContain('New project')
  })

  it('does not answer the retired `open-create-action` event', async () => {
    await act(async () => {
      document.dispatchEvent(new Event('open-create-action'))
    })
    expect(dialog()).toBeNull()
  })

  it('opens on Mail’s `open-create-email`, on Email', async () => {
    await act(async () => {
      document.dispatchEvent(new Event('open-create-email'))
    })
    expect(dialog()).not.toBeNull()
    expect(typeLabel()).toContain('New email')
  })

  it('opens on `open-create-contact`, on Contact', async () => {
    await act(async () => void document.dispatchEvent(new Event('open-create-contact')))
    expect(typeLabel()).toContain('New contact')
  })
})
