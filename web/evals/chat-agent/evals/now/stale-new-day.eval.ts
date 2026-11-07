import { defineEval } from 'eve/evals'
import { equals, satisfies } from 'eve/evals/expect'
import { answered, callsOf, writeTrapStubs } from '../safety/shared.js'
import { baseRevisionOf, lineNumberOf, monthDay, nowCalls, nowSectionBody, nowStub, takesLineOff, turnContextBlock, updatedAgo, weekdayMonthDay } from './shared.js'

const REVISION = 21
// Two days back rather than one, so the case holds in any zone the fixture's clock is in.
const PAST = `- Acme renewal call, ${weekdayMonthDay(-2)} 2 pm (${monthDay(-4)})`
const AHEAD = `- Board prep, ${weekdayMonthDay(3)} 10 am (${monthDay(-3)})`
const LINES = [
  '## Focus',
  `- Guest access to PROD this week (${monthDay(-3)})`,
  '',
  '## Coming up',
  PAST,
  AHEAD,
]
const PAST_LINE = lineNumberOf(LINES, PAST)
const AHEAD_LINE = lineNumberOf(LINES, AHEAD)

/**
 * Eval 4 (docs/plans/now-file.md): stale on a new day. The note was last
 * updated days ago and a "Coming up" line names a call that has passed; on
 * the first turn today that line comes off, at the section's revision. The
 * line still ahead stays.
 */
export default defineEval({
  description: "On a new day's first turn a passed Coming up line comes off the Now file, and one still ahead stays.",
  tags: ['now'],
  async test(t) {
    const session = await t.session({ stubs: [nowStub(REVISION), ...writeTrapStubs()] })
    const turn = await session.send("Good morning, I'm starting my day.", {
      clientContext: turnContextBlock([{ key: 'now', body: nowSectionBody({ lines: LINES, revision: REVISION, updated: updatedAgo(50) }) }]),
    })
    t.succeeded()
    t.check(turn, satisfies(answered, 'the turn ran and the agent answered'))
    const calls = nowCalls(callsOf([turn]))
    t.check(calls.some((call) => takesLineOff(call, PAST_LINE, /Acme renewal call/i)), equals(true)).label(`the passed line ${PAST_LINE} comes off`)
    t.check(calls.some((call) => takesLineOff(call, AHEAD_LINE, /Board prep/i)), equals(false)).label(`line ${AHEAD_LINE}, still ahead, stays`)
    t.check(calls.map(baseRevisionOf), equals(calls.map(() => REVISION))).label('every call names the revision it read')
  },
})
