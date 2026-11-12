import { defineEval, type EveEvalToolCall } from 'eve/evals'
import { equals, satisfies } from 'eve/evals/expect'
import { nowStub } from '../now/shared.js'
import { answered, callsOf, writeTrapStubs } from '../safety/shared.js'
import { inputOf, namesRentals, tableStubs } from './shared.js'

type Row = { id?: unknown; match?: unknown; name?: unknown; values?: Record<string, unknown> }

function rowsOf(call: EveEvalToolCall): Row[] {
  const rows = inputOf(call).rows
  return Array.isArray(rows) ? (rows as Row[]) : []
}

/** The row names Robin, its tile saw, and a due date as YYYY-MM-DD under the table's own column. */
function robinsOrder(row: Row): boolean {
  const text = JSON.stringify(row)
  const due = row.values ? Object.entries(row.values).find(([k]) => k.toLowerCase() === 'due back' || k === 'due_back') : undefined
  return /robin/i.test(text) && /saw/i.test(text) && !!due && typeof due[1] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(due[1])
}

/**
 * "Add Robin's order to the rentals table": one write_rows on the rentals
 * table, a new row (no id, no match), values by the table's column names.
 * Every table tool is stubbed.
 */
export default defineEval({
  description: '"Add Robin\'s order to the rentals table" writes one new row by column name.',
  tags: ['tables'],
  async test(t) {
    const session = await t.session({ stubs: [...tableStubs({ tables: true }), nowStub(1), ...writeTrapStubs()] })
    const turn = await session.send("Add Robin's order to the rentals table: a tile saw, due back on 2026-11-20, $50 deposit.")
    t.succeeded()
    t.check(turn, satisfies(answered, 'the turn ran and the agent answered'))
    const writes = callsOf([turn]).filter((c) => c.name === 'write_rows')
    t.check(writes.length, equals(1)).label('one batch')
    t.check(writes.every(namesRentals), equals(true)).label('on the rentals table')
    const rows = writes.flatMap(rowsOf)
    t.check(rows.length, equals(1)).label('one row')
    t.check(rows.every((r) => r.id === undefined && r.match === undefined), equals(true)).label('a new row, not a change to one')
    t.check(rows.every(robinsOrder), equals(true)).label("Robin's tile saw, due back as a date under Due back")
    t.check(callsOf([turn]).some((c) => c.name === 'create_table'), equals(false)).label('no second table')
  },
})
