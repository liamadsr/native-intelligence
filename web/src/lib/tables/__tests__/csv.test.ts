import { describe, expect, it } from 'vitest'
import { parseCsv } from '@/lib/crm/import/sources/spreadsheet'
import { csvField, exportCsv, exportFileName, guessColumnType, IMPORT_MAX_ROWS, importOps, planImport } from '../csv'
import { planUndo, validateOps } from '../ops'
import type { DataChange, DataColumn, DataRow } from '../types'

const TABLE = '00000000-0000-4000-8000-0000000000a1'
const col = (key: string, label: string, field_type: DataColumn['field_type'], extra: Partial<DataColumn> = {}): DataColumn => ({
  id: `c-${key}`,
  table_id: TABLE,
  key,
  label,
  field_type,
  options: [],
  config: {},
  position: 0,
  deleted_at: null,
  ...extra,
})

const FILE = `Name,Stage,Value,Close date,Email,Won,Notes
Bayside Bakery,Lead,"$1,200.00",3/4/2026,orders@bayside.example,no,"Asked for a quote, then went quiet"
Copper Kettle,Proposal,850,2026-04-01,hello@kettle.example,yes,
Fernhill Studio,Lead,lots,2026-05-10,studio@fernhill.example,no,Big one
Granite & Co,Won,4000,2026-02-20,team@granite.example,yes,
Harbor Florist,Lead,300,2026-06-01,hi@harbor.example,no,
`

describe('CSV import: read and map', () => {
  const sheet = parseCsv(FILE)

  it('reads the file with the contact import’s reader', () => {
    expect(sheet.headers).toEqual(['Name', 'Stage', 'Value', 'Close date', 'Email', 'Won', 'Notes'])
    expect(sheet.rows).toHaveLength(5)
    expect(sheet.rows[0][6]).toBe('Asked for a quote, then went quiet')
  })

  it('guesses a new column’s type from its values', () => {
    expect(guessColumnType('Won', ['no', 'yes', 'no'])).toEqual({ field_type: 'checkbox' })
    expect(guessColumnType('Qty', ['1', '2,000', '3.5'])).toEqual({ field_type: 'number' })
    expect(guessColumnType('Price', ['$12', '€3.50'])).toEqual({ field_type: 'currency' })
    expect(guessColumnType('When', ['3/4/2026', '2026-04-01'])).toEqual({ field_type: 'date' })
    expect(guessColumnType('Email', ['a@b.example', 'c@d.example'])).toEqual({ field_type: 'email' })
    expect(guessColumnType('Site', ['https://a.example', 'www.b.example'])).toEqual({ field_type: 'url' })
    expect(guessColumnType('Mobile', ['(555) 010-0100', '555-010-0199'])).toEqual({ field_type: 'phone' })
    expect(guessColumnType('Stage', ['Lead', 'Won', 'Lead', 'Lead', 'Won'])).toEqual({ field_type: 'select', options: ['Lead', 'Won'] })
    expect(guessColumnType('Zip', ['02134', '10001'])).toEqual({ field_type: 'text' })
    expect(guessColumnType('Notes', [])).toEqual({ field_type: 'text' })
  })

  it('maps Name to the row’s name, a known column by its name, the rest to new columns', () => {
    const columns = [col('stage', 'Stage', 'select', { options: ['Lead', 'Proposal', 'Won'] }), col('total', 'Total', 'formula', { config: { expression: '1' } })]
    const targets = planImport(sheet, columns)
    expect(targets[0]).toEqual({ kind: 'title' })
    expect(targets[1]).toEqual({ kind: 'column', key: 'stage' })
    expect(targets[2]).toEqual({ kind: 'new', label: 'Value', field_type: 'text' })
    expect(targets[3]).toEqual({ kind: 'new', label: 'Close date', field_type: 'date' })
    expect(targets[4]).toMatchObject({ kind: 'new', field_type: 'email' })
    expect(targets[5]).toMatchObject({ kind: 'new', field_type: 'checkbox' })
  })
})

describe('CSV import: one batch', () => {
  const sheet = parseCsv(FILE)
  const columns = [col('stage', 'Stage', 'select', { options: ['Lead', 'Proposal', 'Won'] })]
  const targets = planImport(sheet, columns).map((t, i) => (i === 2 ? { kind: 'new' as const, label: 'Value', field_type: 'currency' as const } : t))

  it('makes the new columns, then the rows; a cell that doesn’t fit stays empty and is counted', () => {
    const r = importOps(sheet, targets, columns)
    if (!r.ok) throw new Error(r.error)
    const { plan } = r
    expect(plan.rows).toBe(5)
    expect(plan.ops.filter((o) => o.op === 'create_column').map((o) => (o as { key: string }).key)).toEqual(['value', 'close_date', 'email', 'won', 'notes'])
    const inserts = plan.ops.filter((o) => o.op === 'insert_rows')
    expect(inserts).toHaveLength(1)
    const first = (inserts[0] as { rows: Array<{ title?: string; values?: Record<string, unknown> }> }).rows[0]
    expect(first).toEqual({
      title: 'Bayside Bakery',
      values: { stage: 'Lead', value: { amount: 1200, currency: 'USD' }, close_date: '2026-03-04', email: 'orders@bayside.example', won: false, notes: 'Asked for a quote, then went quiet' },
    })
    expect(plan.misfits).toEqual([{ header: 'Value', count: 1, example: 'lots' }])
    // The batch is one the write path takes as it is.
    expect(validateOps(columns, plan.ops)).toMatchObject({ ok: true })
  })

  it('a new column’s key never takes one the table used, deleted columns too', () => {
    const r = importOps(sheet, targets, [...columns, col('value', 'Old value', 'text', { deleted_at: '2026-01-01' })])
    if (!r.ok) throw new Error(r.error)
    expect(r.plan.ops.find((o) => o.op === 'create_column')).toMatchObject({ key: 'value_2', label: 'Value' })
  })

  it('caps the rows, splits them into inserts of 1000, and refuses two names', () => {
    const big = { headers: ['Name'], rows: Array.from({ length: IMPORT_MAX_ROWS + 7 }, (_, i) => [`Row ${i}`]) }
    const r = importOps(big, [{ kind: 'title' }], [])
    if (!r.ok) throw new Error(r.error)
    expect(r.plan.rows).toBe(IMPORT_MAX_ROWS)
    expect(r.plan.over).toBe(7)
    expect(r.plan.ops.map((o) => (o.op === 'insert_rows' ? o.rows.length : 0))).toEqual([1000, 1000, 1000, 1000, 1000])
    expect(validateOps([], r.plan.ops)).toMatchObject({ ok: true })
    expect(importOps(big, [{ kind: 'title' }, { kind: 'title' }], [])).toMatchObject({ ok: false })
    expect(importOps({ headers: ['A', 'B'], rows: [['x', 'y']] }, [{ kind: 'title' }, { kind: 'title' }], [])).toEqual({ ok: false, error: 'Only one column of the file can be the row’s name.' })
  })

  it('a row a required-when rule would refuse comes in without the option, counted, never refusing the file', () => {
    const cols = [col('stage', 'Stage', 'select', { options: ['Lead', 'Won'] }), col('close', 'Close date', 'date', { config: { required_when: { key: 'stage', option: 'Won' } } })]
    const r = importOps(
      { headers: ['Name', 'Stage', 'Close date'], rows: [['A', 'Won', '2026-02-01'], ['B', 'Won', ''], ['C', 'Lead', ''], ['D', 'Won', 'soon']] },
      [{ kind: 'title' }, { kind: 'column', key: 'stage' }, { kind: 'column', key: 'close' }],
      cols,
    )
    if (!r.ok) throw new Error(r.error)
    const rows = (r.plan.ops.find((o) => o.op === 'insert_rows') as { rows: Array<{ title: string; values?: Record<string, unknown> }> }).rows
    expect(rows.map((x) => x.values ?? {})).toEqual([{ stage: 'Won', close: '2026-02-01' }, {}, { stage: 'Lead' }, {}])
    expect(r.plan.held).toEqual([{ select: 'Stage', option: 'Won', needs: 'Close date', count: 2, example: 'B' }])
    expect(r.plan.misfits).toEqual([{ header: 'Close date', count: 1, example: 'soon' }])
    expect(validateOps(cols, r.plan.ops)).toMatchObject({ ok: true })
  })

  it('never writes into a formula, and skips blank lines', () => {
    const cols = [col('total', 'Total', 'formula', { config: { expression: '1' } })]
    expect(importOps({ headers: ['Total'], rows: [['3']] }, [{ kind: 'column', key: 'total' }], cols)).toMatchObject({ ok: false })
    const r = importOps({ headers: ['Name'], rows: [['A'], [' '], ['B']] }, [{ kind: 'title' }], [])
    expect(r.ok && r.plan.rows).toBe(2)
  })

  it('one Undo takes the whole import back: rows archived, new columns removed', () => {
    const rowIds = Array.from({ length: 1500 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`)
    const change: Pick<DataChange, 'changes' | 'undo_of' | 'undone_at'> = {
      undo_of: null,
      undone_at: null,
      changes: [
        { op: 'create_column', key: 'value', column_id: 'c1', label: 'Value', field_type: 'currency', options: [] },
        { op: 'insert_rows', row_ids: rowIds.slice(0, 1000) },
        { op: 'insert_rows', row_ids: rowIds.slice(1000) },
      ],
    }
    const plan = planUndo(change, {
      table: { name: 'Leads', icon: null, description: null, visibility: 'workspace', archived_at: null },
      isOwner: true,
      columns: [{ key: 'value', label: 'Value', field_type: 'currency', options: [], deleted_at: null, position: 0 }],
      rows: new Map(rowIds.map((id, i) => [id, { title: `Row ${i}`, custom_fields: {}, archived_at: null, position: String(i + 1) }])),
    })
    if (!plan.ok) throw new Error(plan.error)
    // Each archive within the database's 1000 a op.
    expect(plan.ops.map((o) => (o.op === 'archive_rows' ? o.row_ids.length : o.op))).toEqual([500, 1000, 'delete_column'])
  })
})

describe('CSV export', () => {
  const columns = [
    col('stage', 'Stage', 'select', { options: ['Lead'] }),
    col('value', 'Value', 'currency', { config: { currency: 'USD' } }),
    col('due', 'Due', 'date'),
    col('won', 'Won', 'checkbox'),
    col('owner', 'Owner', 'person'),
    col('note', 'Note', 'text'),
    col('total', 'With tax', 'formula', { config: { expression: '1' }, computed: { result: 'number' } }),
    col('broken', 'Broken', 'formula', { config: { expression: '1' }, computed: { result: null, error: 'x' } }),
  ]
  const row = (title: string, custom_fields: DataRow['custom_fields'], computed: DataRow['computed'] = {}): DataRow => ({ id: title, table_id: TABLE, title, custom_fields, computed, position: 1, archived_at: null, created_at: '', updated_at: '' })

  it('writes the shown columns, each value as it reads', () => {
    const csv = exportCsv(
      [
        row('Bayside, Inc.', { stage: 'Lead', value: { amount: 1200, currency: 'USD' }, due: '2026-03-04', won: true, owner: 'm1', note: 'Said "yes"' }, { total: { value: 1440 } }),
        row('Copper Kettle', { won: false, note: '=HYPERLINK("x")' }, { total: { error: 'Division by zero.' } }),
      ],
      columns,
      { m1: 'Robin Vale' },
    )
    expect(csv.split('\r\n')).toEqual([
      'Name,Stage,Value,Due,Won,Owner,Note,With tax,Broken',
      '"Bayside, Inc.",Lead,"$1,200.00",2026-03-04,Yes,Robin Vale,"Said ""yes""",1440,#ERROR',
      `Copper Kettle,,,,No,,"'=HYPERLINK(""x"")",#ERROR,#ERROR`,
      '',
    ])
  })

  it('a column’s name that would run as a spreadsheet formula is made safe in the header too', () => {
    const csv = exportCsv([], [col('evil', '=HYPERLINK("http://x.example")', 'text'), col('neg', '-Margin', 'number')], {})
    expect(csv.split('\r\n')[0]).toBe(`Name,"'=HYPERLINK(""http://x.example"")",'-Margin`)
  })

  it('quotes only where a field needs it, and names the file safely', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a\nb')).toBe('"a\nb"')
    expect(csvField(' padded')).toBe('" padded"')
    expect(exportFileName('Leads / 2026', 'Hot: this week')).toBe('Leads 2026 - Hot this week.csv')
    expect(exportFileName('', null)).toBe('Table.csv')
  })
})
