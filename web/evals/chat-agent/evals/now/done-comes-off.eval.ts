import { defineEval } from 'eve/evals'
import { equals, satisfies } from 'eve/evals/expect'
import { answered, callsOf, writeTrapStubs } from '../safety/shared.js'
import { baseRevisionOf, editsOf, lineNumberOf, monthDay, nowCalls, nowSectionBody, nowStub, takesLineOff, turnContextBlock, updatedAgo } from './shared.js'

const REVISION = 11
const DECK = `- Drafting the Acme deck (${monthDay(0)})`
const LINES = [
  '## Focus',
  `- Close the Acme renewal this week (${monthDay(0)})`,
  '',
  '## In flight',
  DECK,
  `- Asked Sarah's agent for a Thursday time (${monthDay(0)})`,
]
const DECK_LINE = lineNumberOf(LINES, DECK)

/**
 * Eval 3 (docs/plans/now-file.md): done means off the list. "Drafting the
 * Acme deck" is in flight and the person says it went out: update_now takes
 * that line off by its number (a remove or a replace, or a rewrite without
 * it), at the section's revision, and never adds the deck again.
 */
export default defineEval({
  description: 'A finished item comes off the Now file: a remove or replace of its line, not an add.',
  tags: ['now'],
  async test(t) {
    const session = await t.session({ stubs: [nowStub(REVISION), ...writeTrapStubs()] })
    const turn = await session.send('The Acme deck went out this morning.', {
      clientContext: turnContextBlock([{ key: 'now', body: nowSectionBody({ lines: LINES, revision: REVISION, updated: updatedAgo(0.5) }) }]),
    })
    t.succeeded()
    t.check(turn, satisfies(answered, 'the turn ran and the agent answered'))
    const calls = nowCalls(callsOf([turn]))
    t.check(calls.some((call) => takesLineOff(call, DECK_LINE, /Drafting the Acme deck/i)), equals(true)).label(`line ${DECK_LINE} comes off`)
    t.check(calls.flatMap(editsOf).filter((e) => e.op === 'add' && /acme deck/i.test(e.text ?? '')).length, equals(0)).label('the deck is never added')
    t.check(calls.map(baseRevisionOf), equals(calls.map(() => REVISION))).label('every call names the revision it read')
  },
})
