import { describe, expect, it } from 'vitest'
import {
  addChart,
  addCheckboxes,
  addImage,
  clearValidationIn,
  defaultTableStyle,
  describeValidation,
  emptyExtras,
  extrasAreEmpty,
  imageBytesUsed,
  isCheckbox,
  nextTableName,
  passesBound,
  putTable,
  putValidation,
  readExtras,
  removeCheckboxesIn,
  removeImage,
  shiftExtras,
  subtractRange,
  tableNameProblem,
  validationAt,
  type ListValidation,
  type WorkbookChart,
  type WorkbookImage,
  type WorkbookTable,
} from '../extras'
import type { CellRange } from '../a1'

const table = (over: Partial<WorkbookTable> = {}): WorkbookTable => ({
  id: 't1',
  sheetId: 0,
  name: 'Table1',
  range: { r1: 1, c1: 1, r2: 5, c2: 3 },
  columns: [{ name: 'A', type: 'text' }, { name: 'B', type: 'number' }, { name: 'C', type: 'number' }],
  style: defaultTableStyle(),
  filters: {},
  ...over,
})

const R = (r1: number, c1: number, r2: number, c2: number): CellRange => ({ r1, c1, r2, c2 })
const list = (reject = true): ListValidation => ({ type: 'list', choices: [{ value: 'Yes' }, { value: 'No' }], reject })

describe('readExtras', () => {
  it('drops what it does not understand and keeps what it does', () => {
    const extras = readExtras({
      v: 99,
      validations: [
        { sheetId: 1, range: { r1: 1, c1: 1, r2: 2, c2: 2 }, rule: { type: 'list', choices: [{ value: 'A', color: '#1A73E8' }], reject: true } },
        { sheetId: 1, range: { r1: 1, c1: 1, r2: 2, c2: 2 }, rule: { type: 'mystery' } }, // dropped: bad rule
        { sheetId: 1, rule: { type: 'list', choices: [{ value: 'X' }] } }, // dropped: no range
      ],
      checkboxes: [{ sheetId: 2, range: { r1: 3, c1: 3, r2: 3, c2: 3 } }],
      gremlins: [1, 2, 3],
    })
    expect(extras.v).toBe(1)
    expect(extras.validations).toHaveLength(1)
    expect((extras.validations[0].rule as ListValidation).choices[0].color).toBe('#1A73E8')
    expect(extras.checkboxes).toHaveLength(1)
    expect((extras as unknown as Record<string, unknown>).gremlins).toBeUndefined()
  })

  it('reads junk as empty extras', () => {
    expect(extrasAreEmpty(readExtras(null))).toBe(true)
    expect(extrasAreEmpty(readExtras('nope'))).toBe(true)
    expect(extrasAreEmpty(readExtras({}))).toBe(true)
  })

  it('normalizes an out-of-order range', () => {
    const extras = readExtras({ checkboxes: [{ sheetId: 0, range: { r1: 5, c1: 4, r2: 2, c2: 1 } }] })
    expect(extras.checkboxes[0].range).toEqual({ r1: 2, c1: 1, r2: 5, c2: 4 })
  })
})

describe('subtractRange', () => {
  it('returns the four pieces around a hole', () => {
    const pieces = subtractRange(R(1, 1, 5, 5), R(2, 2, 3, 3))
    // top, bottom, left-middle, right-middle
    expect(pieces).toHaveLength(4)
    // every cell of the original except the hole is covered exactly once
    const covered = new Set<string>()
    for (const p of pieces) for (let r = p.r1; r <= p.r2; r++) for (let c = p.c1; c <= p.c2; c++) covered.add(`${r},${c}`)
    expect(covered.size).toBe(25 - 4)
    expect(covered.has('2,2')).toBe(false)
  })

  it('returns the whole rectangle when there is no overlap', () => {
    expect(subtractRange(R(1, 1, 2, 2), R(5, 5, 6, 6))).toEqual([R(1, 1, 2, 2)])
  })

  it('returns nothing when fully covered', () => {
    expect(subtractRange(R(2, 2, 3, 3), R(1, 1, 5, 5))).toEqual([])
  })
})

describe('validations', () => {
  it('a new rule carves its range out of an overlapping one', () => {
    let extras = putValidation(emptyExtras(), 7, R(1, 1, 4, 4), list())
    extras = putValidation(extras, 7, R(2, 2, 3, 3), { type: 'list', choices: [{ value: 'Mid' }], reject: false })
    // The inner cell has the new rule; a corner of the old range keeps the old rule.
    expect((validationAt(extras, 7, 2, 2)!.rule as ListValidation).choices[0].value).toBe('Mid')
    expect((validationAt(extras, 7, 1, 1)!.rule as ListValidation).choices[0].value).toBe('Yes')
    expect(validationAt(extras, 7, 2, 2)!.rule.reject).toBe(false)
  })

  it('clears validation in a range, leaving the pieces outside it', () => {
    let extras = putValidation(emptyExtras(), 0, R(1, 1, 3, 1), list())
    extras = clearValidationIn(extras, 0, R(2, 1, 2, 1))
    expect(validationAt(extras, 0, 1, 1)).not.toBeNull()
    expect(validationAt(extras, 0, 2, 1)).toBeNull()
    expect(validationAt(extras, 0, 3, 1)).not.toBeNull()
  })
})

describe('checkboxes', () => {
  it('adds and removes, by range', () => {
    let extras = addCheckboxes(emptyExtras(), 0, R(1, 1, 1, 3))
    expect(isCheckbox(extras, 0, 1, 2)).toBe(true)
    expect(isCheckbox(extras, 0, 2, 2)).toBe(false)
    extras = removeCheckboxesIn(extras, 0, R(1, 2, 1, 2))
    expect(isCheckbox(extras, 0, 1, 1)).toBe(true)
    expect(isCheckbox(extras, 0, 1, 2)).toBe(false)
    expect(isCheckbox(extras, 0, 1, 3)).toBe(true)
  })
})

describe('shiftExtras', () => {
  it('moves ranges down when rows are inserted above them', () => {
    const extras = addCheckboxes(emptyExtras(), 0, R(5, 2, 6, 2))
    const next = shiftExtras(extras, { type: 'insertRows', sheetId: 0, at: 3, count: 2 })
    expect(next.checkboxes[0].range).toEqual(R(7, 2, 8, 2))
  })

  it('does not move ranges above the insert point, or on another sheet', () => {
    const extras = addCheckboxes(addCheckboxes(emptyExtras(), 0, R(1, 1, 1, 1)), 1, R(5, 1, 5, 1))
    const next = shiftExtras(extras, { type: 'insertRows', sheetId: 0, at: 3, count: 1 })
    expect(next.checkboxes.find((b) => b.sheetId === 0)!.range).toEqual(R(1, 1, 1, 1))
    expect(next.checkboxes.find((b) => b.sheetId === 1)!.range).toEqual(R(5, 1, 5, 1))
  })

  it('shrinks a range that straddles deleted rows and drops one wholly inside', () => {
    let extras = putValidation(emptyExtras(), 0, R(2, 1, 8, 1), list())
    extras = addCheckboxes(extras, 0, R(4, 1, 5, 1))
    const next = shiftExtras(extras, { type: 'deleteRows', sheetId: 0, at: 4, count: 2 })
    expect(next.validations[0].range).toEqual(R(2, 1, 6, 1)) // 8 - 2
    expect(next.checkboxes).toHaveLength(0) // 4..5 removed entirely
  })

  it('shifts and shrinks columns too', () => {
    const extras = addCheckboxes(emptyExtras(), 0, R(1, 5, 1, 8))
    expect(shiftExtras(extras, { type: 'insertColumns', sheetId: 0, at: 2, count: 1 }).checkboxes[0].range).toEqual(R(1, 6, 1, 9))
    expect(shiftExtras(extras, { type: 'deleteColumns', sheetId: 0, at: 1, count: 4 }).checkboxes[0].range).toEqual(R(1, 1, 1, 4))
  })

  it('drops a deleted sheet and copies a duplicated one', () => {
    const extras = addCheckboxes(emptyExtras(), 3, R(1, 1, 1, 1))
    expect(shiftExtras(extras, { type: 'deleteSheet', sheetId: 3 }).checkboxes).toHaveLength(0)
    const dup = shiftExtras(extras, { type: 'duplicateSheet', fromId: 3, toId: 9 })
    expect(dup.checkboxes.map((b) => b.sheetId).sort()).toEqual([3, 9])
  })
})

describe('tables in extras', () => {
  it('names the next table and refuses a bad or taken name', () => {
    let extras = emptyExtras()
    expect(nextTableName(extras)).toBe('Table1')
    extras = putTable(extras, table({ id: 't1', name: 'Table1' }))
    expect(nextTableName(extras)).toBe('Table2')
    expect(tableNameProblem('Table1', extras)).toMatch(/already/)
    expect(tableNameProblem('2bad', extras)).toMatch(/starts with a letter/)
    expect(tableNameProblem('Table1', extras, 't1')).toBeNull()
  })

  it('shifts a table down when rows are inserted above it', () => {
    const extras = putTable(emptyExtras(), table({ range: { r1: 5, c1: 1, r2: 8, c2: 3 } }))
    const next = shiftExtras(extras, { type: 'insertRows', sheetId: 0, at: 2, count: 2 })
    expect(next.tables[0].range).toEqual({ r1: 7, c1: 1, r2: 10, c2: 3 })
  })

  it('adds a column when one is inserted inside it and drops one when deleted', () => {
    const extras = putTable(emptyExtras(), table())
    const inserted = shiftExtras(extras, { type: 'insertColumns', sheetId: 0, at: 2, count: 1 })
    expect(inserted.tables[0].columns).toHaveLength(4)
    expect(inserted.tables[0].range.c2).toBe(4)
    const deleted = shiftExtras(extras, { type: 'deleteColumns', sheetId: 0, at: 2, count: 1 })
    expect(deleted.tables[0].columns.map((c) => c.name)).toEqual(['A', 'C'])
  })

  it('drops a table on sheet delete and copies it on duplicate', () => {
    const extras = putTable(emptyExtras(), table({ sheetId: 3 }))
    expect(shiftExtras(extras, { type: 'deleteSheet', sheetId: 3 }).tables).toHaveLength(0)
    const dup = shiftExtras(extras, { type: 'duplicateSheet', fromId: 3, toId: 9 })
    expect(dup.tables.map((t) => t.sheetId).sort()).toEqual([3, 9])
  })

  it('putTable replaces a table in place and drops a table it overlaps', () => {
    let extras = putTable(emptyExtras(), table({ id: 't1', range: { r1: 1, c1: 1, r2: 3, c2: 3 } }))
    extras = putTable(extras, table({ id: 't1', name: 'Renamed' }))
    expect(extras.tables).toHaveLength(1)
    expect(extras.tables[0].name).toBe('Renamed')
  })
})

describe('charts and images in extras', () => {
  const chart = (over: Partial<WorkbookChart> = {}): WorkbookChart => ({
    id: 'c1', sheetId: 0, type: 'column', title: '', legend: true, source: { r1: 2, c1: 1, r2: 4, c2: 2 }, anchor: { row: 2, column: 4, dx: 0, dy: 0 }, width: 400, height: 280, ...over,
  })
  const image = (over: Partial<WorkbookImage> = {}): WorkbookImage => ({ id: 'i1', sheetId: 0, hash: 'h1', anchor: { row: 3, column: 3, dx: 0, dy: 0 }, width: 100, height: 80, ...over })

  it('shifts a chart source and anchor on an insert', () => {
    const extras = addChart(emptyExtras(), chart())
    const next = shiftExtras(extras, { type: 'insertRows', sheetId: 0, at: 1, count: 2 })
    expect(next.charts[0].source).toEqual({ r1: 4, c1: 1, r2: 6, c2: 2 })
    expect(next.charts[0].anchor.row).toBe(4)
  })

  it('shifts an image anchor and clamps it when its row is deleted', () => {
    const extras = addImage(emptyExtras(), image({ anchor: { row: 6, column: 3, dx: 0, dy: 0 } }), 'data:image/png;base64,AAAA')
    expect(shiftExtras(extras, { type: 'insertRows', sheetId: 0, at: 2, count: 1 }).images[0].anchor.row).toBe(7)
    expect(shiftExtras(extras, { type: 'deleteRows', sheetId: 0, at: 5, count: 3 }).images[0].anchor.row).toBe(5)
  })

  it('stores a blob once and drops it when the last image using it goes', () => {
    let extras = addImage(emptyExtras(), image({ id: 'i1', hash: 'h1' }), 'data:image/png;base64,AAAA')
    extras = addImage(extras, image({ id: 'i2', hash: 'h1' }), 'data:image/png;base64,AAAA')
    expect(Object.keys(extras.imageBlobs)).toHaveLength(1)
    expect(imageBytesUsed(extras)).toBeGreaterThan(0)
    extras = removeImage(extras, 'i1')
    expect(extras.imageBlobs.h1).toBeDefined() // still used by i2
    extras = removeImage(extras, 'i2')
    expect(extras.imageBlobs.h1).toBeUndefined()
  })

  it('readExtras keeps typed tables, charts and images and drops junk', () => {
    const extras = readExtras({
      tables: [{ id: 't', sheetId: 0, name: 'T', range: { r1: 1, c1: 1, r2: 2, c2: 2 }, columns: [{ name: 'A', type: 'number' }], style: {}, filters: { '0': { values: ['x'] } } }, { nope: true }],
      charts: [{ id: 'c', sheetId: 0, type: 'pie', source: { r1: 1, c1: 1, r2: 2, c2: 1 }, anchor: { row: 1, column: 1 }, width: 300, height: 200 }],
      images: [{ id: 'i', sheetId: 0, hash: 'h', anchor: { row: 1, column: 1 }, width: 10, height: 10 }],
      imageBlobs: { h: 'data:image/png;base64,AAAA', orphan: 'data:image/png;base64,BBBB' },
    })
    expect(extras.tables).toHaveLength(1)
    expect(extras.charts[0].type).toBe('pie')
    expect(extras.images).toHaveLength(1)
    expect(Object.keys(extras.imageBlobs)).toEqual(['h']) // orphan blob dropped
    expect(extrasAreEmpty(extras)).toBe(false)
  })
})

describe('bound rules', () => {
  it('checks the operators', () => {
    expect(passesBound(5, { type: 'number', operator: 'between', min: '1', max: '10', reject: true })).toBe(true)
    expect(passesBound(50, { type: 'number', operator: 'between', min: '1', max: '10', reject: true })).toBe(false)
    expect(passesBound(5, { type: 'number', operator: 'greaterThan', min: '4', reject: true })).toBe(true)
    expect(passesBound(5, { type: 'number', operator: 'lessThan', min: '4', reject: true })).toBe(false)
    expect(describeValidation({ type: 'number', operator: 'greaterThan', min: '4', reject: true })).toContain('greater than 4')
  })
})
