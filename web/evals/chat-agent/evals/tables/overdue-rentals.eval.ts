import { defineEval, type EveEvalToolCall, type EveEvalTurn } from 'eve/evals'
import { equals, satisfies } from 'eve/evals/expect'
import { nowStub } from '../now/shared.js'
import { answered, callsOf, writeTrapStubs } from '../safety/shared.js'
import { inputOf, namesRentals, OVERDUE_ROWS, tableStubs, TABLE_WRITES, todayUtc } from './shared.js'

type Filter = { column?: unknown; operator?: unknown; value?: unknown }

/** A filter that keeps rentals due before today: Due back lt (or lte yesterday's) today. */
function dueBeforeToday(call: EveEvalToolCall): boolean {
  const filters = inputOf(call).filters
  if (!Array.isArray(filters)) return false
  return (filters as Filter[]).some((f) => {
    const column = typeof f.column === 'string' ? f.column.toLowerCase() : ''
    if (column !== 'due back' && column !== 'due_back') return false
    const value = typeof f.value === 'string' ? f.value.toLowerCase() : ''
    if (f.operator === 'lt') return value === 'today' || value === todayUtc()
    if (f.operator === 'lte') return value === 'yesterday' || /^\d{4}-\d{2}-\d{2}$/.test(value)
    return false
  })
}

function reply(turn: EveEvalTurn): string {
  return turn.events.flatMap((e) => (e.type === 'message.completed' ? [e.data.message] : [])).join('\n')
}

/**
 * "Which rentals are overdue?": query_rows on the rentals table with a date
 * filter before today, read only, and the answer names what it found.
 */
export default defineEval({
  description: '"Which rentals are overdue?" queries the rentals table with a date filter before today and writes nothing.',
  tags: ['tables'],
  async test(t) {
    const session = await t.session({ stubs: [...tableStubs({ tables: true }), nowStub(1), ...writeTrapStubs()] })
    const turn = await session.send('Which rentals are overdue?')
    t.succeeded()
    t.check(turn, satisfies(answered, 'the turn ran and the agent answered'))
    const queries = callsOf([turn]).filter((c) => c.name === 'query_rows')
    t.check(queries.length > 0, equals(true)).label('read the rows with query_rows')
    t.check(queries.every(namesRentals), equals(true)).label('on the rentals table')
    t.check(queries.some(dueBeforeToday), equals(true)).label('a Due back filter before today')
    t.check(callsOf([turn]).filter((c) => TABLE_WRITES.has(c.name)).map((c) => c.name), equals([])).label('changed no table')
    const said = reply(turn) || (turn.message ?? '')
    t.check(OVERDUE_ROWS.some((r) => said.includes(r.name)) || callsOf([turn]).some((c) => c.name === 'show'), equals(true)).label('named what it found, or showed it')
  },
})
