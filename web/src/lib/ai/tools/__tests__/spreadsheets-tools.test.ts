/**
 * The agent's spreadsheet tools (Spreadsheets, phase 3): registered in the
 * Spreadsheets category, fenced to what the person can read (a workspace
 * workbook, or their own private one), reading and calculating on a throwaway
 * copy, and editing in one all-or-nothing batch against the revision read.
 * Fixtures use made-up names and numbers.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { loadModel } from '@/lib/spreadsheets/engine-server'
import { blankWorkbook } from '@/lib/spreadsheets/store'
import { saveWorkbook } from '@/lib/spreadsheets/workbook'
import { createSpreadsheetTools, SPREADSHEET_TOOL_NAMES } from '../spreadsheets'
import { TOOL_CATEGORIES, getToolDefinition } from '../../tool-registry'

const WS = '11111111-1111-4111-8111-111111111111'
const ME = 'u-1'
const M1 = 'm-1'
const M2 = 'm-2'
const PLAN = '33333333-3333-4333-8333-333333333333'
const SECRET = '55555555-5555-4555-8555-555555555555'

type Row = Record<string, unknown>
let rows: Row[]
let tables: Record<string, Row[]>

/** Sheet1 with a label, two numbers and a formula over them. */
function workbookWith(cells: Array<[number, number, string]>): string {
  const m = loadModel(null)
  for (const [r, c, v] of cells) m.setUserInput(0, r, c, v)
  m.evaluate()
  const saved = saveWorkbook(m)
  m.free()
  return saved
}

const PLAN_CELLS: Array<[number, number, string]> = [
  [1, 1, 'Revenue'],
  [1, 2, '10'],
  [2, 2, '20'],
  [3, 2, '=B1+B2'],
]

function seed() {
  rows = [
    {
      id: PLAN, workspace_id: WS, title: 'Q1 budget', created_by: M1, last_edited_by: M1, visibility: 'workspace',
      status: 'active', revision: 1, sheet_names: ['Sheet1'], digest: '', workbook: workbookWith(PLAN_CELLS), extras: {},
      created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z',
    },
    {
      id: SECRET, workspace_id: WS, title: 'Salaries', created_by: M2, last_edited_by: M2, visibility: 'private',
      status: 'active', revision: 1, sheet_names: ['Sheet1'], digest: '', workbook: blankWorkbook(), extras: {},
      created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z',
    },
  ]
  tables = {
    spreadsheet: rows,
    member: [
      { id: M1, workspace_id: WS, user_id: ME, role: 'member', display_name: 'Avery Stone' },
      { id: M2, workspace_id: WS, user_id: 'u-2', role: 'member', display_name: 'Jamie Park' },
    ],
  }
}

const tools = () => createSpreadsheetTools(ME, memoryDb(tables), WS) as Record<string, unknown>
const call = async (name: string, input: Record<string, unknown>) =>
  (await (tools()[name] as { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(input, {})) as Record<string, unknown>

beforeEach(() => seed())

describe('where they are registered', () => {
  it('are exactly SPREADSHEET_TOOL_NAMES, all in the Spreadsheets category', () => {
    expect(Object.keys(tools()).sort()).toEqual([...SPREADSHEET_TOOL_NAMES].sort())
    const category = TOOL_CATEGORIES.find((c) => c.id === 'spreadsheets')!
    const inCategory = new Set(category.tools.map((t) => t.name))
    for (const name of SPREADSHEET_TOOL_NAMES) {
      expect(getToolDefinition(name), name).toBeDefined()
      expect(inCategory.has(name), name).toBe(true)
    }
    expect(category.label).toBe('Spreadsheets')
  })

  it('classifies the reads and the writes', () => {
    for (const name of ['find_spreadsheets', 'read_spreadsheet', 'calculate_spreadsheet']) {
      expect(getToolDefinition(name)!.sideEffect, name).toBe('read')
    }
    for (const name of ['create_spreadsheet', 'edit_spreadsheet']) {
      const def = getToolDefinition(name)!
      expect(def.sideEffect, name).toBe('internal-write')
      expect(def.writeTarget, name).toBe('artifact')
    }
  })
})

describe('the fence', () => {
  it('finds only the spreadsheets the person may read', async () => {
    const res = await call('find_spreadsheets', {})
    expect(res.success).toBe(true)
    expect((res.spreadsheets as Row[]).map((s) => s.id)).toEqual([PLAN])
  })

  it('is "not found" for another member\'s private spreadsheet, on read, calculate and edit', async () => {
    for (const [name, input] of [
      ['read_spreadsheet', { id: SECRET }],
      ['calculate_spreadsheet', { id: SECRET, formulas: ['=1'] }],
      ['edit_spreadsheet', { id: SECRET, expected_revision: 1, operations: [{ op: 'set_cells', start: 'A1', rows: [['x']] }] }],
    ] as const) {
      const res = await call(name, input)
      expect(res.success, name).toBe(false)
      expect(String(res.error), name).toContain('No spreadsheet')
    }
  })
})

describe('read_spreadsheet', () => {
  it('summarises every sheet: used range, counts and a sample', async () => {
    const res = await call('read_spreadsheet', { id: PLAN })
    expect(res.success).toBe(true)
    expect(res.revision).toBe(1)
    const sheet = (res.sheets as Row[])[0]
    expect(sheet.name).toBe('Sheet1')
    expect(sheet.used_range).toBe('A1:B3')
    expect(sheet.filled_cells).toBe(4)
    expect(sheet.formula_cells).toBe(1)
    expect(sheet.error_cells).toBe(0)
  })

  it('reads ranges cell by cell, formulas as typed, with optional styles', async () => {
    const res = await call('read_spreadsheet', { id: PLAN, ranges: ['A1:B3'], include_styles: true })
    const cells = (res.ranges as Array<{ cells: Row[] }>)[0].cells
    const b3 = cells.find((c) => c.cell === 'B3')!
    expect(b3.input).toBe('=B1+B2')
    expect(b3.text).toBe('30')
    expect(b3.kind).toBe('number')
    expect((b3.styles as Row).number_format).toBeDefined()
  })

  it('caps the cells read and says truncated', async () => {
    // 20 columns x 30 rows = 600 empty cells; with include_styles each counts.
    const res = await call('read_spreadsheet', { id: PLAN, ranges: ['A1:T30'], include_styles: true })
    expect(res.truncated).toBe(true)
    const cells = (res.ranges as Array<{ cells: Row[] }>)[0].cells
    expect(cells.length).toBe(500)
  })
})

describe('calculate_spreadsheet', () => {
  it('evaluates formulas against the workbook and saves nothing', async () => {
    const before = rows[0].workbook
    const res = await call('calculate_spreadsheet', { id: PLAN, formulas: ['=SUM(Sheet1!B1:B2)', '=B1+B2'] })
    expect(res.success).toBe(true)
    const results = res.results as Array<{ value: string; kind: string }>
    expect(results[0]).toMatchObject({ value: '30', kind: 'number' })
    expect(rows[0].workbook).toBe(before)
    expect(rows[0].sheet_names).toEqual(['Sheet1'])
  })

  it('applies what-if overrides first', async () => {
    const res = await call('calculate_spreadsheet', { id: PLAN, formulas: ['=SUM(Sheet1!B1:B2)'], overrides: [{ cell: 'Sheet1!B1', value: '100' }] })
    expect((res.results as Array<{ value: string }>)[0].value).toBe('120')
    expect(rows[0].sheet_names).toEqual(['Sheet1'])
  })
})

describe('edit_spreadsheet', () => {
  it('runs every operation in one batch and bumps the stored workbook', async () => {
    const res = await call('edit_spreadsheet', {
      id: PLAN,
      expected_revision: 1,
      summary: 'Build it out',
      operations: [
        { op: 'set_cells', start: 'D1', rows: [['Tag'], ['=B1*2']] },
        { op: 'clear_cells', range: 'A1', what: 'values' },
        { op: 'format_cells', range: 'D1', bold: true, number_format: '0.00', horizontal_align: 'center' },
        { op: 'set_borders', range: 'D1:D2', borders: 'outer' },
        { op: 'fill_cells', source: 'B1:B2', to: 'B6' },
        { op: 'append_rows', rows: [['Added', '99']] },
        { op: 'resize_columns', columns: 'A:B', width: 120 },
        { op: 'insert_rows', at: 1, count: 1 },
        { op: 'insert_columns', at: 1, count: 1 },
        { op: 'delete_rows', at: 1, count: 1 },
        { op: 'delete_columns', at: 1, count: 1 },
        { op: 'add_sheet', name: 'Notes' },
        { op: 'duplicate_sheet', sheet: 'Notes' },
        { op: 'rename_sheet', sheet: 'Notes', name: 'Scratch' },
        { op: 'delete_sheet', sheet: 'Scratch' },
      ],
    })
    expect(res.success, JSON.stringify(res)).toBe(true)
    expect((res.operations as unknown[]).length).toBe(15)
    expect(rows[0].workbook).not.toBe(workbookWith(PLAN_CELLS))
    expect(rows[0].edit_source).toBe('agent')
    expect(rows[0].edit_summary).toBe('Build it out')
    expect(rows[0].last_edited_by).toBe(M1)
  })

  it('is all-or-nothing: a failing operation names its index and saves nothing', async () => {
    const before = rows[0].workbook
    const res = await call('edit_spreadsheet', {
      id: PLAN,
      expected_revision: 1,
      operations: [
        { op: 'set_cells', start: 'A1', rows: [['ok']] },
        { op: 'set_cells', start: 'ZZ', rows: [['bad']] },
      ],
    })
    expect(res.success).toBe(false)
    expect(res.failed_operation).toBe(1)
    expect(rows[0].workbook).toBe(before)
  })

  it('refuses a stale revision and returns the current one', async () => {
    rows[0].revision = 4
    const res = await call('edit_spreadsheet', { id: PLAN, expected_revision: 1, operations: [{ op: 'set_cells', start: 'A1', rows: [['late']] }] })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('Read it again')
    expect(res.revision).toBe(4)
  })

  it('refuses more than 25 operations', async () => {
    const operations = Array.from({ length: 26 }, (_, i) => ({ op: 'set_cells', start: `A${i + 1}`, rows: [['x']] }))
    const res = await call('edit_spreadsheet', { id: PLAN, expected_revision: 1, operations })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('25 operations')
  })

  it('refuses more than 2,000 affected cells', async () => {
    const before = rows[0].workbook
    const line = Array.from({ length: 2001 }, (_, i) => String(i))
    const res = await call('edit_spreadsheet', { id: PLAN, expected_revision: 1, operations: [{ op: 'set_cells', start: 'A1', rows: [line] }] })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('2000')
    expect(rows[0].workbook).toBe(before)
  })

  it('keeps the record’s existing extras (an agent save must not wipe validation or checkboxes)', async () => {
    rows[0].extras = { v: 1, validations: [{ sheetId: 0, range: { r1: 1, c1: 1, r2: 1, c2: 1 }, rule: { type: 'list', choices: [{ value: 'Yes' }], reject: true } }], checkboxes: [] }
    const before = JSON.stringify(rows[0].extras)
    const res = await call('edit_spreadsheet', { id: PLAN, expected_revision: 1, operations: [{ op: 'set_cells', start: 'C1', rows: [['hi']] }] })
    expect(res.success).toBe(true)
    expect(JSON.stringify(rows[0].extras)).toBe(before)
  })

  it('warns about a cell this call wrote that now shows an error', async () => {
    const res = await call('edit_spreadsheet', { id: PLAN, expected_revision: 1, operations: [{ op: 'set_cells', start: 'A5', rows: [['=1/0']] }] })
    expect(res.success).toBe(true)
    const warnings = res.warnings as Array<{ cell: string; error: string }>
    expect(warnings).toHaveLength(1)
    expect(warnings[0].cell).toBe('Sheet1!A5')
    expect(warnings[0].error).toContain('#DIV/0')
  })
})

describe('create_spreadsheet', () => {
  it('makes a workbook filled from sheets, as the caller', async () => {
    const res = await call('create_spreadsheet', {
      title: 'Forecast',
      sheets: [{ name: 'Model', rows: [['Price', '12'], ['Qty', '3'], ['Total', '=B1*B2']] }],
    })
    expect(res.success, JSON.stringify(res)).toBe(true)
    const made = rows.find((r) => r.title === 'Forecast')!
    expect(made.created_by).toBe(M1)
    expect(made.edit_source).toBe('agent')
    expect(made.sheet_names).toEqual(['Model'])
    const m = loadModel(made.workbook as string)
    m.evaluate()
    expect(m.getFormattedCellValue(0, 3, 2)).toBe('36')
    m.free()
  })
})
