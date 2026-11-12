import { defineEval } from 'eve/evals'
import { equals, satisfies } from 'eve/evals/expect'
import { nowStub } from '../now/shared.js'
import { answered, callsOf, writeTrapStubs } from '../safety/shared.js'
import { CHANGE_ID, inputOf, namesRentals, tableStubs } from './shared.js'

/**
 * "Undo that" after a row the agent just added: undo_table_change on the
 * rentals table, taking back that change (its change_id, or the table's
 * latest), and no new write to undo it by hand. Every table tool is stubbed.
 */
export default defineEval({
  description: '"Undo that" after adding a row takes back that change with undo_table_change.',
  tags: ['tables'],
  async test(t) {
    const session = await t.session({ stubs: [...tableStubs({ tables: true }), nowStub(1), ...writeTrapStubs()] })
    const first = await session.send("Add Robin's order to the rentals table: a tile saw, due back on 2026-11-20.")
    const undo = await session.send('Actually, undo that.')
    t.succeeded()
    t.check(first, satisfies(answered, 'the first turn ran and the agent answered'))
    t.check(callsOf([first]).some((c) => c.name === 'write_rows'), equals(true)).label('the first turn wrote the row')
    t.check(undo, satisfies(answered, 'the undo turn ran and the agent answered'))
    const undos = callsOf([undo]).filter((c) => c.name === 'undo_table_change')
    t.check(undos.length, equals(1)).label('one undo')
    t.check(undos.every(namesRentals), equals(true)).label('on the rentals table')
    t.check(
      undos.every((c) => inputOf(c).change_id === undefined || inputOf(c).change_id === CHANGE_ID),
      equals(true),
    ).label('that change: its change_id, or the latest')
    t.check(callsOf([undo]).filter((c) => c.name === 'write_rows' || c.name === 'archive_rows').map((c) => c.name), equals([])).label('not undone by hand with another write')
  },
})
