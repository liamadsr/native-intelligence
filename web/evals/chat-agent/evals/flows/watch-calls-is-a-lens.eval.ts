import { defineEval, type EveEvalToolCall } from 'eve/evals'
import { equals, satisfies } from 'eve/evals/expect'
import { callsOf, ran, writeTrapStubs } from '../safety/shared.js'

/** The lens skills (migration 382) as list_skills shows them, served by a stub so the case doesn't depend on DEV's rows. */
const LENS_SKILLS = {
  skills: [
    { id: 'b0a0af26-be52-493a-a2e4-ea0cb5b6cbbb', slug: 'marketing-lens', name: 'Marketing lens', description: 'Watches external calls for what customers say: objections, competitors, their language, contradictions and testimonial candidates. Keeps the product doc current, at most one batch a day.' },
    { id: '8ef0cb7e-6c81-4da5-9deb-a967dc16aa30', slug: 'content-lens', name: 'Content lens', description: "Watches the person's calls for post-worthy moments in their own words and keeps them for the weekly post pass." },
    { id: '6a1d1c55-0000-4000-8000-000000000001', slug: 'call-summary', name: 'Call summary', description: 'Writes a summary document of a call.' },
  ],
}

type FlowInput = {
  trigger?: { type?: unknown }
  actions?: Array<{ type?: unknown; skill?: unknown }>
}

/** A create_flow on the call trigger whose skill step names a lens. */
function lensFlow(call: EveEvalToolCall): boolean {
  if (call.name !== 'create_flow') return false
  const input = (call.input ?? {}) as FlowInput
  if (input.trigger?.type !== 'capture_processed') return false
  return (input.actions ?? []).some((a) => a.type === 'run_skill' && (a.skill === 'marketing-lens' || a.skill === 'b0a0af26-be52-493a-a2e4-ea0cb5b6cbbb'))
}

/** A call loop that reads the call again with a skill of its own (a second reader). */
function secondReader(call: EveEvalToolCall): boolean {
  if (call.name !== 'create_flow') return false
  const input = (call.input ?? {}) as FlowInput
  return input.trigger?.type === 'capture_processed' && (input.actions ?? []).some((a) => a.type === 'run_skill' && typeof a.skill === 'string' && !/lens/.test(a.skill) && !a.skill.startsWith('b0a0af26') && !a.skill.startsWith('8ef0cb7e'))
}

/**
 * Lens flows (F3, eve-alignment.md §6 decision 6's amendment): "watch my calls
 * for X" is a lens flow that rides Triage's one read of each call, never a
 * new loop that reads every call again. create_flow is stubbed (writeTrapStubs):
 * nothing is saved; the case gates on what the agent asked to build.
 */
export default defineEval({
  description: '"Watch my customer calls for objections" builds a capture_processed flow on the marketing lens, not a second reader.',
  tags: ['flows', 'lenses'],
  async test(t) {
    const session = await t.session({
      stubs: [
        { id: 'no-loops-yet', tool: 'list_flows', outcome: { response: { flows: [] } } },
        { id: 'lens-skills', tool: 'list_skills', outcome: { response: LENS_SKILLS } },
        ...writeTrapStubs(),
      ],
    })
    const turn = await session.send(
      'Watch my customer calls for objections and competitors people mention, and keep our product doc up to date with them. Set it up.',
    )
    t.check(turn, satisfies(ran, 'the turn ran (not failed, not cancelled)'))
    const calls = callsOf([turn])
    // Gate: no second reader of the call.
    t.check(calls.filter(secondReader).map((c) => c.name), equals([])).label('no call loop that re-reads the call with its own skill')
    // Not vacuous: the lens flow was built, or the person was asked first.
    t.check(
      turn,
      satisfies((x: typeof turn) => x.toolCalls.some(lensFlow) || x.inputRequests.length > 0, 'built the marketing-lens flow, or asked the person'),
    )
  },
})
