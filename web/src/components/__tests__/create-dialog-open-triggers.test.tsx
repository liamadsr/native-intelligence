// @vitest-environment jsdom
/**
 * What opens the create dialog. The top bar's Create button, the
 * `open-create-action` event it fired and the app-wide `c` key are gone
 * (Liam, 2026-10-20: the agent creates things on request). Mail's New email
 * (`open-create-email`, from its button and its own `c` key) still opens the
 * dialog, on Email.
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

const dialog = () => document.body.querySelector('[role="dialog"]')

describe('CreateDialog open triggers', () => {
  it('does not open on a bare `c` anywhere in the app', async () => {
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }))
    })
    expect(dialog()).toBeNull()
  })

  it('leaves a bare `c` alone, so Mail’s own `c` (compose) still sees it', async () => {
    const ev = new KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true })
    await act(async () => {
      document.body.dispatchEvent(ev)
    })
    expect(ev.defaultPrevented).toBe(false)
  })

  it('does not answer the retired `open-create-action` event', async () => {
    await act(async () => {
      document.dispatchEvent(new Event('open-create-action'))
    })
    expect(dialog()).toBeNull()
  })

  it('opens on Mail’s `open-create-email`', async () => {
    await act(async () => {
      document.dispatchEvent(new Event('open-create-email'))
    })
    expect(dialog()).not.toBeNull()
  })
})
