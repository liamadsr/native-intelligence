// @vitest-environment jsdom
/**
 * ViewRoadmap in the DOM: grouped bands that collapse, a bar per dated row,
 * a drag that reschedules through `onPatch` with an Undo on the toast, a click
 * that opens, and a dateless row scheduled by a click on its timeline.
 *
 * The virtualizer is replaced with one that draws every row (jsdom has no
 * layout to measure), and the row helpers with a plain title.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'
import { PX_PER_DAY } from '@/lib/views/roadmap'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number; estimateSize: () => number; paddingStart?: number }) => ({
    getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({
      index, key: index, start: (opts.paddingStart ?? 0) + index * opts.estimateSize(), size: opts.estimateSize(),
    })),
    getTotalSize: () => (opts.paddingStart ?? 0) + opts.count * opts.estimateSize(),
  }),
}))

vi.mock('../list/entity-row', () => ({
  getTitle: (_t: string, item: Record<string, unknown>) => (item.name ?? item.title ?? '') as string,
}))

const toastCalls: Array<{ message: string; action?: { label: string; onClick: () => void } }> = []
vi.mock('sonner', () => ({
  toast: Object.assign(
    (message: string, opts?: { action?: { label: string; onClick: () => void } }) => { toastCalls.push({ message, action: opts?.action }) },
    { error: vi.fn(), success: vi.fn() },
  ),
}))

import { ViewRoadmap } from '../view-roadmap'

const TODAY = new Date(2026, 10, 22)

const projects = [
  { id: 'p1', name: 'Harbor launch', priority: 'high', start_date: '2026-11-02', target_date: '2026-11-13', icon: null },
  { id: 'p2', name: 'Pricing page', priority: 'high', start_date: null, target_date: null, icon: null },
  { id: 'p3', name: 'Field guide', priority: 'low', start_date: '2026-12-01', target_date: '2026-12-20', icon: null },
]

const baseConfig = {
  layout: 'roadmap', filters: [], grouping: null, sub_grouping: null, ordering: [], display_properties: [],
} as unknown as Parameters<typeof ViewRoadmap>[0]['config']

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  toastCalls.length = 0
  try { window.localStorage.clear() } catch { /* */ }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // jsdom has no scrolling; the roadmap asks for it on open.
  Element.prototype.scrollTo = function () {} as typeof Element.prototype.scrollTo
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(props: Partial<Parameters<typeof ViewRoadmap>[0]>) {
  const onPatch = vi.fn()
  const onItemSelect = vi.fn()
  act(() => {
    root.render(h(ViewRoadmap, {
      entityType: 'project',
      data: projects,
      loading: false,
      config: baseConfig,
      selectedItemId: null,
      onItemSelect,
      onPatch,
      today: TODAY,
      ...props,
    }))
  })
  return { onPatch, onItemSelect }
}

function pointer(el: Element, type: string, clientX: number) {
  const ev = new MouseEvent(type, { bubbles: true, clientX, button: 0 }) as MouseEvent & { pointerId: number }
  Object.defineProperty(ev, 'pointerId', { value: 1 })
  act(() => { el.dispatchEvent(ev) })
}

describe('ViewRoadmap', () => {
  it('draws a bar for each dated row and lists the dateless one', () => {
    render({})
    expect(container.querySelector('[data-roadmap-bar="p1"]')).not.toBeNull()
    expect(container.querySelector('[data-roadmap-bar="p3"]')).not.toBeNull()
    expect(container.querySelector('[data-roadmap-bar="p2"]')).toBeNull()
    expect(container.querySelector('[data-roadmap-item="p2"]')?.textContent).toContain('No date')
    expect(container.querySelector('[data-roadmap-today]')).not.toBeNull()
  })

  it('bar width is its days at the zoom', () => {
    render({})
    const bar = container.querySelector('[data-roadmap-bar="p1"]') as HTMLElement
    expect(bar.style.width).toBe(`${12 * PX_PER_DAY.month}px`)
  })

  it('dragging a bar moves both dates, and Undo puts them back', () => {
    const { onPatch, onItemSelect } = render({})
    const bar = container.querySelector('[data-roadmap-bar="p1"]')!
    pointer(bar, 'pointerdown', 100)
    pointer(bar, 'pointermove', 100 + 3 * PX_PER_DAY.month)
    pointer(bar, 'pointerup', 100 + 3 * PX_PER_DAY.month)
    expect(onItemSelect).not.toHaveBeenCalled()
    expect(onPatch).toHaveBeenCalledWith('p1', { start_date: '2026-11-05', target_date: '2026-11-16' })
    expect(toastCalls.at(-1)?.action?.label).toBe('Undo')
    act(() => toastCalls.at(-1)!.action!.onClick())
    expect(onPatch).toHaveBeenLastCalledWith('p1', { start_date: '2026-11-02', target_date: '2026-11-13' })
  })

  it('dragging the end handle changes only the target date', () => {
    const { onPatch } = render({})
    const handle = container.querySelector('[data-roadmap-bar="p1"] [data-roadmap-handle="end"]')!
    pointer(handle, 'pointerdown', 200)
    pointer(handle, 'pointermove', 200 + 5 * PX_PER_DAY.month)
    pointer(handle, 'pointerup', 200 + 5 * PX_PER_DAY.month)
    expect(onPatch).toHaveBeenCalledWith('p1', { target_date: '2026-11-18' })
  })

  it('a press without movement opens the item', () => {
    const { onPatch, onItemSelect } = render({})
    const bar = container.querySelector('[data-roadmap-bar="p3"]')!
    pointer(bar, 'pointerdown', 50)
    pointer(bar, 'pointerup', 51)
    expect(onPatch).not.toHaveBeenCalled()
    expect(onItemSelect.mock.calls[0][0]).toBe('p3')
  })

  it('a read-only row neither drags nor schedules', () => {
    const { onPatch } = render({ canEdit: () => false })
    const bar = container.querySelector('[data-roadmap-bar="p1"]')!
    pointer(bar, 'pointerdown', 100)
    pointer(bar, 'pointermove', 160)
    pointer(bar, 'pointerup', 160)
    expect(onPatch).not.toHaveBeenCalled()
  })

  it('a click on a dateless row’s timeline schedules it there', () => {
    const { onPatch } = render({})
    const cell = container.querySelector('[data-roadmap-timeline="p2"]') as HTMLElement
    cell.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON() {} })
    act(() => { cell.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 0 })) })
    // The timeline's first day: a month before three months before today.
    expect(onPatch).toHaveBeenCalledWith('p2', { start_date: '2026-07-01', target_date: '2026-07-14' })
  })

  it('groups draw as bands with counts, and collapse', () => {
    render({
      config: { ...baseConfig, grouping: { field: 'priority', direction: 'asc' } },
      data: [
        { key: 'high', label: 'High', items: [projects[0], projects[1]] },
        { key: 'low', label: 'Low', items: [projects[2]] },
      ],
    })
    const high = container.querySelector('[data-roadmap-group="high"]')!
    expect(high.textContent).toContain('High')
    expect(high.textContent).toContain('2')
    expect(container.querySelector('[data-roadmap-item="p1"]')).not.toBeNull()
    act(() => { (high.querySelector('button') as HTMLButtonElement).click() })
    expect(container.querySelector('[data-roadmap-item="p1"]')).toBeNull()
    expect(container.querySelector('[data-roadmap-item="p3"]')).not.toBeNull()
  })

  it('an action is a marker that moves its due date', () => {
    const due = new Date(2026, 10, 24, 9, 30).toISOString()
    const { onPatch } = render({
      entityType: 'action',
      data: [{ id: 'a1', title: 'Send the deck', identifier: 'GEN-7', due_at: due, workflow_state: { category: 'started', color: '#f59e0b' } }],
    })
    const marker = container.querySelector('[data-roadmap-marker="a1"]')!
    pointer(marker, 'pointerdown', 10)
    pointer(marker, 'pointermove', 10 - 2 * PX_PER_DAY.month)
    pointer(marker, 'pointerup', 10 - 2 * PX_PER_DAY.month)
    const patch = onPatch.mock.calls[0][1] as { due_at: string }
    const moved = new Date(patch.due_at)
    expect([moved.getFullYear(), moved.getMonth(), moved.getDate(), moved.getHours(), moved.getMinutes()]).toEqual([2026, 10, 22, 9, 30])
  })

  it('in a card, Today and the zoom go to the header spot it is given, the zoom named (Liam, 11-23: "lets move this today and view options into the header section")', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    try {
      window.localStorage.setItem('ni:roadmap-zoom', 'day')
      render({ headerHost: host })
      expect(host.querySelector('[data-roadmap-today-button]')!.textContent).toBe('Today')
      expect(host.querySelector('[data-roadmap-settings]')!.textContent).toBe('Day')
      expect(host.querySelector('[data-roadmap-settings]')!.className).toContain('h-6')
      // Nothing floats over the axis then.
      expect(container.querySelector('[data-roadmap-today-button]')).toBeNull()
      // The day zoom: a day as wide as its weekday needs.
      expect((container.querySelector('[data-roadmap-bar="p1"]') as HTMLElement).style.width).toBe(`${12 * PX_PER_DAY.day}px`)
    } finally {
      host.remove()
    }
  })

  it('on its own, Today and the settings float over the axis', () => {
    render({})
    expect(container.querySelector('[data-roadmap-today-button]')).not.toBeNull()
    expect(container.querySelector('[data-roadmap-settings]')!.getAttribute('aria-label')).toBe('Roadmap settings')
  })

  it('switching zoom rescales the bars and is remembered', () => {
    render({})
    const bar = () => container.querySelector('[data-roadmap-bar="p1"]') as HTMLElement
    expect(bar().style.width).toBe(`${12 * PX_PER_DAY.month}px`)
    // Opening the popover in jsdom is Radix's business; the stored zoom is read on mount.
    act(() => root.unmount())
    window.localStorage.setItem('ni:roadmap-zoom', 'week')
    root = createRoot(container)
    render({})
    expect(bar().style.width).toBe(`${12 * PX_PER_DAY.week}px`)
  })
})
