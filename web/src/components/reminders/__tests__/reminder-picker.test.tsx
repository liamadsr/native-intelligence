// @vitest-environment jsdom
/**
 * The picker is the ONE surface every reminder entry point renders (toolbar
 * button, header pill, row context menu), so its list contents are the feature's
 * contract: four presets, a Custom row, and a Remove row that appears only when
 * a pending reminder exists. A regression here silently removes an entry point
 * rather than throwing.
 *
 * Mounted standalone with createRoot (mirrors proposal-card-target-picker.test.tsx).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom has no ResizeObserver; cmdk (the Command list) requires one
// (mirrors proposal-card-target-picker.test.tsx).
;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// cmdk scrolls the selected item into view on every list change; jsdom has no
// layout, so Element.scrollIntoView is simply absent.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {}
}

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const setReminder = vi.fn(async () => ({}))
const clearReminder = vi.fn(async () => {})
const fetchReminder = vi.fn(async (): Promise<unknown> => null)
vi.mock('@/lib/reminders/client', () => ({
  setReminder: (...args: unknown[]) => setReminder(...(args as [])),
  clearReminder: (...args: unknown[]) => clearReminder(...(args as [])),
  fetchReminder: (...args: unknown[]) => fetchReminder(...(args as [])),
  emitReminderChanged: vi.fn(),
  onReminderChanged: vi.fn(() => () => {}),
}))

// chrono-node is dynamically imported on the first keystroke; stub it so the
// typed-input path is deterministic and never pulls the real ~200KB parser.
// `parse` is re-run at select time (finding 12), so each phrase resolves
// relative to the clock at the moment it is called, exactly like chrono does.
vi.mock('chrono-node', () => ({
  parse: (text: string) => {
    if (text.includes('4 pm')) return [{ date: () => new Date(Date.now() + 3 * 3600_000) }]
    if (text.includes('ago')) return [{ date: () => new Date(Date.now() - 3600_000) }]
    return []
  },
}))

import { ReminderPickerContent } from '../reminder-picker'
import type { Reminder } from '@/lib/reminders/types'

let container: HTMLDivElement
let root: Root

function makeReminder(): Reminder {
  return {
    id: 'rem-1',
    workspace_id: 'ws-1',
    user_id: 'usr-1',
    entity_type: 'action',
    entity_id: 'act-1',
    remind_at: new Date(Date.now() + 3600_000).toISOString(),
    delivered_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

function items(): HTMLElement[] {
  return Array.from(container.querySelectorAll('[cmdk-item]'))
}

// `existing` is three-valued and `undefined` is a MEANINGFUL value here ("go
// fetch it yourself"), so it is passed explicitly rather than defaulted — a
// default parameter would swallow exactly the case worth testing.
function renderPicker(existing: Reminder | null | undefined) {
  const onDone = vi.fn()
  act(() => {
    root.render(
      h(ReminderPickerContent, {
        entityType: 'action',
        entityId: 'act-1',
        existing,
        onDone,
      }),
    )
  })
  return { onDone }
}

/** Type into the cmdk input (controlled — set the value the way React reads it). */
async function type(text: string) {
  const input = container.querySelector('input')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!
    setter.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('ReminderPickerContent', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })
  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    vi.clearAllMocks()
  })

  it('empty input shows the four presets plus Custom, and no Remove row', () => {
    renderPicker(null)
    const text = container.textContent ?? ''
    expect(text).toContain('An hour from now')
    expect(text).toContain('Tomorrow')
    expect(text).toContain('Next week')
    expect(text).toContain('A month from now')
    expect(text).toContain('Custom...')
    expect(text).not.toContain('Remove reminder')
    // 4 presets + Custom
    expect(items().length).toBe(5)
  })

  it('adds the destructive Remove row when a pending reminder exists', () => {
    renderPicker(makeReminder())
    expect(container.textContent).toContain('Remove reminder')
    expect(items().length).toBe(6)
  })

  it('selecting a preset sets the reminder and closes the surface', async () => {
    const { onDone } = renderPicker(null)
    const tomorrow = items().find((el) => el.textContent?.includes('Tomorrow'))!
    await act(async () => {
      tomorrow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(setReminder).toHaveBeenCalledTimes(1)
    const [entityType, entityId, date] = setReminder.mock.calls[0] as unknown as [
      string,
      string,
      Date,
    ]
    expect(entityType).toBe('action')
    expect(entityId).toBe('act-1')
    expect(date.getHours()).toBe(9)
    expect(onDone).toHaveBeenCalled()
  })

  it('selecting Remove clears the reminder and closes the surface', async () => {
    const { onDone } = renderPicker(makeReminder())
    const remove = items().find((el) => el.textContent?.includes('Remove reminder'))!
    await act(async () => {
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
    expect(clearReminder).toHaveBeenCalledWith('action', 'act-1')
    expect(onDone).toHaveBeenCalled()
  })

  it('typed input replaces the presets with the single parsed row', async () => {
    renderPicker(null)
    await type('at 4 pm')
    const text = container.textContent ?? ''
    expect(text).not.toContain('An hour from now')
    expect(text).toContain('at 4 pm')
    expect(items().length).toBe(1)
  })

  it('typed input chrono cannot parse falls back to "No date found"', async () => {
    renderPicker(null)
    await type('zzzz')
    expect(container.textContent).toContain('No date found')
    expect(container.textContent).not.toContain('Parsing')
    expect(items().length).toBe(0)
  })

  // Finding 8: the first keystroke awaits a ~200KB dynamic import, during which
  // `parsed` is still null — the list must not claim the input is unparseable.
  it('shows a neutral parsing row, not "No date found", while chrono loads', async () => {
    renderPicker(null)
    const input = container.querySelector('input')!
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!
      setter.call(input, 'at 4 pm')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      // Deliberately NOT flushing the async parse — this is the in-flight frame.
    })
    expect(container.textContent).toContain('Parsing')
    expect(container.textContent).not.toContain('No date found')
    // Let the pending parse settle so the unmount in afterEach is quiet.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
  })

  // Finding 7: the list row's context menu passes no `existing` prop, so the
  // picker has to find out for itself or Remove can never appear from a list.
  it('fetches its own reminder when `existing` is undefined, so Remove appears', async () => {
    fetchReminder.mockResolvedValueOnce(makeReminder())
    renderPicker(undefined)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(fetchReminder).toHaveBeenCalledWith('action', 'act-1')
    expect(container.textContent).toContain('Remove reminder')
    expect(items().length).toBe(6)
  })

  it('does not fetch when the caller already said there is no reminder', () => {
    renderPicker(null)
    expect(fetchReminder).not.toHaveBeenCalled()
    expect(container.textContent).not.toContain('Remove reminder')
  })

  it('does not fetch when the caller supplied the reminder', () => {
    renderPicker(makeReminder())
    expect(fetchReminder).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Remove reminder')
  })

  // Finding 12: presets resolve at mount but the row context menu can sit open
  // indefinitely, so the saved instant must be re-derived from the preset id
  // against a fresh clock rather than replayed from the rendered `p.date`.
  it('re-resolves a preset against the clock at select time, not mount time', async () => {
    vi.useFakeTimers()
    try {
      const mountedAt = Date.now()
      renderPicker(null)
      // Sit on the open menu long enough that the mount-time instant is stale.
      await act(async () => {
        vi.advanceTimersByTime(20 * 60_000)
      })
      const hour = items().find((el) => el.textContent?.includes('An hour from now'))!
      await act(async () => {
        hour.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
      const [, , date] = setReminder.mock.calls[0] as unknown as [string, string, Date]
      // now + 1h measured from the CLICK, i.e. ~20 min past the mount-time value.
      expect(date.getTime()).toBeGreaterThan(mountedAt + 79 * 60_000)
    } finally {
      vi.useRealTimers()
    }
  })

  it('re-parses free text at select time so a stale instant is never posted', async () => {
    vi.useFakeTimers()
    try {
      renderPicker(null)
      await type('at 4 pm')
      expect(items().length).toBe(1)
      // The rendered row froze `now + 3h`. Wander off for four hours.
      await act(async () => {
        vi.advanceTimersByTime(4 * 3600_000)
      })
      await act(async () => {
        items()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
        await Promise.resolve()
      })
      const [, , date] = setReminder.mock.calls[0] as unknown as [string, string, Date]
      // Re-parsed against the click, not replayed from the render — and in
      // every case strictly in the future, which is all the server accepts.
      expect(date.getTime()).toBeGreaterThan(Date.now())
    } finally {
      vi.useRealTimers()
    }
  })

  it('parses text that resolves into the past as no date at all', async () => {
    renderPicker(null)
    await type('an hour ago')
    expect(container.textContent).toContain('No date found')
    expect(items().length).toBe(0)
  })
})
