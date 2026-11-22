import { describe, expect, it } from 'vitest'
import {
  MAX_COLUMNS,
  MAX_ROWS,
  cellName,
  columnName,
  columnNumber,
  orderRange,
  parseCell,
  parseRange,
  parseSheetRange,
  quoteSheetName,
  rangeCellCount,
  rangeName,
  sheetNameProblem,
} from '../a1'

describe('column names', () => {
  it('counts A to XFD', () => {
    expect([1, 26, 27, 52, 53, 702, 703, 16384].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD'])
    expect(['a', 'Z', 'aa', 'XFD'].map(columnNumber)).toEqual([1, 26, 27, 16384])
  })

  it('round-trips every column', () => {
    for (let c = 1; c <= MAX_COLUMNS; c += 37) expect(columnNumber(columnName(c))).toBe(c)
  })

  it('refuses what is not a column', () => {
    expect(columnName(0)).toBe('')
    expect(['', 'A1', 'XFE', 'ABCD', '1'].map(columnNumber)).toEqual([0, 0, 0, 0, 0])
  })
})

describe('cells and ranges', () => {
  it('reads a cell with or without dollar signs', () => {
    expect(parseCell('B7')).toEqual({ row: 7, column: 2 })
    expect(parseCell(' $aa$10 ')).toEqual({ row: 10, column: 27 })
    expect(parseCell('A0')).toBeNull()
    expect(parseCell(`A${MAX_ROWS + 1}`)).toBeNull()
    expect(parseCell('A1:B2')).toBeNull()
  })

  it('reads a range in any corner order', () => {
    expect(parseRange('C9:A1')).toEqual({ r1: 1, c1: 1, r2: 9, c2: 3 })
    expect(parseRange('B2')).toEqual({ r1: 2, c1: 2, r2: 2, c2: 2 })
  })

  it('reads whole columns and whole rows to the grid’s edge', () => {
    expect(parseRange('B:D')).toEqual({ r1: 1, c1: 2, r2: MAX_ROWS, c2: 4 })
    expect(parseRange('5:2')).toEqual({ r1: 2, c1: 1, r2: 5, c2: MAX_COLUMNS })
    expect(parseRange('A:1')).toBeNull()
    expect(parseRange('A1:B2:C3')).toBeNull()
    expect(parseRange('')).toBeNull()
  })

  it('names what it reads', () => {
    expect(cellName(3, 28)).toBe('AB3')
    expect(rangeName(orderRange({ row: 4, column: 2 }, { row: 1, column: 1 }))).toBe('A1:B4')
    expect(rangeName({ r1: 2, c1: 2, r2: 2, c2: 2 })).toBe('B2')
    expect(rangeCellCount({ r1: 1, c1: 1, r2: 4, c2: 2 })).toBe(8)
  })
})

describe('sheet names', () => {
  it('quotes a name a formula could not read bare', () => {
    expect(quoteSheetName('Sheet1')).toBe('Sheet1')
    expect(quoteSheetName('Q3 plan')).toBe("'Q3 plan'")
    expect(quoteSheetName("Dana's")).toBe("'Dana''s'")
    expect(quoteSheetName('2026')).toBe("'2026'")
  })

  it('reads a range on a named sheet', () => {
    expect(parseSheetRange("'Q3 plan'!A1:B2")).toEqual({ sheet: 'Q3 plan', range: { r1: 1, c1: 1, r2: 2, c2: 2 } })
    expect(parseSheetRange("'Dana''s'!C3")?.sheet).toBe("Dana's")
    expect(parseSheetRange('A1')).toEqual({ sheet: null, range: { r1: 1, c1: 1, r2: 1, c2: 1 } })
    expect(parseSheetRange('Sheet1!nope')).toBeNull()
  })

  it('holds a name to Excel’s rules', () => {
    expect(sheetNameProblem('Costs')).toBeNull()
    expect(sheetNameProblem('  ')).toMatch(/needs a name/)
    expect(sheetNameProblem('x'.repeat(32))).toMatch(/31/)
    expect(sheetNameProblem('a/b')).toMatch(/cannot contain/)
    expect(sheetNameProblem("'x")).toMatch(/apostrophe/)
    expect(sheetNameProblem('costs', ['Costs'])).toMatch(/already/)
  })
})
