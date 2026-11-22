// @vitest-environment jsdom
/**
 * The one Create flow (owner, 11-22: "match the macro experience";
 * docs/plans/create-everything.md): C then a letter goes straight to a type,
 * ↵ creates and opens, ⌘↵ creates and keeps the composer for another, a
 * place gives what is made its link ("Create in <name>"), a table's starters
 * are a choice in the composer, and a task from an email links back to it.
 * The REAL dialog; fetch is stubbed. Made-up records.
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
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

import { CreateDialog } from '../create-dialog'

const PROJECT = '11111111-1111-4111-8111-111111111111'
const COMPANY = '22222222-2222-4222-8222-222222222222'
const THREAD = '33333333-3333-4333-8333-333333333333'

let container: HTMLDivElement
let root: Root | null = null
let made = 0
const posts = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').map(([url, init]) => ({ url, body: JSON.parse(String(init!.body)) }))
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === '/api/account/actions' && init?.method === 'POST') {
    made += 1
    return new Response(JSON.stringify({ action: { id: `a-${made}`, identifier: `ENG-${made}`, title: 'x' } }), { status: 200 })
  }
  if (url === '/api/account/tables' && init?.method === 'POST') return new Response(JSON.stringify({ table: { id: 't-1', name: 'Pipeline' } }), { status: 201 })
  if (url === '/api/account/contacts' && init?.method === 'POST') return new Response(JSON.stringify({ contact: { id: 'ct-1', full_name: 'Rosa Lind' } }), { status: 201 })
  return new Response('{}', { status: 200 })
})

beforeEach(() => {
  made = 0
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
  vi.restoreAllMocks()
})

const q = <T extends Element = HTMLElement>(sel: string) => document.body.querySelector<T>(sel)
const typeLabel = () => q('[data-create-type-trigger]')?.textContent ?? ''
const flush = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))))
const key = (target: EventTarget, k: string, init: KeyboardEventInit = {}) =>
  act(async () => void target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })))

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}
const titleInput = () => q<HTMLInputElement>('[data-create-dialog] input[placeholder]')!
const open = (detail: unknown) => act(async () => void document.dispatchEvent(new CustomEvent('open-create', { detail })))

describe('the Create menu', () => {
  it('C then A goes straight to the action composer', async () => {
    await key(document.body, 'c')
    const search = q<HTMLInputElement>('[data-create-menu-search]')!
    expect(search).not.toBeNull()
    await key(search, 'a')
    expect(q('[data-create-menu]')).toBeNull()
    expect(typeLabel()).toContain('New action')
  })

  it('shows each type’s letter, and after the first moment letters filter instead', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(10_000)
    await key(document.body, 'c')
    expect(q('[data-create-menu-type="document"] kbd')!.textContent).toBe('D')
    now.mockReturnValue(20_000)
    const search = q<HTMLInputElement>('[data-create-menu-search]')!
    await key(search, 'd')
    expect(q('[data-create-menu]')).not.toBeNull()
  })

  it('picks a type by click', async () => {
    await key(document.body, 'c')
    await act(async () => q('[data-create-menu-type="project"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(typeLabel()).toContain('New project')
  })
})

describe('a composer’s keys', () => {
  it('↵ in the title creates the action and opens it, and the composer closes', async () => {
    await open({ type: 'action' })
    await act(async () => setValue(titleInput(), 'Call the venue'))
    await key(titleInput(), 'Enter')
    await flush()
    expect(posts()).toEqual([{ url: '/api/account/actions', body: expect.objectContaining({ title: 'Call the venue' }) }])
    expect(openTarget).toHaveBeenCalledWith({ type: 'action', id: 'a-1', title: 'ENG-1' }, { from: 'create' })
    expect(q('[data-create-dialog]')).toBeNull()
  })

  it('⌘↵ creates it and keeps the composer for another, the title cleared', async () => {
    await open({ type: 'action' })
    await act(async () => setValue(titleInput(), 'First one'))
    await key(titleInput(), 'Enter', { metaKey: true })
    await flush()
    expect(posts()).toHaveLength(1)
    expect(openTarget).not.toHaveBeenCalled()
    expect(q('[data-create-dialog]')).not.toBeNull()
    expect(titleInput().value).toBe('')
    await act(async () => setValue(titleInput(), 'Second one'))
    await key(titleInput(), 'Enter', { ctrlKey: true })
    await flush()
    expect(posts().map((p) => p.body.title)).toEqual(['First one', 'Second one'])
  })

  it('Esc cancels: nothing is made', async () => {
    await open({ type: 'action' })
    await act(async () => setValue(titleInput(), 'Never mind'))
    await key(titleInput(), 'Escape')
    expect(q('[data-create-dialog]')).toBeNull()
    expect(posts()).toEqual([])
  })
})

describe('where it was opened', () => {
  it('in a project: "Create in <project>", and the action belongs to it', async () => {
    await open({ type: 'action', context: { container: { kind: 'project', id: PROJECT, name: 'Website relaunch' } } })
    expect(q('[data-create-container="project"]')!.textContent).toContain('Create in Website relaunch')
    await act(async () => setValue(titleInput(), 'Draft the brief'))
    await key(titleInput(), 'Enter')
    await flush()
    expect(posts()[0].body).toMatchObject({ title: 'Draft the brief', project_id: PROJECT })
  })

  it('on a company: an action is about it; × makes it without', async () => {
    await open({ type: 'action', context: { container: { kind: 'company', id: COMPANY, name: 'Acme Test Co' } } })
    await act(async () => setValue(titleInput(), 'Send the quote'))
    await key(titleInput(), 'Enter')
    await flush()
    expect(posts()[0].body).toMatchObject({ about: { type: 'company', id: COMPANY } })

    await open({ type: 'action', context: { container: { kind: 'company', id: COMPANY, name: 'Acme Test Co' } } })
    await act(async () => q('[data-create-container] button')!.click())
    expect(q('[data-create-container]')).toBeNull()
    await act(async () => setValue(titleInput(), 'Unlinked'))
    await key(titleInput(), 'Enter')
    await flush()
    expect(posts()[1].body.about).toBeUndefined()
  })

  it('a task from an email: titled from it, linked back to it', async () => {
    await open({ type: 'action', context: { source: { type: 'email_thread', id: THREAD, title: 'Follow up: Contract redlines' } } })
    expect(titleInput().value).toBe('Follow up: Contract redlines')
    await key(titleInput(), 'Enter')
    await flush()
    expect(posts()[0].body).toMatchObject({ title: 'Follow up: Contract redlines', about: { type: 'email_thread', id: THREAD } })
  })
})

describe('a table’s starters, in the composer', () => {
  it('offers Blank and the starters; a starter may go unnamed', async () => {
    await open({ type: 'table' })
    const chips = Array.from(document.body.querySelectorAll<HTMLElement>('[data-create-templates] [data-template]')).map((b) => b.dataset.template)
    expect(chips[0]).toBe('blank')
    expect(chips).toEqual(expect.arrayContaining(['list', 'pipeline', 'inventory', 'jobs', 'contacts', 'quotes']))
    await act(async () => q('[data-template="pipeline"]')!.click())
    expect(q('[data-template="pipeline"]')!.getAttribute('aria-pressed')).toBe('true')
    await key(titleInput(), 'Enter')
    await flush()
    expect(posts()).toEqual([{ url: '/api/account/tables', body: { template: 'pipeline' } }])
    expect(openCard).toHaveBeenCalledWith({ kind: 'tables', title: 'Tables', target: { type: 'data_table', id: 't-1', label: 'Pipeline' } }, { from: 'create' })
  })
})

describe('from a list group’s +', () => {
  it('the action starts on the group’s project and priority', async () => {
    await open({ type: 'action', context: { preset: { projectId: PROJECT, priority: 'high' } } })
    await act(async () => setValue(titleInput(), 'In the group'))
    await key(titleInput(), 'Enter')
    await flush()
    expect(posts()[0].body).toMatchObject({ title: 'In the group', project_id: PROJECT, priority: 'high' })
  })
})
