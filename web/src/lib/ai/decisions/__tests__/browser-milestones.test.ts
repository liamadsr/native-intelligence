import { describe, expect, it } from 'vitest'
import { browserInputSchema, browserNext, type BrowserInput } from '../tasks/browser-next'
import { browserEvaluation } from './browser-evaluation-result'

const input = browserInputSchema.parse({
  task: { goal: 'Show one-way JFK to LAX flights on October 6, 2026.',
    bindings: [{ name: 'origin', value: 'JFK' }, { name: 'destination', value: 'LAX' }],
    milestones: [{ goal: 'The selected origin is JFK, with the picker closed.', bindingNames: ['origin'] },
      { goal: 'Actual matching flights for all requested constraints and prices are visible.', bindingNames: ['destination'] }],
    completion: [] }, history: [], milestoneIndex: 0,
  observation: { protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 1, interactionEpoch: 0,
    observedAt: 1, url: 'https://example.com/flights', title: 'Flights', text: 'Origin JFK\nDestination\nDeparture',
    elements: [{ ref: 'e1', role: 'combobox', name: 'Origin', value: 'JFK', canType: true, disabled: false,
      sensitive: false, forbidden: false, context: '', destination: '' }] },
})
const answer = (fixture: BrowserInput, operation = 'escalate', completion = 'complete', target = 'e1_b0') =>
  browserEvaluation(fixture, { operation: { choice: operation }, completion: { choice: completion }, type: { choice: target } })

describe('browser milestone contract', () => {
  it('exposes only the active milestone bindings and rejects a forged later binding', () => {
    const prepared = browserNext.prepare(input)!
    expect(JSON.parse(prepared.state).task.activeMilestone).toEqual({ index: 0, ...input.task.milestones![0] })
    expect(prepared.questions.type).toMatchObject({ criteria: { e1_b0: expect.any(String) } })
    expect(prepared.questions.type).not.toHaveProperty('criteria.e1_b1')
    expect(browserNext.accept(answer(input, 'type', 'incomplete', 'e1_b1'), input)).toBeNull()
  })
  it('checks semantic completion without requiring invented literal text, and advances rather than completing the task', () => {
    expect(browserNext.prepare(input)!.questions.completion).toBeDefined()
    expect(browserNext.accept(answer(input), input)).toEqual({ operation: 'advance' })
    expect(browserNext.accept(answer(input, 'escalate', 'incomplete'), input)).toEqual({ operation: 'escalate' })
  })
  it('requires independent whole-goal verification at the final milestone', () => {
    const final = { ...input, milestoneIndex: 1 }
    expect(browserNext.prepare(final)!.questions.completion.instructions).toContain('ENTIRE task.goal and the final active milestone')
    expect(browserNext.accept(answer(final, 'escalate', 'incomplete'), final)).toEqual({ operation: 'escalate' })
    const low = answer(final)
    low.providerMetadata!.typesafe = { confidence: { operation: .99, completion: .79 } }
    expect(browserNext.accept(low, final)).toBeNull()
    expect(browserNext.accept(answer(final), final)).toEqual({ operation: 'done' })
  })
  it('retains grounded literal constraints even after semantic verification', () => {
    const final = { ...input, milestoneIndex: 1, task: { ...input.task, completion: [{ kind: 'text' as const, value: 'Matching flights' }] } }
    expect(browserNext.accept(answer(final), final)).toBeNull()
  })
  it('rejects undefined binding references and invalid active indexes', () => {
    expect(browserInputSchema.safeParse({ ...input, task: { ...input.task, bindings: [] } }).success).toBe(false)
    expect(browserNext.prepare({ ...input, milestoneIndex: 7 })).toBeNull()
  })
  it('does not accept semantic completion from an empty or loading page', () => {
    const empty = { ...input, observation: { ...input.observation, title: 'Requested results', text: '', elements: [] } }
    expect(browserNext.prepare(empty)!.questions.completion).toBeUndefined()
    // Even an unsolicited complete head cannot establish a terminal outcome.
    const unsolicited = answer(input)
    expect(browserNext.accept(unsolicited, empty)).toBeNull() // Its old operation distribution no longer matches the offered controls.
    expect(browserNext.accept(answer(empty), empty)).toEqual({ operation: 'escalate' })
    expect(browserNext.accept(answer({ ...empty, milestoneIndex: 1 }), { ...empty, milestoneIndex: 1 })).toEqual({ operation: 'escalate' })
    const loading = { ...input, observation: { ...input.observation, loading: true } }
    expect(browserNext.accept(answer(loading), loading)).toEqual({ operation: 'escalate' })
  })
})
