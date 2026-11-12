// @vitest-environment jsdom
/**
 * One table as its editable grid (../table-detail.tsx): every type read as
 * it's stored, an edit shown at once and saved as one batch on the version
 * read, the stored form shown rather than what was typed, a 409 caught up
 * and sent again, a refusal put back with its error on the cell, the
 * editors per type (select, checkbox, person, relation, date), a paste as
 * one batch that adds rows, ⌘Z, the type-change dialog's misfit error, and
 * a view-only reader's read-only grid. Fetch is stubbed; names are made up.
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
const MEMBER = '66666666-6666-4666-8666-666666666666'
const CO = '77777777-7777-4777-8777-777777777777'
const CO2 = '88888888-8888-4888-8888-888888888888'

const column = (key: string, label: string, field_type: string, extra: Record<string, unknown> = {}, position = 0) => ({ id: `c-${key}`, table_id: T, key, label, field_type, options: [], config: {}, position, deleted_at: null, ...extra })
const COLUMNS = [
  column('qty', 'Qty', 'number', {}, 0),
  column('stage', 'Stage', 'select', { options: ['Lead', 'Won'] }, 1),
  column('paid', 'Paid', 'checkbox', {}, 2),
  column('owner', 'Owner', 'person', {}, 3),
  column('client', 'Client', 'relation', { config: { target: { kind: 'company' }, multiple: false } }, 4),
  column('price', 'Price', 'currency', { config: { currency: 'USD' } }, 5),
  column('due', 'Due', 'date', {}, 6),
  column('site', 'Site', 'url', {}, 7),
]
const TABLE = { id: T, workspace_id: 'ws', name: 'Fernhill orders', icon: null, description: null, owner_member_id: 'm', visibility: 'workspace', version: 4, position: 0, archived_at: null, created_at: '', updated_at: '' }
const ROWS = [
  { id: R1, table_id: T, title: 'Oak table', custom_fields: { qty: 2, stage: 'Lead', paid: true, owner: MEMBER, client: [CO], price: { amount: 1200, currency: 'USD' }, due: '2026-12-01', site: 'https://fernhill.example' }, position: 1, archived_at: null, created_at: '', updated_at: '' },
  { id: R2, table_id: T, title: 'Linen set', custom_fields: {}, position: 2, archived_at: null, created_at: '', updated_at: '' },
]

type Answer = { status: number; body: unknown }
let canEdit = true
let opsAnswers: Answer[] = []
let afterVersion: unknown[] = []
const calls: Array<{ url: string; method: string; body?: unknown }> = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const sizes = { offsetWidth: 1400, offsetHeight: 600 }
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
  canEdit = true
  opsAnswers = []
  afterVersion = []
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
      if (url.endsWith('/ops')) {
        const a = opsAnswers.shift() ?? { status: 200, body: { version: (body?.base_version ?? 0) + 1, change_id: `ch-${(body?.base_version ?? 0) + 1}`, inserted_row_ids: [], created_column_ids: {} } }
        return json(a.body, a.status)
      }
      if (url.endsWith('/undo')) return json({ kept: [], version: 9, change_id: 'undo-1' })
      if (url.includes('/changes?after_version=')) return json({ changes: afterVersion })
      if (url.includes('/changes')) return json({ changes: [] })
      if (url.includes('/rows?ids=')) return json({ rows: [], labels: {} })
      if (url.includes('/rows')) return json({ rows: ROWS, has_more: false, labels: { [MEMBER]: 'Robin Vale', [CO]: 'Fernhill Studio' } })
      if (url === '/api/account/workspace/members') return json({ members: [{ id: MEMBER, display_name: 'Robin Vale', role: 'member' }, { id: 'g', display_name: 'A guest', role: 'guest' }] })
      if (url.startsWith('/api/account/search')) return json({ query: '', results: { company: [{ kind: 'company', company: { id: CO2, name: 'Birchwood Supply' } }] } })
      if (url === '/api/account/tables') return json({ tables: [TABLE] })
      return json({ table: { ...TABLE, columns: COLUMNS, can_edit: canEdit } })
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
const click = (el: Element, opts: MouseEventInit = {}) =>
  act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ...opts }))
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, ...opts }))
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, ...opts }))
  })
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const opsCalls = () => calls.filter((c) => c.url.endsWith('/ops'))
const select = async (r: number, c: number) => click(cell(r, c))
const option = (text: string) => [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent?.includes(text)) as HTMLElement

async function open() {
  await act(async () => root.render(<TableDetail tableId={T} onBack={() => {}} />))
  await flush()
}

describe('TableDetail grid', () => {
  it('shows every type as stored: headers by type, numbers, chips, a checkbox, names, an amount, a date, a link', async () => {
    await open()
    expect([...container.querySelectorAll('[role="columnheader"]')].map((h) => h.getAttribute('aria-label'))).toEqual(['Name', 'Qty', 'Stage', 'Paid', 'Owner', 'Client', 'Price', 'Due', 'Site'])
    const texts = Array.from({ length: 9 }, (_, c) => cell(0, c).textContent)
    expect(texts[0]).toContain('Oak table')
    expect(texts.slice(1)).toEqual(['2', 'Lead', '', expect.stringContaining('Robin Vale'), 'Fernhill Studio', '$1,200.00', expect.stringMatching(/^Dec 1/), 'https://fernhill.example'])
    expect(cell(0, 3).querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true')
    // A + New row and a + column header, for an editor.
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'New')).toBe(true)
    expect(container.querySelector('button[aria-label="Add a column"]')).not.toBeNull()
  })

  it('an edit shows at once in its stored form and goes as one batch on the version read', async () => {
    await open()
    await select(1, 1)
    await press('1')
    const input = cell(1, 1).querySelector('input')!
    await type(input, '1,250')
    await press('Enter', {}, input)
    expect(cell(1, 1).textContent).toBe('1,250')
    await flush()
    expect(opsCalls()).toHaveLength(1)
    expect(opsCalls()[0].body).toEqual({ base_version: 4, ops: [{ op: 'update_row', row_id: R2, values: { qty: 1250 } }] })
    // The next edit chains on the version the server answered.
    await select(1, 8)
    await press('f')
    const site = cell(1, 8).querySelector('input')!
    await type(site, 'fernhill.example/linen')
    await press('Enter', {}, site)
    await flush()
    expect(cell(1, 8).textContent).toBe('https://fernhill.example/linen')
    expect((opsCalls()[1].body as { base_version: number }).base_version).toBe(5)
  })

  it('a value that doesn’t fit stays out of the batch, with its error on the cell', async () => {
    await open()
    await select(1, 1)
    await press('x')
    await press('Enter', {}, cell(1, 1).querySelector('input')!)
    await flush()
    expect(opsCalls()).toHaveLength(0)
    expect(cell(1, 1).querySelector('[aria-invalid="true"]')?.getAttribute('title')).toBe('Qty needs a number')
  })

  it('on a 409 catches up and sends again on the new version; a refusal puts the cell back with the error', async () => {
    opsAnswers = [{ status: 409, body: { error: 'This table changed', details: { version: 6 } } }]
    afterVersion = [{ id: 'theirs', table_id: T, version: 5, changes: [{ op: 'update_row', row_id: R1, fields: { title: { from: 'Oak table', to: 'Oak desk' } } }], undo_of: null, undone_at: null, created_at: '' }]
    await open()
    await select(1, 1)
    await press('7')
    await press('Enter', {}, cell(1, 1).querySelector('input')!)
    await flush(10)
    expect(calls.some((c) => c.url.includes('/changes?after_version=4'))).toBe(true)
    expect(opsCalls().map((c) => (c.body as { base_version: number }).base_version)).toEqual([4, 5])
    expect(cell(0, 0).textContent).toContain('Oak desk')
    expect(cell(1, 1).textContent).toBe('7')

    opsAnswers = [{ status: 400, body: { error: 'Client links a record that isn’t one you can link to.' } }]
    await select(1, 1)
    await press('9')
    await press('Enter', {}, cell(1, 1).querySelector('input')!)
    await flush(10)
    expect(cell(1, 1).textContent).toBe('7')
    expect(cell(1, 1).querySelector('[aria-invalid="true"]')?.getAttribute('title')).toContain('isn’t one you can link to')
  })

  it('a select’s picker lists its options and saves the one picked', async () => {
    await open()
    await select(1, 2)
    await press('Enter')
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['Lead', 'Won'])
    await click(option('Won'))
    await flush()
    expect(opsCalls()[0].body).toMatchObject({ ops: [{ op: 'update_row', row_id: R2, values: { stage: 'Won' } }] })
    expect(cell(1, 2).textContent).toBe('Won')
  })

  it('Space toggles a checkbox with no editor', async () => {
    await open()
    await select(0, 3)
    await press(' ')
    await flush()
    expect(opsCalls()[0].body).toMatchObject({ ops: [{ op: 'update_row', row_id: R1, values: { paid: false } }] })
    expect(cell(0, 3).querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false')
  })

  it('a person’s picker lists the members (no guests); a relation’s searches its kind and links what’s picked', async () => {
    await open()
    await select(1, 4)
    await press('Enter')
    expect([...document.querySelectorAll('[role="option"]')].map((o) => o.textContent)).toEqual(['Robin Vale'])
    await click(option('Robin Vale'))
    await flush()
    expect(opsCalls()[0].body).toMatchObject({ ops: [{ values: { owner: MEMBER } }] })

    await select(1, 5)
    await press('b')
    await act(async () => new Promise((r) => setTimeout(r, 200)))
    await flush()
    expect(calls.some((c) => c.url.startsWith('/api/account/search?types=company') && c.url.includes('q=b'))).toBe(true)
    await click(option('Birchwood Supply'))
    await flush()
    expect(opsCalls()[1].body).toMatchObject({ ops: [{ op: 'update_row', row_id: R2, values: { client: [CO2] } }] })
    expect(cell(1, 5).textContent).toBe('Birchwood Supply')
  })

  it('a date takes a typed date in spreadsheet form and stores it as YYYY-MM-DD', async () => {
    await open()
    await select(1, 7)
    await press('Enter')
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Due"]')!
    await type(input, '3/4/2027')
    await press('Enter', {}, input)
    await flush()
    expect(opsCalls()[0].body).toMatchObject({ ops: [{ values: { due: '2027-03-04' } }] })
  })

  it('a paste is one batch: it fills cells and adds the rows it needs', async () => {
    await open()
    await select(1, 0)
    const store: Record<string, string> = { 'text/plain': 'Linen set, blue\t3\nWalnut shelf\t1\nCedar box\tlots\n' }
    const e = Object.assign(new Event('paste', { bubbles: true, cancelable: true }), { clipboardData: { getData: (t: string) => store[t] ?? '', setData: () => {} } })
    await act(async () => {
      grid().dispatchEvent(e)
    })
    await flush()
    expect(opsCalls()).toHaveLength(1)
    const ops = (opsCalls()[0].body as { ops: Array<Record<string, unknown>> }).ops
    expect(ops[0]).toMatchObject({ op: 'insert_rows', rows: [{ title: 'Walnut shelf', values: { qty: 1 } }, { title: 'Cedar box' }] })
    expect(ops[1]).toEqual({ op: 'update_row', row_id: R2, title: 'Linen set, blue', values: { qty: 3 } })
    expect(container.querySelector('[role="grid"]')!.getAttribute('aria-rowcount')).toBe('5')
    // "lots" doesn't fit Qty: that cell carries the error.
    expect(cell(3, 1).querySelector('[aria-invalid="true"]')?.getAttribute('title')).toBe('Qty needs a number')
  })

  it('⌘Z undoes this visit’s last change through the undo route', async () => {
    await open()
    await select(1, 1)
    await press('5')
    await press('Enter', {}, cell(1, 1).querySelector('input')!)
    await flush()
    await press('z', { metaKey: true })
    await flush()
    const undo = calls.find((c) => c.url.endsWith('/undo'))!
    expect(undo.body).toEqual({ change_id: 'ch-5' })
  })

  it('the type-change dialog shows the misfit error and changes nothing', async () => {
    opsAnswers = [{ status: 400, body: { error: '2 values in “Site” don’t fit Number.' } }]
    await open()
    const header = container.querySelector('[role="columnheader"][aria-label="Site"]')!
    await act(async () => {
      // jsdom may lack PointerEvent; React reads the event's type either way.
      const P = typeof PointerEvent === 'undefined' ? MouseEvent : PointerEvent
      header.dispatchEvent(new P('pointerdown', { bubbles: true, button: 0, clientX: 10 }))
      header.dispatchEvent(new P('pointerup', { bubbles: true, button: 0, clientX: 10 }))
    })
    await flush()
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((m) => m.textContent?.includes('Change type')) as HTMLElement
    await act(async () => item.click())
    await flush()
    const typeSelect = document.querySelector<HTMLSelectElement>('select[aria-label="Type"]')!
    await act(async () => {
      typeSelect.value = 'number'
      typeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const go = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Change type') as HTMLButtonElement
    await act(async () => go.click())
    await flush()
    expect(opsCalls()[0].body).toMatchObject({ ops: [{ op: 'change_column_type', key: 'site', field_type: 'number' }] })
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('2 values in “Site” don’t fit Number.')
    expect(container.querySelector('[role="columnheader"][aria-label="Site"]')).not.toBeNull()
  })

  it('a view-only reader gets a read-only grid: no + New, no + column, no editing, no checkbox toggle', async () => {
    canEdit = false
    await open()
    expect(grid().getAttribute('aria-readonly')).toBe('true')
    expect(container.textContent).toContain('View only')
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'New')).toBe(false)
    expect(container.querySelector('button[aria-label="Add a column"]')).toBeNull()
    expect(cell(0, 3).querySelector('button[role="checkbox"]')).toBeNull()
    await select(1, 1)
    await press('4')
    await press('Enter')
    await press('Delete')
    await flush()
    expect(cell(1, 1).querySelector('input')).toBeNull()
    expect(opsCalls()).toHaveLength(0)
  })
})
