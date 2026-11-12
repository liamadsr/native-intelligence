// @vitest-environment jsdom
/**
 * The Tables page (phase 1): the list, making a table, and one table open as
 * its grid (phase 3) with its History and Undo. Fetch is stubbed.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { TablesView } from '../tables-view'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom lays nothing out: give the grid's scroller a size so its rows render.
const saved: Record<string, PropertyDescriptor | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries({ offsetWidth: 1200, offsetHeight: 600 })) {
    saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v })
  }
  HTMLElement.prototype.scrollTo = function () {} as never
})
afterAll(() => {
  for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(HTMLElement.prototype, k, d)
})

const T = '33333333-3333-4333-8333-333333333333'
const table = { id: T, workspace_id: 'ws', name: 'Fernhill orders', icon: null, description: null, owner_member_id: 'm', visibility: 'workspace', version: 2, position: 0, archived_at: null, created_at: '2026-11-10T10:00:00Z', updated_at: '2026-11-10T10:00:00Z' }
const columns = [{ id: 'c', table_id: T, key: 'status', label: 'Status', field_type: 'select', options: ['Todo', 'Done'], position: 0, deleted_at: null }]
const rows = [{ id: 'r1', table_id: T, title: 'Order 1', custom_fields: { status: 'Done' }, position: 1, archived_at: null, created_at: '', updated_at: '' }]
const changes = [
  { id: 'ch2', table_id: T, version: 2, source: 'person', reason: null, changes: [{ op: 'update_row', row_id: 'r1', fields: {} }], undo_of: null, undone_at: null, created_at: '2026-11-10T10:05:00Z' },
  { id: 'ch1', table_id: T, version: 1, source: 'person', reason: null, changes: [{ op: 'create_table' }], undo_of: null, undone_at: null, created_at: '2026-11-10T10:00:00Z' },
]

const calls: Array<{ url: string; init?: RequestInit }> = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** What the table read says about the reader (520's data_table_editable_by). */
let canEdit = true
let container: HTMLDivElement
let root: Root
beforeEach(() => {
  calls.length = 0
  canEdit = true
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === '/api/account/tables' && init?.method === 'POST') return json({ table: { ...table, id: 'new', name: 'Hires' } }, 201)
    if (url === '/api/account/tables') return json({ tables: [table] })
    if (url.endsWith('/undo')) return json({ kept: [] })
    if (url.includes('/rows')) return json({ rows, has_more: false })
    if (url.includes('/changes')) return json({ changes })
    return json({ table: { ...table, columns, can_edit: canEdit } })
  }))
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const button = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text))!

it('lists the tables and opens one: its columns, its rows, its history with Undo where it can be taken back', async () => {
  const counts: number[] = []
  await act(async () => root.render(<TablesView onCount={(n) => counts.push(n)} />))
  await flush()
  expect(container.textContent).toContain('Fernhill orders')
  expect(counts.at(-1)).toBe(1)

  await act(async () => button('Fernhill orders').click())
  await flush()
  const heads = [...container.querySelectorAll('[role="columnheader"]')].map((h) => h.getAttribute('aria-label'))
  expect(heads).toEqual(['Name', 'Status'])
  const cells = [...container.querySelectorAll('[role="gridcell"]')].map((td) => td.textContent)
  expect(cells[0]).toContain('Order 1')
  expect(cells[1]).toBe('Done')

  await act(async () => button('History').click())
  await flush()
  const history = () => document.body.textContent ?? ''
  expect(history()).toContain('Edited 1 row')
  expect(history()).toContain('Made the table')
  // The batch that made the table has no Undo; the edit does.
  const undoButtons = () => [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Undo')
  expect(undoButtons()).toHaveLength(1)

  await act(async () => undoButtons()[0].click())
  await flush()
  const undo = calls.find((c) => c.url.endsWith('/undo'))!
  expect(JSON.parse(String(undo.init?.body))).toEqual({ change_id: 'ch2' })
})

it('shows no Undo to a reader who can’t change the table', async () => {
  canEdit = false
  await act(async () => root.render(<TablesView />))
  await flush()
  await act(async () => button('Fernhill orders').click())
  await flush()
  expect(container.textContent).toContain('View only')
  await act(async () => button('History').click())
  await flush()
  expect(document.body.textContent).toContain('Edited 1 row')
  expect([...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Undo')).toHaveLength(0)
})

it('makes a table by name and opens it', async () => {
  await act(async () => root.render(<TablesView />))
  await flush()
  await act(async () => button('New table').click())
  const input = container.querySelector<HTMLInputElement>('input[aria-label="Table name"]')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(input, 'Hires')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Make table').click())
  await flush()
  const post = calls.find((c) => c.init?.method === 'POST')!
  expect(JSON.parse(String(post.init?.body))).toEqual({ name: 'Hires' })
  expect(calls.some((c) => c.url === '/api/account/tables/new')).toBe(true)
})
