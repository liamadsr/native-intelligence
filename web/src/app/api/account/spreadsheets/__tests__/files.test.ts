/**
 * The export and import routes: a workbook out as .xlsx or a sheet out as CSV
 * (the right content type, a safe filename), and a new spreadsheet in from an
 * uploaded .xlsx or .csv (201 with its warnings), with the refusals. Auth is
 * mocked and the database is the in-memory stand-in, as the other route tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { readJson } from '@/test/integration'
import { memoryDb } from '@/test/memory-db'
import { loadModel, newModel } from '@/lib/spreadsheets/engine-server'
import { saveWorkbook } from '@/lib/spreadsheets/workbook'
import { workbookToXlsx } from '@/lib/spreadsheets/xlsx-write'

const WS = 'ws-1'
const ME = 'm-1'
const S = '33333333-3333-4333-8333-333333333333'

const hoisted = vi.hoisted(() => ({ requireWorkspaceMember: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: hoisted.requireWorkspaceMember }))

const { GET: exportRoute } = await import('@/app/api/account/spreadsheets/[id]/export/route')
const { POST: importRoute } = await import('@/app/api/account/spreadsheets/import/route')

type Row = Record<string, unknown>
let rows: Row[]
let tables: { spreadsheet: Row[] }

function workbookWith(cells: Array<[number, number, string]>, sheet2?: string): string {
  const m = newModel()
  for (const [r, c, v] of cells) m.setUserInput(0, r, c, v)
  if (sheet2) {
    m.newSheet()
    m.renameSheet(1, sheet2)
    m.setUserInput(1, 1, 1, 'Second')
  }
  m.evaluate()
  const saved = saveWorkbook(m)
  m.free()
  return saved
}

function seed(workbook: string) {
  rows = [
    {
      id: S, workspace_id: WS, title: 'Q1 "budget"', created_by: ME, last_edited_by: ME, visibility: 'workspace',
      status: 'active', revision: 2, sheet_names: ['Sheet1'], digest: '', workbook, extras: {},
      created_at: '2026-11-20T10:00:00Z', updated_at: '2026-11-20T10:00:00Z',
    },
  ]
  tables = { spreadsheet: rows }
  hoisted.requireWorkspaceMember.mockResolvedValue({ supabase: memoryDb(tables), user: { id: 'u-1' }, workspaceId: WS, member: { id: ME } })
}

const getReq = (url: string) => ({ nextUrl: new URL(url) }) as unknown as NextRequest
const ctx = (id = S) => ({ params: Promise.resolve({ id }) })
const base = 'https://x.test/api/account/spreadsheets'

beforeEach(() => seed(workbookWith([[1, 1, 'Item'], [1, 2, 'Qty'], [2, 1, 'Widgets'], [2, 2, '=20+22']], 'Notes')))

describe('GET /api/account/spreadsheets/[id]/export', () => {
  it('exports the whole workbook as a valid .xlsx that reopens', async () => {
    const res = await exportRoute(getReq(`${base}/${S}/export?format=xlsx`), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    expect(res.headers.get('content-disposition')).toContain('.xlsx')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes.subarray(0, 2))).toEqual([0x50, 0x4b]) // "PK"
    const m = loadModel(undefined)
    m.free()
  })

  it('defaults to xlsx when no format is given', async () => {
    const res = await exportRoute(getReq(`${base}/${S}/export`), ctx())
    expect(res.headers.get('content-type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  it('exports one sheet as CSV with a BOM and the shown values, not the formula', async () => {
    const res = await exportRoute(getReq(`${base}/${S}/export?format=csv&sheet=0`), ctx())
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(Array.from(bytes.subarray(0, 3))).toEqual([0xef, 0xbb, 0xbf]) // a UTF-8 BOM, for Excel
    const text = new TextDecoder('utf-8').decode(bytes).replace(/^﻿/, '')
    expect(text).toContain('Item,Qty')
    expect(text).toContain('Widgets,42')
    expect(text).not.toContain('=20+22')
  })

  it('404s an unknown id and 400s a format it does not know or a missing sheet', async () => {
    expect((await exportRoute(getReq(`${base}/x/export`), ctx('44444444-4444-4444-8444-444444444444'))).status).toBe(404)
    expect((await exportRoute(getReq(`${base}/x/export`), ctx('not-an-id'))).status).toBe(404)
    expect((await exportRoute(getReq(`${base}/${S}/export?format=pdf`), ctx())).status).toBe(400)
    expect((await exportRoute(getReq(`${base}/${S}/export?format=csv&sheet=9`), ctx())).status).toBe(400)
  })
})

function upload(file: File, title?: string): NextRequest {
  const form = new FormData()
  form.set('file', file)
  if (title) form.set('title', title)
  return new Request(`${base}/import`, { method: 'POST', body: form }) as unknown as NextRequest
}

describe('POST /api/account/spreadsheets/import', () => {
  it('makes a new spreadsheet from an uploaded .xlsx and answers its warnings', async () => {
    const m = newModel()
    m.setUserInput(0, 1, 1, 'Imported cell')
    m.setUserInput(0, 1, 2, '=2+3')
    m.evaluate()
    const bytes = await workbookToXlsx(m)
    m.free()
    const file = new File([new Uint8Array(bytes)], 'plan.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })

    const res = await importRoute(upload(file))
    expect(res.status).toBe(201)
    const json = await readJson<{ spreadsheet: Row; warnings: string[] }>(res)
    expect(json.spreadsheet.title).toBe('plan')
    expect(Array.isArray(json.warnings)).toBe(true)
    const created = tables.spreadsheet.find((r) => r.id === json.spreadsheet.id)!
    const back = loadModel(created.workbook as string)
    expect(back.getFormattedCellValue(0, 1, 1)).toBe('Imported cell')
    expect(back.getFormattedCellValue(0, 1, 2)).toBe('5')
    back.free()
  })

  it('makes a new spreadsheet from a CSV, keeping a leading = as text, with the given title', async () => {
    const csv = 'Name,Amount\r\nAcme,100\r\n=danger,"two\nlines"'
    const file = new File([csv], 'contacts.csv', { type: 'text/csv' })
    const res = await importRoute(upload(file, 'My import'))
    expect(res.status).toBe(201)
    const json = await readJson<{ spreadsheet: Row }>(res)
    expect(json.spreadsheet.title).toBe('My import')
    const created = tables.spreadsheet.find((r) => r.id === json.spreadsheet.id)!
    const back = loadModel(created.workbook as string)
    expect(back.getFormattedCellValue(0, 1, 1)).toBe('Name')
    expect(back.getFormattedCellValue(0, 2, 2)).toBe('100')
    expect(back.getFormattedCellValue(0, 3, 1)).toBe('=danger') // kept as text, not a formula
    expect(back.getCellContent(0, 3, 2)).toBe('two\nlines')
    back.free()
  })

  it('refuses a file that is not a spreadsheet, and a request with no file', async () => {
    const bad = new File([new Uint8Array([1, 2, 3, 4, 5, 6])], 'notes.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    expect((await importRoute(upload(bad))).status).toBe(400)
    const empty = new Request(`${base}/import`, { method: 'POST', body: new FormData() }) as unknown as NextRequest
    expect((await importRoute(empty)).status).toBe(400)
  })
})
