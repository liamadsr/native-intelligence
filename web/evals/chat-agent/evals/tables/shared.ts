/**
 * Shared pieces of the Tables evals (Tables phase 5, src/lib/ai/tools/tables.ts):
 * a made-up rentals table and stubs for every table tool, so a case reads the
 * table it is given and writes nothing real. The cases check what the agent
 * asked the tools to do. No judge, no score (decision 19).
 */
import type { EveEvalToolCall, ToolStub } from 'eve/evals'

export const RENTALS_ID = '7a1d4c2e-0000-4000-8000-00000000e501'
export const ROW_ID = '7a1d4c2e-0000-4000-8000-00000000e511'
export const CHANGE_ID = '7a1d4c2e-0000-4000-8000-00000000e521'

/** The rentals table as find_tables lists it. */
const RENTALS_LISTED = {
  id: RENTALS_ID,
  name: 'Equipment rentals',
  visibility: 'workspace',
  columns: ['Name (each row\'s name)', 'Item (text)', 'Rented by (text)', 'Due back (date)', 'Status (select)', 'Deposit (currency)'],
}

/** The rentals table as get_table reads it. */
const RENTALS_FULL = {
  id: RENTALS_ID,
  name: 'Equipment rentals',
  visibility: 'workspace',
  row_count: 3,
  columns: [
    { name: 'Name', type: 'title', note: "each row's name" },
    { name: 'Item', key: 'item', type: 'text' },
    { name: 'Rented by', key: 'rented_by', type: 'text' },
    { name: 'Due back', key: 'due_back', type: 'date' },
    { name: 'Status', key: 'status', type: 'select', options: ['Out', 'Returned'] },
    { name: 'Deposit', key: 'deposit', type: 'currency', currency: 'USD' },
  ],
  views: [],
  can_edit: true,
}

/** Two rentals past their day, as query_rows returns them. */
export const OVERDUE_ROWS = [
  { id: '7a1d4c2e-0000-4000-8000-00000000e512', name: 'Pressure washer', values: { Item: 'Pressure washer', 'Rented by': 'Harbor Lane Cafe', 'Due back': '2026-11-02', Status: 'Out' } },
  { id: '7a1d4c2e-0000-4000-8000-00000000e513', name: 'Scaffold tower', values: { Item: 'Scaffold tower', 'Rented by': 'Quill & Fern', 'Due back': '2026-11-05', Status: 'Out' } },
]

const ok = (response: Record<string, unknown>) => ({ response: { success: true, stubbed: true, ...response } })

/**
 * Every table tool, stubbed. `tables`: whether find_tables finds the rentals
 * table (false: there are none yet).
 */
export function tableStubs(opts: { tables: boolean }): ToolStub[] {
  return [
    { id: 'tables-find', tool: 'find_tables', outcome: ok(opts.tables ? { count: 1, tables: [RENTALS_LISTED] } : { count: 0, tables: [], note: 'There are no tables yet.' }) },
    { id: 'tables-get', tool: 'get_table', outcome: ok(opts.tables ? { table: RENTALS_FULL, recent_changes: [] } : { success: false, error: 'No table named that. There are no tables yet: create_table makes one.' }) },
    {
      id: 'tables-create',
      tool: 'create_table',
      outcome: ok({ table: { id: RENTALS_ID, name: 'Equipment rentals', rows: 0 }, message: 'Made the table.' }),
    },
    {
      id: 'tables-write',
      tool: 'write_rows',
      outcome: ok({ table: { id: RENTALS_ID, name: 'Equipment rentals' }, change_id: CHANGE_ID, added_row_ids: [ROW_ID], message: 'In Equipment rentals: added "Robin". The person can undo it.' }),
    },
    { id: 'tables-query', tool: 'query_rows', outcome: ok({ table: { id: RENTALS_ID, name: 'Equipment rentals' }, count: OVERDUE_ROWS.length, rows: OVERDUE_ROWS }) },
    {
      id: 'tables-undo',
      tool: 'undo_table_change',
      outcome: ok({ table: { id: RENTALS_ID, name: 'Equipment rentals' }, undone_change_id: CHANGE_ID, restored: ['the new row'], kept: [], message: 'Undone in Equipment rentals: the new row.' }),
    },
    { id: 'tables-columns', tool: 'update_table_columns', outcome: ok({ change_id: '7a1d4c2e-0000-4000-8000-00000000e522', message: 'Columns changed.' }) },
    { id: 'tables-archive', tool: 'archive_rows', outcome: ok({ change_id: '7a1d4c2e-0000-4000-8000-00000000e523', message: 'Archived.' }) },
  ]
}

/** The tables the agent may write in these cases: the table tools, nothing else. */
export const TABLE_WRITES: ReadonlySet<string> = new Set(['create_table', 'update_table_columns', 'write_rows', 'archive_rows', 'undo_table_change'])

/** A call's input as a plain record. */
export function inputOf(call: EveEvalToolCall): Record<string, unknown> {
  const input = call.input
  return input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {}
}

/** The call names the table: by the stubbed id, or a name with "rental" in it. */
export function namesRentals(call: EveEvalToolCall): boolean {
  const table = inputOf(call).table
  return typeof table === 'string' && (table === RENTALS_ID || /rental/i.test(table))
}

/** YYYY-MM-DD for today, in UTC (the fixture's turns carry no zone). */
export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}
