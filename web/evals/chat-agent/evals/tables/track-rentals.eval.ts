import { defineEval, type EveEvalToolCall } from 'eve/evals'
import { equals, satisfies } from 'eve/evals/expect'
import { nowStub } from '../now/shared.js'
import { answered, callsOf, writeTrapStubs } from '../safety/shared.js'
import { inputOf, tableStubs, TABLE_WRITES } from './shared.js'

type Column = { name?: unknown; type?: unknown; options?: unknown }

function columnsOf(call: EveEvalToolCall): Column[] {
  const columns = inputOf(call).columns
  return Array.isArray(columns) ? (columns as Column[]) : []
}

/** A sensible rentals table: named for rentals, a date column for when it's due back, a status or returned column. */
function sensible(call: EveEvalToolCall): boolean {
  const name = inputOf(call).name
  const columns = columnsOf(call)
  const hasDate = columns.some((c) => c.type === 'date')
  const hasState = columns.some((c) => c.type === 'select' || c.type === 'checkbox')
  return typeof name === 'string' && /rent/i.test(name) && columns.length >= 3 && hasDate && hasState
}

/**
 * The first moment (Tables phase 5): "track my equipment rentals in a table"
 * makes one table, after looking for one already there, with typed columns
 * (a date for when it's due back, a select or a checkbox for whether it's
 * back). Every table tool is stubbed: nothing is saved.
 */
export default defineEval({
  description: '"Track my equipment rentals in a table" makes one sensible table with typed columns.',
  tags: ['tables'],
  async test(t) {
    const session = await t.session({ stubs: [...tableStubs({ tables: false }), nowStub(1), ...writeTrapStubs()] })
    const turn = await session.send(
      "Track my equipment rentals in a table for me: what was rented, who has it, when it's due back, the deposit, and whether it's back yet.",
    )
    t.succeeded()
    t.check(turn, satisfies(answered, 'the turn ran and the agent answered'))
    const calls = callsOf([turn])
    const creates = calls.filter((c) => c.name === 'create_table')
    t.check(creates.length, equals(1)).label('made exactly one table')
    t.check(calls.some((c) => c.name === 'find_tables'), equals(true)).label('looked for a table already there first')
    t.check(creates.every(sensible), equals(true)).label('named for rentals, with a date column and a status (select or checkbox)')
    t.check(
      creates.flatMap(columnsOf).some((c) => c.type === 'currency' || c.type === 'number'),
      equals(true),
    ).label('the deposit is an amount')
    t.check(calls.filter((c) => TABLE_WRITES.has(c.name) && c.name !== 'create_table').map((c) => c.name), equals([])).label('wrote nothing else to tables')
  },
})
