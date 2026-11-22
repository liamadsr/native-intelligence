import { describe, expect, it } from 'vitest'
import { rewriteStructuredRefs, type TableRefMeta } from '../table-refs'

// Sales on Sheet1: header row 1, data 2..10, total row 11. A=Region, B=Amount, C=Qty.
const sales: TableRefMeta = {
  name: 'Sales',
  sheetName: 'Sheet1',
  range: { r1: 1, c1: 1, r2: 11, c2: 3 },
  columns: ['Region', 'Amount', 'Qty'],
  hasTotals: true,
}
// A second table on another sheet, no totals.
const costs: TableRefMeta = {
  name: 'Costs',
  sheetName: 'Data',
  range: { r1: 1, c1: 2, r2: 5, c2: 3 },
  columns: ['Item', 'Cost'],
  hasTotals: false,
}

const ctx = { sheetName: 'Sheet1', row: 5 }

describe('rewriteStructuredRefs', () => {
  it('leaves a non-formula and a formula with no table reference alone', () => {
    expect(rewriteStructuredRefs('hello', [sales], ctx)).toBe('hello')
    expect(rewriteStructuredRefs('=SUM(A1:A9)', [sales], ctx)).toBe('=SUM(A1:A9)')
  })

  it('rewrites a column reference to its data cells', () => {
    expect(rewriteStructuredRefs('=SUM(Sales[Amount])', [sales], ctx)).toBe('=SUM(B2:B10)')
  })

  it('rewrites the totals and headers specifiers', () => {
    expect(rewriteStructuredRefs('=Sales[[#Totals],[Amount]]', [sales], ctx)).toBe('=B11')
    expect(rewriteStructuredRefs('=Sales[[#Headers],[Qty]]', [sales], ctx)).toBe('=C1')
  })

  it('rewrites whole-table and data-only areas', () => {
    expect(rewriteStructuredRefs('=COUNTA(Sales[#All])', [sales], ctx)).toBe('=COUNTA(A1:C11)')
    expect(rewriteStructuredRefs('=COUNTA(Sales[#Data])', [sales], ctx)).toBe('=COUNTA(A2:C10)')
  })

  it('rewrites a bare table name to its data body', () => {
    expect(rewriteStructuredRefs('=SUM(Sales)', [sales], ctx)).toBe('=SUM(A2:C10)')
  })

  it('rewrites the current-row form only inside the table', () => {
    const inside = { sheetName: 'Sheet1', row: 5, table: sales }
    expect(rewriteStructuredRefs('=[@Qty]*2', [sales], inside)).toBe('=C5*2')
    expect(rewriteStructuredRefs('=[@[Amount]]', [sales], inside)).toBe('=B5')
    // No containing table → #REF!
    expect(rewriteStructuredRefs('=[@Qty]', [sales], ctx)).toBe('=#REF!')
  })

  it('a current-row reference outside the data rows is #REF!', () => {
    const atTotal = { sheetName: 'Sheet1', row: 11, table: sales }
    expect(rewriteStructuredRefs('=[@Qty]', [sales], atTotal)).toBe('=#REF!')
  })

  it('a missing table or column becomes #REF!', () => {
    expect(rewriteStructuredRefs('=Nope[Amount]', [sales], ctx)).toBe('=#REF!')
    expect(rewriteStructuredRefs('=Sales[Missing]', [sales], ctx)).toBe('=#REF!')
  })

  it('does not touch a reference inside a string literal', () => {
    expect(rewriteStructuredRefs('="Sales[Amount]"&Sales[Qty]', [sales], ctx)).toBe('="Sales[Amount]"&C2:C10')
  })

  it('qualifies a cross-sheet table with its sheet name', () => {
    expect(rewriteStructuredRefs('=SUM(Costs[Cost])', [sales, costs], ctx)).toBe('=SUM(Data!C2:C5)')
  })

  it('does not mistake a function call for a table', () => {
    expect(rewriteStructuredRefs('=SUM(Sales[Amount])+AVERAGE(Sales[Qty])', [sales], ctx)).toBe('=SUM(B2:B10)+AVERAGE(C2:C10)')
  })
})
