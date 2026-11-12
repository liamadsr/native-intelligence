// @vitest-environment jsdom
/**
 * Formula and rollup columns in the grid (Tables, phase 6): their cells read
 * as their result's type, read-only; a cell's error and a column's error
 * show; an edit works the row's formulas out again at once; a paste never
 * writes into one. Fetch is stubbed; names are made up.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { TableDetail } from '../table-detail'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))

const T = '33333333-3333-4333-8333-333333333333'
const R1 = '11111111-1111-4111-8111-111111111111'
const R2 = '22222222-2222-4222-8222-222222222222'

const column = (key: string, label: string, field_type: string, extra: Record<string, unknown> = {}, position = 0) => ({ id: `c-${key}`, table_id: T, key, label, field_type, options: [], config: {}, position, deleted_at: null, ...extra })
const COLUMNS = [
  column('qty', 'Qty', 'number', {}, 0),
  column('price', 'Price', 'number', {}, 1),
  column('total', 'Total', 'formula', { config: { expression: '{#qty} * {#price}' }, computed: { result: 'number' } }, 2),
  column('orders', 'Orders', 'relation', { config: { target: { kind: 'deal' }, multiple: true } }, 3),
  column('n', 'Order count', 'rollup', { config: { relation: 'orders', fn: 'count', field: null }, computed: { result: 'number' } }, 4),
  column('broken', 'Broken', 'formula', { config: { expression: '{#gone}' }, computed: { result: null, error: 'No column named {gone}.' } }, 5),
]
const TABLE = { id: T, workspace_id: 'ws', name: 'Fernhill orders', icon: null, description: null, owner_member_id: 'm', visibility: 'workspace', version: 4, position: 0, archived_at: null, created_at: '', updated_at: '' }
const ROWS = [
  { id: R1, table_id: T, title: 'Oak table', custom_fields: { qty: 2, price: 50 }, computed: { total: { value: 100 }, n: { value: 3 } }, position: 1, archived_at: null, created_at: '', updated_at: '' },
  { id: R2, table_id: T, title: 'Linen set', custom_fields: { qty: 1 }, computed: { total: { error: 'Division by zero.' }, n: { value: 0 } }, position: 2, archived_at: null, created_at: '', updated_at: '' },
]

const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const sizes = { offsetWidth: 1600, offsetHeight: 600 }
const saved: Record<string, PropertyDescriptor | undefined> = {}
beforeAll(() => {
  for (const [k, v] of Object.entries(sizes)) {
    saved[k] = Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)
    Object.defineProperty(HTMLElement.prototype, k, { configurable: true, get: () => v })
  }
  HTMLElement.prototype.scrollTo = function () {} as never
  HTMLElement.prototype.scrollIntoView = function () {} as never
  HTMLElement.prototype.hasPointerCapture = () => false
  HTMLElement.prototype.releasePointerCapture = () => {}
})
afterAll(() => {
  for (const [k, d] of Object.entries(saved)) if (d) Object.defineProperty(HTMLElement.prototype, k, d)
})

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  calls.length = 0
  try {
    localStorage.clear()
  } catch {}
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })
      if (url.endsWith('/ops')) return json({ version: (body?.base_version ?? 0) + 1, change_id: 'ch-1', inserted_row_ids: [], created_column_ids: {} })
      if (url.includes('/changes')) return json({ changes: [] })
      if (url.includes('/rows?ids=')) return json({ rows: [], labels: {} })
      if (url.includes('/rows')) return json({ rows: ROWS, has_more: false, labels: {} })
      if (url.startsWith('/api/account/views')) return json({ views: [], total: 0 })
      return json({ table: { ...TABLE, columns: COLUMNS, can_edit: true } })
    }),
  )
  container = document.createElement('div')
  container.style.height = '600px'
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async (n = 6) => {
  for (let i = 0; i < n; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
const grid = () => container.querySelector<HTMLDivElement>('[role="grid"]')!
const cell = (r: number, c: number) => container.querySelector<HTMLElement>(`[data-r="${r}"][data-c="${c}"]`)!
const press = (key: string, opts: KeyboardEventInit = {}, target: Element = grid()) =>
  act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts }))
  })
const click = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0 }))
  })
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function open() {
  await act(async () => root.render(<TableDetail tableId={T} onBack={() => {}} />))
  await flush()
}

describe('computed columns in the grid', () => {
  it('reads each as its result, with a cell’s error and a column’s', async () => {
    await open()
    expect(cell(0, 3).textContent).toBe('100')
    expect(cell(0, 5).textContent).toBe('3')
    expect(cell(1, 3).textContent).toBe('Error')
    expect(cell(1, 3).querySelector('[title="Division by zero."]')).not.toBeNull()
    expect(cell(0, 6).textContent).toBe('Needs a fix')
    expect(container.querySelector('[aria-label="No column named {gone}."]')).not.toBeNull()
  })

  it('never opens an editor on a formula or a rollup', async () => {
    await open()
    await click(cell(0, 3))
    await press('Enter')
    await press('7')
    expect(cell(0, 3).querySelector('input')).toBeNull()
    await click(cell(0, 5))
    await press('Enter')
    expect(cell(0, 5).querySelector('input')).toBeNull()
    expect(calls.filter((c) => c.url.endsWith('/ops'))).toHaveLength(0)
  })

  it('an edit works the row’s formula out again at once', async () => {
    await open()
    await click(cell(0, 1))
    await press('5')
    const input = cell(0, 1).querySelector('input')!
    await type(input, '5')
    await press('Enter', {}, input)
    expect(cell(0, 1).textContent).toBe('5')
    expect(cell(0, 3).textContent).toBe('250')
    // The rollup keeps the server's count until the rows are read again.
    expect(cell(0, 5).textContent).toBe('3')
    await flush()
    const ops = calls.filter((c) => c.url.endsWith('/ops'))
    expect(ops).toHaveLength(1)
    expect(ops[0].body?.ops).toEqual([{ op: 'update_row', row_id: R1, values: { qty: 5 } }])
  })
})
