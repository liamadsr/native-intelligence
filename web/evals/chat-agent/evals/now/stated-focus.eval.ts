import { defineEval } from 'eve/evals'
import { equals, satisfies } from 'eve/evals/expect'
import { answered, callsOf, writeTrapStubs } from '../safety/shared.js'
import { editsOf, monthDay, nowCalls, nowSectionBody, nowStub, turnContextBlock, updatedAgo } from './shared.js'

const REVISION = 6
const LINES = [
  '## In flight',
  `- Asked Sarah's agent for a Thursday time (${monthDay(0)})`,
  '',
  '## Coming up',
  `- Acme renewal call, next week (${monthDay(0)})`,
]

/**
 * Eval 1 (docs/plans/now-file.md): a focus the person states is the picture
 * changing. One update_now, with an add under Focus that names it. The note
 * in context has no Focus yet, so nothing there needs replacing.
 */
export default defineEval({
  description: 'A stated focus goes into the Now file: one update_now with an add under Focus.',
  tags: ['now'],
  async test(t) {
    const session = await t.session({ stubs: [nowStub(REVISION), ...writeTrapStubs()] })
    const turn = await session.send('This week is all about getting guest access to PROD.', {
      clientContext: turnContextBlock([{ key: 'now', body: nowSectionBody({ lines: LINES, revision: REVISION, updated: updatedAgo(0.5) }) }]),
    })
    t.succeeded()
    t.check(turn, satisfies(answered, 'the turn ran and the agent answered'))
    const calls = nowCalls(callsOf([turn]))
    t.check(calls.length, equals(1)).label('one update_now')
    const focus = calls.flatMap(editsOf).filter((e) => e.op === 'add' && e.section === 'Focus' && /guest access/i.test(e.text ?? ''))
    t.check(focus.length, satisfies((n: number) => n > 0, 'an add under Focus names guest access'))
  },
})
