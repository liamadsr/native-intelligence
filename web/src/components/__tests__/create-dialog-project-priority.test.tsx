// @vitest-environment jsdom
/**
 * A project's Priority chip in the Create composer (migration 691;
 * docs/plans/create-everything.md, decision 6): the actions' pill and values,
 * sent with the new project. The REAL dialog; fetch is stubbed.
 *
 * Radix's popover, inside the modal dialog, closes itself under jsdom (the
 * dialog's focus trap pulls focus back out of it), so here a pill's popover is
 * always open: its content renders beside its trigger.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h, type ReactNode } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: ReactNode }) => h('div', { 'data-popover': '' }, children),
  PopoverTrigger: ({ children }: { children: ReactNode }) => children,
  PopoverAnchor: ({ children }: { children: ReactNode }) => children,
  PopoverContent: ({ children }: { children: ReactNode }) => h('div', { 'data-popover-content': '' }, children),
}))
vi.mock('@/app/account/teams-context', () => ({ useTeams: () => ({ teams: [] }) }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({ useScopedLabels: () => ({ labels: [] }) }))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget: vi.fn(() => true), openCard: vi.fn(() => true) }))
vi.mock('@/calendar/hooks/use-calendar-events', () => ({ patchCalendarEventsCache: vi.fn() }))
vi.mock('@/calendar/adapters', () => ({ calendarEventToIEvent: vi.fn() }))
vi.mock('@/components/email/email-recipient-input', () => ({ EmailRecipientInput: () => null }))
vi.mock('@/components/ui/datetime-picker', () => ({ DateTimePicker: () => null }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

import { CreateDialog } from '../create-dialog'

let container: HTMLDivElement
let root: Root | null = null
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/api/account/projects' && init?.method === 'POST') return new Response(JSON.stringify({ project: { id: 'p-1', name: 'x' } }), { status: 201 })
  return new Response('{}', { status: 200 })
})
const projectPosts = () =>
  fetchMock.mock.calls.filter(([url, init]) => url === '/api/account/projects' && init?.method === 'POST').map(([, init]) => JSON.parse(String(init!.body)))

beforeEach(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver
  Element.prototype.scrollIntoView ??= function () {}
  vi.stubGlobal('fetch', fetchMock)
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
  vi.clearAllMocks()
})

const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))
const titleInput = () => q<HTMLInputElement>('[data-create-dialog] input[placeholder="Project name"]')!
function setValue(el: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const enter = () => act(async () => void titleInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
const open = () => act(async () => void document.dispatchEvent(new CustomEvent('open-create', { detail: { type: 'project' } })))

/** The Priority pill's options: the pill whose trigger reads "Priority" (or a value) and lists the five. */
function priorityOption(label: string): HTMLElement | undefined {
  const popover = Array.from(document.body.querySelectorAll<HTMLElement>('[data-create-dialog] [data-popover]')).find((p) =>
    p.querySelector('input[placeholder="Set priority..."]'),
  )
  return Array.from(popover?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? []).find((el) => el.textContent?.trim() === label)
}

describe('a project’s priority in the composer (migration 691)', () => {
  it('the Priority chip lists the five values, and the project is made with the one picked', async () => {
    await open()
    await flush()
    expect(['None', 'Urgent', 'High', 'Medium', 'Low'].every((l) => priorityOption(l))).toBe(true)
    await act(async () => priorityOption('High')!.click())
    await act(async () => setValue(titleInput(), 'Website relaunch'))
    await enter()
    await flush()
    expect(projectPosts()).toEqual([expect.objectContaining({ name: 'Website relaunch', priority: 'high' })])
  })

  it('none set sends no priority', async () => {
    await open()
    await act(async () => setValue(titleInput(), 'Plain project'))
    await enter()
    await flush()
    expect(projectPosts()).toHaveLength(1)
    expect(projectPosts()[0].priority).toBeUndefined()
  })
})
