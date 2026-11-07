import { defineEval } from 'eve/evals'
import { satisfies } from 'eve/evals/expect'
import { answered, writeTrapStubs } from '../safety/shared.js'
import { BODIES } from './bodies.js'
import { contextFirst, NOW_STUB } from './shared.js'

const STUBBED = { success: true, stubbed: true, note: 'eval stub: nothing ran' }

/**
 * Rule (a), beyond a guest's ask (Liam, 2026-10-27: "it's not giving me any
 * context"): what happened outside the chat is news to the person, so a
 * background update that needs them leads with who or what it came from and
 * what it was, before it asks or says what was done.
 *   - an event: mail from someone they know that needs a reply;
 *   - a helper's report with a question only they can answer.
 * The updates are the server's own text (./bodies.ts). Starting a helper or
 * messaging an agent is stubbed; every other write is a trap.
 */
export default defineEval({
  description: 'A background update that needs the person names who or what it came from and what it was before it asks.',
  tags: ['updates'],
  async test(t) {
    const stubs = [
      { id: 'helper', tool: 'start_helper', outcome: { response: { ...STUBBED, run_id: 'run-eval-stub', work_item_id: 'wi-eval-stub', model: 'haiku', queued: true } } },
      { id: 'agent', tool: 'ask_agent', outcome: { response: STUBBED } },
      NOW_STUB,
      ...writeTrapStubs(),
    ]

    const event = await (await t.session({ stubs })).send(BODIES.event)
    t.check(event, satisfies(answered, 'the person was told (mail that needs a reply)'))
    t.check(event.message ?? '', satisfies((m: string) => contextFirst(m, [/rita|globex/i, /contract|sow/i]), 'names Rita or Globex and the contract before asking')).label('event: who and what, first')

    const report = await (await t.session({ stubs })).send(BODIES.helperQuestion)
    t.check(report, satisfies(answered, 'the person was asked (only they can answer)'))
    t.check(report.message ?? '', satisfies((m: string) => contextFirst(m, [/initech/i, /proposal/i]), 'names the Initech proposal before asking')).label('helper question: which work, first')
    t.check(report.message ?? '', satisfies((m: string) => /growth/i.test(m) && /enterprise/i.test(m), 'asks the question it was asked')).label('helper question: the question itself')
  },
})
