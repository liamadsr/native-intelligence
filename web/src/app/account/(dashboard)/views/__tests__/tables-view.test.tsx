// @vitest-environment jsdom
/**
 * The Tables page (phase 1): the list, making a table, and one table open as
 * its grid (phase 3) with its History and Undo. Fetch is stubbed. The list is
 * the views system's (docs/plans/views-everywhere.md), stubbed here: the page
 * mounts it on `data_table` (the Deals page pinned to pipelines) and opens the
 * row it picks; the shared layout's own tests cover the list.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

const listed: Array<Record<string, unknown>> = []
vi.mock('@/components/views/unified-view-layout', () => ({
  UnifiedViewLayout: (props: { entityType: string; scopeFilters?: unknown; onItemSelect: (id: string, title: string) => void }) => {
    listed.push(props as unknown as Record<string, unknown>)
    return <button type="button" data-stub-row="" onClick={() => props.onItemSelect('33333333-3333-4333-8333-333333333333', 'Fernhill orders')}>Fernhill orders</button>
  },
}))

import { TablesView } from '../tables-view'
import { CardHeaderSlotsProvider, type CardHeaderBack } from '@/components/chat-cards/card-header-slot'
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
  listed.length = 0
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
  await act(async () => root.render(<TablesView />))
  await flush()
  // The views list of tables, every kind (no pin).
  expect(listed.at(-1)).toMatchObject({ entityType: 'data_table', scopeFilters: undefined })
  expect(container.querySelector('[data-table-list]')).not.toBeNull()

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

it('the Deals page lists the pipelines only, a pin the person can’t take off', async () => {
  await act(async () => root.render(<TablesView pipelines />))
  await flush()
  expect(listed.at(-1)).toMatchObject({ entityType: 'data_table', scopeFilters: [{ field: 'table_kind', operator: 'is', value: 'pipeline' }] })
  expect(button('New pipeline')).toBeDefined()
})

it('New table opens the Create composer on Table', async () => {
  const asked: unknown[] = []
  const onAsk = (e: Event) => asked.push((e as CustomEvent).detail)
  document.addEventListener('open-create', onAsk)
  await act(async () => root.render(<TablesView />))
  await flush()
  await act(async () => button('New table').click())
  document.removeEventListener('open-create', onAsk)
  expect(asked).toEqual([{ type: 'table' }])
  expect(calls.some((c) => c.init?.method === 'POST')).toBe(false)
})

it('in a card: New table, then the table’s breadcrumb and its actions are the card header’s, no title row in the page (Liam, 11-22)', async () => {
  const right = document.createElement('div')
  const trail = document.createElement('div')
  document.body.append(right, trail)
  let back: CardHeaderBack | null = null
  const slots = { left: null, right, trail, setBack: (b: CardHeaderBack | null) => (back = b) }
  await act(async () => root.render(<CardHeaderSlotsProvider value={slots}><TablesView /></CardHeaderSlotsProvider>))
  await flush()
  expect(right.querySelector('[data-new-table]')?.textContent).toBe('New table')
  expect(container.querySelector('h1')).toBeNull()
  expect(button('New table')).toBeUndefined()

  await act(async () => button('Fernhill orders').click())
  await flush()
  // "Tables › Fernhill orders": the card's title is the way back, no back arrow in the page.
  expect(trail.querySelector('[data-table-crumb]')?.textContent).toContain('Fernhill orders')
  expect(back!.label).toBe('Back to tables')
  expect(container.querySelector('[aria-label="All tables"]')).toBeNull()
  const actions = [...right.querySelectorAll('[data-table-actions] button')].map((b) => b.getAttribute('aria-label'))
  expect(actions).toEqual(['Import', 'Form', 'Copy link', 'Export', 'History'])
  expect(container.querySelector('[role="grid"], [role="columnheader"]')).not.toBeNull()

  await act(async () => back!.go())
  await flush()
  expect(right.querySelector('[data-new-table]')).not.toBeNull()
  expect(trail.childElementCount).toBe(0)
  right.remove()
  trail.remove()
})
