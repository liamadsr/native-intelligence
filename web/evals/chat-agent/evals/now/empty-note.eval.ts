import { defineEval } from 'eve/evals'
import { equals, satisfies } from 'eve/evals/expect'
import { answered, callsOf, writeTrapStubs } from '../safety/shared.js'
import { editsOf, nowCalls, nowStub } from './shared.js'

/** "I can't see / read / open it", "I don't have a tool that reads it": the PROD 10-27 answer. */
const CANT_SEE = /\b(can(?:'|’)?t|cannot|unable to|no way to|don(?:'|’)?t have (?:a |any )?(?:tool|way|access))\b[^.]{0,40}\b(see|read|open|access|view|reads?)\b/i
/** It says there is nothing in it yet. */
const EMPTY = /\b(empty|blank|nothing(?: is)? (?:in it|written|there|yet)|haven(?:'|’)?t (?:written|started)|not (?:started|written)|no (?:lines|notes) yet)\b/i

/**
 * The Now file is empty (PROD 10-27: no note had ever been written, the app
 * sent no `now` section at all, and the agent told the person it couldn't
 * read a note that didn't exist). The fixture has no note of its own, so the
 * app's own turn-context block carries the empty section, as on PROD; nothing
 * is seeded here. update_now is stubbed: nothing real is written.
 *
 * Turn 1: asked what's in it, the agent says it's empty, never that it can't
 * see it, and writes nothing (it knows nothing yet). Turn 2: a stated focus
 * starts the note: one update_now whose add goes under Focus.
 */
export default defineEval({
  description: 'An empty Now file: the agent says it is empty (never that it cannot see it), then starts it from a stated focus.',
  tags: ['now'],
  async test(t) {
    const session = await t.session({ stubs: [nowStub(0), ...writeTrapStubs()] })
    const asked = await session.send("What's in your Now notes about me right now?")
    t.succeeded()
    t.check(asked, satisfies(answered, 'the turn ran and the agent answered'))
    const answer = asked.message ?? ''
    t.check(answer, satisfies((text: string) => !CANT_SEE.test(text), "never says it can't see or read the note"))
    t.check(answer, satisfies((text: string) => EMPTY.test(text), "says the note is empty: nothing's written yet"))
    t.check(nowCalls(callsOf([asked])).length, equals(0)).label('the question writes nothing')

    const focus = await session.send('This week is all about shipping the Northwind launch page.')
    t.check(focus, satisfies(answered, 'the turn ran and the agent answered'))
    const calls = nowCalls(callsOf([focus]))
    t.check(calls.length, equals(1)).label('one update_now starts the note')
    const adds = calls.flatMap(editsOf).filter((e) => e.op === 'add' && e.section === 'Focus' && /northwind/i.test(e.text ?? ''))
    t.check(adds.length, satisfies((n: number) => n > 0, 'an add under Focus names the Northwind launch page'))
  },
})
