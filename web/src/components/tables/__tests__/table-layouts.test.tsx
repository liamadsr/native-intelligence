// @vitest-environment jsdom
/**
 * A table's board, calendar and gallery (../table-detail.tsx, phase 4): the
 * open saved view picks the layout; a board has a lane for every option, the
 * empty ones too, then "No value", with its total; a card dropped on another
 * lane (or day) shows there at once and goes as one batch on the version
 * read, caught up and sent again on a 409; the calendar keeps the rows with
 * no date in a side list, and a card dropped there loses its date; a gallery
 * tops a card with its picked URL's image. The rows are read through the
 * view (POST rows with its filters and sorts). react-dnd is stubbed: each
 * drop target's spec is kept on its element, so a test drops by calling it.
 * Fetch is stubbed; names are made up.
 */
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { format, addDays } from 'date-fns'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn() }) }))
vi.mock('@/app/account/workspace-switcher', () => ({ useWorkspaceId: () => 'ws-1', useCurrentMemberId: () => 'm-1' }))

const drops = new WeakMap<Element, { drop: (item: unknown) => void; canDrop?: (item: unknown) => boolean }>()
vi.mock('react-dnd', () => ({
  DndProvider: ({ children }: { children: ReactNode }) => children,
  useDrag: () => [{ dragging: false }, () => {}],
  useDrop: (spec: { drop: (item: unknown) => void; canDrop?: (item: unknown) => boolean }) => [
    { over: false },
    (el: Element | null) => {
      if (el) drops.set(el, spec)
    },
  ],
}))
vi.mock('react-dnd-html5-backend', () => ({ HTML5Backend: {} }))

const { TableDetail } = await import('../table-detail')

const T = '33333333-3333-4333-8333-333333333333'
const R1 = '11111111-1111-4111-8111-111111111111'
const R2 = '22222222-2222-4222-8222-222222222222'
const R3 = '44444444-4444-4444-8444-444444444444'
const today = format(new Date(), 'yyyy-MM-dd')
// Another day of this week, so the month on screen always has it.
const tomorrow = format(addDays(new Date(), new Date().getDay() === 6 ? -1 : 1), 'yyyy-MM-dd')

const column = (key: string, label: string, field_type: string, extra: Record<string, unknown> = {}, position = 0) => ({ id: `c-${key}`, table_id: T, key, label, field_type, options: [], config: {}, position, deleted_at: null, ...extra })
const COLUMNS = [
  column('stage', 'Stage', 'select', { options: ['Lead', 'Quoted', 'Won'] }, 0),
  // A price is needed once a row is Won (required-when).
  column('price', 'Price', 'currency', { config: { currency: 'USD', required_when: { key: 'stage', option: 'Won' } } }, 1),
  column('due', 'Due', 'date', {}, 2),
  column('photo', 'Photo', 'url', {}, 3),
]
const TABLE = { id: T, workspace_id: 'ws-1', name: 'Fernhill orders', icon: null, description: null, owner_member_id: 'm', visibility: 'workspace', version: 4, position: 0, archived_at: null, created_at: '', updated_at: '' }
const ROWS = [
  { id: R1, table_id: T, title: 'Oak table', custom_fields: { stage: 'Won', price: { amount: 1200, currency: 'USD' }, due: today, photo: 'https://img.fernhill.example/oak.jpg' }, position: 1, archived_at: null, created_at: '', updated_at: '' },
  { id: R2, table_id: T, title: 'Linen set', custom_fields: { stage: 'Lead', price: { amount: 80, currency: 'USD' }, due: today }, position: 2, archived_at: null, created_at: '', updated_at: '' },
  { id: R3, table_id: T, title: 'Elm bench', custom_fields: {}, position: 3, archived_at: null, created_at: '', updated_at: '' },
]
const view = (id: string, layout: string, extra: Record<string, unknown> = {}) => ({
  id, workspace_id: 'ws-1', team_id: null, created_by: 'u', name: id, description: null, icon: null, color: null, slug: null,
  entity_type: 'data_row', visibility: 'personal', layout, filters: [], grouping: null, sub_grouping: null, ordering: [], display_properties: [],
  board_group_by: null, show_completed: true, completed_filter: 'all', show_sub_items: true, nested_sub_items: false, show_empty_groups: false,
  is_pinned: false, pin_order: 0, scope_type: 'data_table', scope_id: T, metadata: {}, created_at: '', updated_at: '', ...extra,
})
const VIEWS = [
  view('Pipeline', 'board', {
    grouping: { field: 'custom_fields.stage', direction: 'asc' },
    ordering: [{ field: 'custom_fields.price', direction: 'desc' }],
    filters: [{ id: 'f', field: 'custom_fields.price', operator: 'gte', value: 10 }],
    metadata: { table: { total_key: 'price' } },
  }),
  view('Dates', 'calendar', { metadata: { table: { date_key: 'due' } } }),
  view('Showroom', 'gallery', { metadata: { table: { cover_key: 'photo' } } }),
]

type Answer = { status: number; body: unknown }
let opsAnswers: Answer[] = []
let afterVersion: unknown[] = []
const calls: Array<{ url: string; method: string; body?: unknown }> = []
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  opsAnswers = []
  afterVersion = []
  calls.length = 0
  localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, method, body })
      if (url.startsWith('/api/account/views')) return json({ views: VIEWS, total: VIEWS.length })
      if (url.endsWith('/ops')) {
        const a = opsAnswers.shift() ?? { status: 200, body: { version: (body?.base_version ?? 0) + 1, change_id: `ch-${(body?.base_version ?? 0) + 1}`, inserted_row_ids: [], created_column_ids: {} } }
        return json(a.body, a.status)
      }
      if (url.includes('/changes?after_version=')) return json({ changes: afterVersion })
      if (url.includes('/changes')) return json({ changes: [] })
      if (url.includes('/rows')) return json({ rows: ROWS, has_more: false, labels: {} })
      if (url === '/api/account/workspace/members') return json({ members: [] })
      return json({ table: { ...TABLE, columns: COLUMNS, can_edit: true } })
    }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

const flush = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
async function open(viewId: string) {
  localStorage.setItem(`ni:active-view:ws-1:data_row:noteam:data_table:${T}`, viewId)
  await act(async () => root.render(<TableDetail tableId={T} onBack={() => {}} />))
  await flush()
}
const opsCalls = () => calls.filter((c) => c.url.endsWith('/ops'))
const drop = async (target: Element, item: unknown) => {
  const spec = drops.get(target)!
  expect(spec, 'a drop target').toBeTruthy()
  if (spec.canDrop && !spec.canDrop(item)) return
  await act(async () => spec.drop(item))
  await flush(10)
}
const laneArea = (key: string) => container.querySelector(`[data-lane="${key}"] > div`)!
const laneTitles = (key: string) => [...container.querySelectorAll(`[data-lane="${key}"] [data-row-card] p`)].map((p) => p.textContent)

describe('a board view', () => {
  it('reads its rows through the view, and has a lane for every option, the empty one too, with totals', async () => {
    await open('Pipeline')
    const rowsRead = calls.find((c) => c.url.endsWith('/rows') && c.method === 'POST')
    expect(rowsRead?.body).toMatchObject({ filters: [{ field: 'custom_fields.price', operator: 'gte', value: 10 }], ordering: [{ field: 'custom_fields.price', direction: 'desc' }], offset: 0 })
    const lanes = [...container.querySelectorAll('[data-lane]')].map((l) => l.getAttribute('data-lane'))
    expect(lanes).toEqual(['Lead', 'Quoted', 'Won', '__none__'])
    expect(laneTitles('Quoted')).toEqual([])
    expect(laneTitles('__none__')).toEqual(['Elm bench'])
    expect(container.querySelector('[data-lane="Won"] [data-lane-total]')?.textContent).toBe('$1,200.00')
  })

  it('a card dropped on another lane moves at once and goes as one batch; a 409 catches up and sends again', async () => {
    opsAnswers = [{ status: 409, body: { error: 'This table changed', details: { version: 5 } } }]
    // A teammate renamed another row in between.
    afterVersion = [{ id: 'theirs', table_id: T, version: 5, changes: [{ op: 'update_row', row_id: R1, fields: { title: { from: 'Oak table', to: 'Oak desk' } } }], undo_of: null, undone_at: null, created_at: '' }]
    await open('Pipeline')
    await drop(laneArea('Won'), { id: R2, lane: 'Lead' })
    expect(laneTitles('Won')).toEqual(['Oak desk', 'Linen set'])
    expect(laneTitles('Lead')).toEqual([])
    expect(calls.some((c) => c.url.includes('/changes?after_version=4'))).toBe(true)
    const sent = opsCalls().map((c) => c.body as { base_version: number; ops: unknown[] })
    expect(sent.map((b) => b.base_version)).toEqual([4, 5])
    expect(sent[1].ops).toEqual([{ op: 'update_row', row_id: R2, values: { stage: 'Won' } }])
  })

  it('a refused move puts the card back', async () => {
    opsAnswers = [{ status: 400, body: { error: 'Stage needs a price when it is Won' } }]
    await open('Pipeline')
    await drop(laneArea('Won'), { id: R3, lane: '__none__' })
    expect(laneTitles('__none__')).toEqual(['Elm bench'])
    expect(laneTitles('Won')).toEqual(['Oak table'])
  })
})

describe('a board’s New', () => {
  it('in a lane: a row with that lane’s value, opened', async () => {
    await open('Pipeline')
    const add = [...container.querySelectorAll('[data-lane="Lead"] button')].find((b) => b.textContent?.includes('New'))!
    await act(async () => (add as HTMLElement).click())
    await flush(10)
    expect(opsCalls().at(-1)?.body).toMatchObject({ ops: [{ op: 'insert_rows', rows: [{ title: '', values: { stage: 'Lead' } }] }] })
    expect(laneTitles('Lead')).toEqual(['Linen set', 'Untitled'])
  })

  it('in a lane whose value needs another column: added without it, opened with that column flagged, and said so', async () => {
    const { toast } = await import('sonner')
    await open('Pipeline')
    const add = [...container.querySelectorAll('[data-lane="Won"] button')].find((b) => b.textContent?.includes('New'))!
    await act(async () => (add as HTMLElement).click())
    await flush(10)
    const sent = opsCalls().at(-1)?.body as { ops: Array<{ op: string; rows: Array<Record<string, unknown>> }> }
    expect(sent.ops).toEqual([{ op: 'insert_rows', rows: [{ id: expect.any(String), title: '' }] }])
    expect(laneTitles('__none__')).toContain('Untitled')
    expect(vi.mocked(toast.error)).toHaveBeenCalledWith(expect.stringMatching(/^Price is needed when Stage is Won.*Added it without Stage; fill that in, then move it to Won\.$/))
    // The row panel is open on the new row, its Price flagged.
    expect(document.querySelector('[data-row-field="price"]')?.textContent).toContain('Price is needed when Stage is Won')
  })
})

describe('a calendar view', () => {
  it('a card dropped on another day writes that day; the undated wait aside; dropped there, a date goes', async () => {
    await open('Dates')
    const day = container.querySelector(`[data-day="${today}"]`)!
    expect([...day.querySelectorAll('[data-row-card]')].map((c) => c.textContent)).toEqual(['Oak table', 'Linen set'])
    const aside = container.querySelector('aside[aria-label="No date"]')!
    expect(aside.textContent).toContain('Elm bench')

    await drop(container.querySelector(`[data-day="${tomorrow}"]`)!, { id: R1, day: today })
    expect(opsCalls().at(-1)?.body).toMatchObject({ base_version: 4, ops: [{ op: 'update_row', row_id: R1, values: { due: tomorrow } }] })
    expect(container.querySelector(`[data-day="${tomorrow}"]`)!.textContent).toContain('Oak table')

    await drop(aside, { id: R2, day: today })
    expect(opsCalls().at(-1)?.body).toMatchObject({ base_version: 5, ops: [{ op: 'update_row', row_id: R2, values: { due: null } }] })
    expect(container.querySelector('aside[aria-label="No date"]')!.textContent).toContain('Linen set')
  })
})

describe('a gallery view', () => {
  it('tops a card with its URL’s image, and only when there is one', async () => {
    await open('Showroom')
    const cards = [...container.querySelectorAll('[data-table-gallery] [data-row-card]')]
    expect(cards.map((c) => c.querySelector('p')?.textContent)).toEqual(['Oak table', 'Linen set', 'Elm bench'])
    expect(cards[0].querySelector('img')?.getAttribute('src')).toBe('https://img.fernhill.example/oak.jpg')
    expect(cards[1].querySelector('img')).toBeNull()
  })
})
