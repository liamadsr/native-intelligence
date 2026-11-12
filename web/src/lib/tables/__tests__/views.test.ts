/**
 * A table's views laid out (src/lib/tables/views.ts): the settings a view
 * keeps in its metadata, the grid's columns in the view's order, a board's
 * lanes (every option, the empty ones too, then "No value") and totals, the
 * edit a card dropped on a lane or a day makes, a calendar's weeks and days,
 * and a gallery's cover. Names are made up.
 */
import { describe, expect, it } from 'vitest'
import type { DataColumn, DataRow } from '../types'
import {
  boardLanes,
  boardMoveEdit,
  calendarMoveEdit,
  cardColumns,
  columnTotals,
  coverColumnOf,
  coverUrl,
  dateColumnOf,
  groupColumnOf,
  monthWeeks,
  moveColumn,
  NO_VALUE,
  readTableSettings,
  rowsByDay,
  viewColumns,
  weekDays,
  withTableSettings,
} from '../views'

const col = (key: string, field_type: DataColumn['field_type'], extra: Partial<DataColumn> = {}): DataColumn => ({
  id: `c-${key}`,
  table_id: 't',
  key,
  label: key[0].toUpperCase() + key.slice(1),
  field_type,
  options: [],
  config: {},
  position: 0,
  deleted_at: null,
  ...extra,
})
const row = (id: string, title: string, custom_fields: DataRow['custom_fields'] = {}): DataRow => ({
  id,
  table_id: 't',
  title,
  custom_fields,
  position: 0,
  archived_at: null,
  created_at: '',
  updated_at: '',
})

const STAGE = col('stage', 'select', { options: ['Lead', 'Quoted', 'Won'] })
const OWNER = col('owner', 'person')
const QTY = col('qty', 'number')
const PRICE = col('price', 'currency')
const DUE = col('due', 'date')
const SITE = col('site', 'url')
const COLUMNS = [STAGE, OWNER, QTY, PRICE, DUE, SITE]

describe('settings in a view’s metadata', () => {
  it('reads only well-formed values, and writes them beside the rest of the metadata', () => {
    expect(readTableSettings({ table: { widths: { title: 320, qty: 5, 'Bad Key': 90 }, hidden: ['site', 'site', 3], total_key: 'price', date_key: null, cover_key: 'x y' } })).toEqual({
      widths: { title: 320, qty: 60 },
      hidden: ['site'],
      total_key: 'price',
      date_key: null,
    })
    expect(readTableSettings({})).toBeUndefined()
    expect(readTableSettings(null)).toBeUndefined()
    const meta = withTableSettings({ action_scope: 'all', table: { hidden: ['x'] } }, { widths: { title: 300 } })
    expect(meta).toEqual({ action_scope: 'all', table: { widths: { title: 300 } } })
    expect(readTableSettings(meta)).toEqual({ widths: { title: 300 } })
    expect(withTableSettings({ action_scope: 'all', table: { hidden: ['x'] } }, undefined)).toEqual({ action_scope: 'all' })
  })
})

describe('the grid’s columns', () => {
  it('the view’s order first, then the rest in the table’s, less the hidden', () => {
    expect(viewColumns(COLUMNS, ['qty', 'stage', 'gone'], ['owner']).map((c) => c.key)).toEqual(['qty', 'stage', 'price', 'due', 'site'])
    expect(viewColumns(COLUMNS).map((c) => c.key)).toEqual(['stage', 'owner', 'qty', 'price', 'due', 'site'])
  })

  it('a moved column takes its place among the shown ones; the hidden keep theirs', () => {
    // Shown: stage, qty, price, due, site (owner hidden). qty to the front.
    expect(moveColumn(COLUMNS, [], ['owner'], 'qty', 0)).toEqual(['qty', 'stage', 'owner', 'price', 'due', 'site'])
    // stage to after due (shown index 3 once stage is out: qty, price, due, [here], site).
    expect(moveColumn(COLUMNS, [], ['owner'], 'stage', 3)).toEqual(['owner', 'qty', 'price', 'due', 'stage', 'site'])
    // To the end.
    expect(moveColumn(COLUMNS, [], [], 'stage', 99)).toEqual(['owner', 'qty', 'price', 'due', 'site', 'stage'])
  })

  it('a card shows the first three fields the layout doesn’t already say', () => {
    expect(cardColumns(COLUMNS, ['stage']).map((c) => c.key)).toEqual(['owner', 'qty', 'price'])
  })
})

describe('a board', () => {
  const ROWS = [
    row('r1', 'Oak table', { stage: 'Won', qty: 2, price: { amount: 1200, currency: 'USD' }, owner: 'm1' }),
    row('r2', 'Linen set', { stage: 'Lead', qty: 3, price: { amount: 80.5, currency: 'USD' } }),
    row('r3', 'Lamp', { stage: 'Retired', price: { amount: 40, currency: 'EUR' } }),
    row('r4', 'Rug', {}),
    row('r5', 'Stool', { stage: 'Won', qty: 1.25, price: { amount: 100, currency: 'USD' } }),
  ]

  it('groups by a select or a person, never anything else', () => {
    expect(groupColumnOf(COLUMNS, { field: 'custom_fields.stage', direction: 'asc' })).toBe(STAGE)
    expect(groupColumnOf(COLUMNS, { field: 'custom_fields.owner', direction: 'asc' })).toBe(OWNER)
    expect(groupColumnOf(COLUMNS, { field: 'custom_fields.qty', direction: 'asc' })).toBeNull()
    expect(groupColumnOf(COLUMNS, null)).toBeNull()
  })

  it('a lane per option, the empty one too, then a removed option, then No value; rows keep their order', () => {
    const lanes = boardLanes(ROWS, STAGE)
    expect(lanes.map((l) => [l.key, l.label, l.rows.map((r) => r.id)])).toEqual([
      ['Lead', 'Lead', ['r2']],
      ['Quoted', 'Quoted', []],
      ['Won', 'Won', ['r1', 'r5']],
      ['Retired', 'Retired', ['r3']],
      [NO_VALUE, 'No Stage', ['r4']],
    ])
  })

  it('a person board: every member by name, a former one by its label, then No one', () => {
    const lanes = boardLanes([row('a', 'A', { owner: 'm2' }), row('b', 'B', { owner: 'gone' }), row('c', 'C')], OWNER, {
      members: [{ id: 'm2', name: 'Sam Reyes' }, { id: 'm1', name: 'Avery Lin' }],
      labels: { gone: 'Jordan Pike' },
    })
    expect(lanes.map((l) => [l.key, l.label, l.rows.length])).toEqual([
      ['m1', 'Avery Lin', 0],
      ['m2', 'Sam Reyes', 1],
      ['gone', 'Jordan Pike', 1],
      [NO_VALUE, 'No one', 1],
    ])
  })

  it('totals a number, and a currency per code (the most common first)', () => {
    expect(columnTotals(ROWS, QTY)).toEqual([{ amount: 6.25 }])
    expect(columnTotals(ROWS, PRICE)).toEqual([
      { amount: 1380.5, currency: 'USD' },
      { amount: 40, currency: 'EUR' },
    ])
    expect(columnTotals(ROWS, STAGE)).toEqual([])
    const won = boardLanes(ROWS, STAGE, { totalColumn: PRICE }).find((l) => l.key === 'Won')!
    expect(won.totals).toEqual([{ amount: 1300, currency: 'USD' }])
  })

  it('a card dropped on a lane writes that lane’s value; on No value, clears it; on its own lane, nothing', () => {
    expect(boardMoveEdit(ROWS[1], STAGE, 'Won')).toEqual({ rowId: 'r2', key: 'stage', value: 'Won' })
    expect(boardMoveEdit(ROWS[1], STAGE, NO_VALUE)).toEqual({ rowId: 'r2', key: 'stage', value: null })
    expect(boardMoveEdit(ROWS[1], STAGE, 'Lead')).toBeNull()
    expect(boardMoveEdit(ROWS[3], STAGE, NO_VALUE)).toBeNull()
    expect(boardMoveEdit(ROWS[3], OWNER, 'm1')).toEqual({ rowId: 'r4', key: 'owner', value: 'm1' })
  })
})

describe('a calendar', () => {
  it('a month is whole weeks, Sunday first', () => {
    const weeks = monthWeeks(new Date(2026, 10, 15))
    expect(weeks).toHaveLength(5)
    expect(weeks[0][0]).toBe('2026-11-01')
    expect(weeks[4][6]).toBe('2026-12-05')
    expect(monthWeeks(new Date(2026, 1, 10))[0][0]).toBe('2026-02-01')
    expect(weekDays(new Date(2026, 10, 11))).toEqual(['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'])
  })

  it('rows by their day; the ones with no date (or not a date) apart', () => {
    const { days, undated } = rowsByDay(
      [row('a', 'A', { due: '2026-11-12' }), row('b', 'B', { due: '2026-11-12' }), row('c', 'C', { due: '2026-02-30' }), row('d', 'D')],
      DUE,
    )
    expect([...days.entries()].map(([d, rs]) => [d, rs.map((r) => r.id)])).toEqual([['2026-11-12', ['a', 'b']]])
    expect(undated.map((r) => r.id)).toEqual(['c', 'd'])
  })

  it('a card dropped on a day writes that day; on the side list, clears it', () => {
    const r = row('a', 'A', { due: '2026-11-12' })
    expect(calendarMoveEdit(r, DUE, '2026-11-20')).toEqual({ rowId: 'a', key: 'due', value: '2026-11-20' })
    expect(calendarMoveEdit(r, DUE, null)).toEqual({ rowId: 'a', key: 'due', value: null })
    expect(calendarMoveEdit(r, DUE, '2026-11-12')).toBeNull()
    expect(calendarMoveEdit(r, DUE, 'soon')).toBeNull()
    expect(calendarMoveEdit(row('b', 'B'), DUE, '2026-11-03')).toEqual({ rowId: 'b', key: 'due', value: '2026-11-03' })
  })

  it('lays out by the view’s date column, else the table’s first', () => {
    const second = col('shipped', 'date')
    expect(dateColumnOf([...COLUMNS, second], 'shipped')).toBe(second)
    expect(dateColumnOf([...COLUMNS, second], null)).toBe(DUE)
    expect(dateColumnOf([...COLUMNS, second], 'qty')).toBe(DUE)
    expect(dateColumnOf([STAGE])).toBeNull()
  })
})

describe('a gallery', () => {
  it('a cover is a URL column the view picks, and only an http(s) link', () => {
    expect(coverColumnOf(COLUMNS, 'site')).toBe(SITE)
    expect(coverColumnOf(COLUMNS, 'qty')).toBeNull()
    expect(coverColumnOf(COLUMNS, null)).toBeNull()
    expect(coverUrl(' https://fernhill.example/oak.jpg ')).toBe('https://fernhill.example/oak.jpg')
    expect(coverUrl('javascript:alert(1)')).toBeNull()
    expect(coverUrl(3)).toBeNull()
  })
})
