// @vitest-environment jsdom
/**
 * The Create dialog's types beyond its six forms (Liam, 11-20: "it supports
 * every kind of thing the app can create now"): picked from the grouped,
 * searchable list; a quick type is made through its feature's own route and
 * opened; a type that needs its own page opens that page's create flow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act, createElement as h } from 'react'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { openTarget, openCard } = vi.hoisted(() => ({ openTarget: vi.fn((..._a: unknown[]) => true), openCard: vi.fn((..._a: unknown[]) => true) }))
vi.mock('@/app/account/teams-context', () => ({ useTeams: () => ({ teams: [] }) }))
vi.mock('@/lib/labels/use-scoped-labels', () => ({ useScopedLabels: () => ({ labels: [] }) }))
vi.mock('@/lib/chat-cards/open-card', () => ({ openTarget, openCard }))
vi.mock('@/calendar/hooks/use-calendar-events', () => ({ patchCalendarEventsCache: vi.fn() }))
vi.mock('@/calendar/adapters', () => ({ calendarEventToIEvent: vi.fn() }))
vi.mock('@/components/email/email-recipient-input', () => ({ EmailRecipientInput: () => null }))
vi.mock('@/components/ui/datetime-picker', () => ({ DateTimePicker: () => null }))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn() }) }))

import { CreateDialog } from '../create-dialog'
import { __resetPageCreateForTests, takePageCreate } from '@/lib/create/page-create'

let container: HTMLDivElement
let root: Root | null = null
const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
  if (url === '/api/account/companies' && _init?.method === 'POST') return new Response(JSON.stringify({ company: { id: 'co-1', name: 'Northwind Test' } }), { status: 201 })
  return new Response('{}', { status: 200 })
})

beforeEach(() => {
  __resetPageCreateForTests()
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

async function openAndList() {
  await act(async () => void document.dispatchEvent(new CustomEvent('open-create', { detail: { type: 'action' } })))
  await act(async () => q('[data-create-type-trigger]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

async function pick(id: string) {
  const item = q(`[data-create-type="${id}"]`)!
  expect(item, id).not.toBeNull()
  await act(async () => item.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('CreateDialog types', () => {
  it('lists every type, grouped, with a search field', async () => {
    await openAndList()
    const list = q('[data-create-type-list]')!
    expect(list.querySelector('input')).not.toBeNull()
    const ids = Array.from(list.querySelectorAll<HTMLElement>('[data-create-type]')).map((el) => el.dataset.createType)
    expect(ids).toEqual(expect.arrayContaining(['action', 'project', 'initiative', 'contact', 'email', 'event', 'company', 'document', 'table', 'deal', 'agent', 'skill', 'flow', 'sequence', 'campaign', 'prospect_list', 'booking_link', 'channel', 'package', 'studio_project', 'studio_video']))
    const headings = Array.from(list.querySelectorAll('[cmdk-group-heading]')).map((el) => el.textContent)
    expect(headings).toEqual(['Work', 'Customers', 'Outreach', 'Agents', 'Team'])
  })

  it('makes a company through its own route, then opens it', async () => {
    await openAndList()
    await pick('company')
    expect(q('[data-create-type-trigger]')!.textContent).toContain('New company')
    await act(async () => setValue(q<HTMLInputElement>('input[placeholder="Company name"]')!, 'Northwind Test'))
    await act(async () => setValue(q<HTMLInputElement>('[data-create-secondary]')!, 'northwind.example'))
    const create = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === 'Create company')!
    await act(async () => create.click())
    const post = fetchMock.mock.calls.find(([url, init]) => url === '/api/account/companies' && init?.method === 'POST')!
    expect(JSON.parse(post[1]!.body as string)).toEqual({ name: 'Northwind Test', domain: 'northwind.example' })
    expect(openTarget).toHaveBeenCalledWith({ type: 'company', id: 'co-1', title: 'Northwind Test' }, { from: 'create' })
    expect(q('[data-create-dialog]')).toBeNull()
  })

  it('opens a multi-step type’s own page on its create flow, and steps aside', async () => {
    await openAndList()
    await pick('agent')
    expect(openTarget).toHaveBeenCalledWith({ type: 'page', slug: 'agents' }, { from: 'create' })
    expect(takePageCreate('agent')).toBe(true)
    expect(q('[data-create-dialog]')).toBeNull()
  })

  it('opens a new flow in the flows card’s editor, as its New flow does', async () => {
    await openAndList()
    await pick('flow')
    expect(openCard).toHaveBeenCalledWith({ kind: 'flows', title: 'Flows' }, { from: 'create', seed: { editing: '__new__' } })
  })
})
