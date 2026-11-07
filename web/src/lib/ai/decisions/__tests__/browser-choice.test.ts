import { describe, expect, it } from 'vitest'
import type { Evaluation, Questions } from '../contracts'
import { browserChoice } from '../tasks/browser-choice'
import { browserInputSchema, browserNext, type BrowserInput } from '../tasks/browser-next'
import { browserEvaluation } from './browser-evaluation-result'

const question: Questions[string] = { type: 'choice', instructions: 'Choose an observed control.',
  criteria: { e1: 'First', e2: 'Second', none: 'No suitable target' } }
function result(distribution: Record<string, unknown> = { e1: .5, e2: .3, none: .2 }, choice = 'e1', confidence: unknown = .39,
  rounding?: Evaluation['rounding']): Evaluation {
  return { answers: { click: { type: 'choice', choice, probabilities: distribution } }, rounding,
    providerMetadata: { typesafe: { confidence: { click: confidence } } } } as unknown as Evaluation
}

describe('browser choice distribution validation', () => {
  it('accepts the offered argmax at low confidence and permits a reported tied maximum like the reference', () => {
    expect(browserChoice(result(), 'click', question)).toBe('e1')
    expect(browserChoice(result({ e1: .5, e2: .5, none: 0 }), 'click', question)).toBe('e1')
  })
  it.each([undefined, NaN, Infinity, -.1, 1.1, '0.9'])('rejects malformed confidence %s', confidence => {
    const evaluation = result()
    evaluation.providerMetadata!.typesafe = { confidence: { click: confidence } } as never
    expect(browserChoice(evaluation, 'click', question)).toBeNull()
  })
  it.each([NaN, Infinity, -.1, 1.1, '0.5', null])('rejects malformed probability %s', value => {
    expect(browserChoice(result({ e1: value, e2: .3, none: .2 }), 'click', question)).toBeNull()
  })
  it('rejects missing or extra candidates, unknown winners and nonmaximal selected choices', () => {
    for (const evaluation of [result({ e1: .7, e2: .3 }), result({ e1: .5, e2: .2, none: .2, e3: .1 }),
      result(undefined, 'unknown'), result({ e1: .3, e2: .5, none: .2 })]) {
      expect(browserChoice(evaluation, 'click', question)).toBeNull()
    }
  })
  it('rejects wrong answer shapes and does not accept an unoffered question', () => {
    expect(browserChoice(result(), 'click', undefined)).toBeNull()
    expect(browserChoice(result(), 'missing', question)).toBeNull()
    expect(browserChoice({ answers: { click: { type: 'boolean', probability: 1 } } } as unknown as Evaluation, 'click', question)).toBeNull()
    expect(browserChoice(result([] as unknown as Record<string, unknown>), 'click', question)).toBeNull()
  })
  it('requires normalized mass and honors declared rounding without inventing missing precision', () => {
    expect(browserChoice(result({ e1: .34, e2: .33, none: .32 }), 'click', question)).toBeNull()
    expect(browserChoice(result({ e1: .34, e2: .33, none: .32 }, 'e1', .4, { probabilityDecimals: 2 }), 'click', question)).toBe('e1')
    expect(browserChoice(result({ e1: .35, e2: .33, none: .33 }, 'e1', .4, { probabilityDecimals: 2 }), 'click', question)).toBe('e1')
    expect(browserChoice(result({ e1: .34, e2: .32, none: .32 }, 'e1', .4, { probabilityDecimals: 2 }), 'click', question)).toBeNull()
    expect(browserChoice(result({ e1: .34, e2: .33, none: .32 }, 'e1', .4, { probabilityDecimals: 3 }), 'click', question)).toBeNull()
  })
  it.each([-1, 16, 1.5, NaN, Infinity, '2'])('rejects invalid declared precision %s', probabilityDecimals => {
    expect(browserChoice(result(undefined, 'e1', .4, { probabilityDecimals } as Evaluation['rounding']), 'click', question)).toBeNull()
  })
  it('caps cumulative rounding error for large candidate sets', () => {
    const keys = Array.from({ length: 100 }, (_, i) => `e${i}`)
    const many: Questions[string] = { type: 'choice', instructions: 'Choose', criteria: Object.fromEntries(keys.map(key => [key, key])) }
    expect(browserChoice(result(Object.fromEntries(keys.map(key => [key, .005])), 'e0', .01, { probabilityDecimals: 2 }), 'click', many)).toBeNull()
    const rounded = Object.fromEntries(keys.map((key, index) => [key, index === 0 ? .98 : index === 1 ? .01 : 0]))
    expect(browserChoice(result(rounded, 'e0', .4, { probabilityDecimals: 2 }), 'click', many)).toBe('e0')
  })
})

function input(): BrowserInput {
  return browserInputSchema.parse({ task: { goal: 'Show matching results for Berlin.', bindings: [{ name: 'query', value: 'Berlin' }],
    milestones: [{ goal: 'Matching results for Berlin are visible.', bindingNames: ['query'] }] }, history: [],
  observation: { protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 1, interactionEpoch: 0,
    observedAt: 1, url: 'https://example.com/search', title: 'Search', text: 'Enter destination',
    elements: [{ ref: 'e1', role: 'combobox', name: 'Destination', value: '', canType: true, disabled: false, sensitive: false,
      forbidden: false, context: '', destination: '' },
    { ref: 'e2', role: 'button', name: 'Search', value: '', canType: false, disabled: false, sensitive: false,
      forbidden: false, context: '', destination: '' }] } })
}
const typing = { operation: { choice: 'type', probability: .6, confidence: .2 }, type: { choice: 'e1_b0', probability: .6, confidence: .2 } }

describe('browser action and completion policies', () => {
  it('separates conditional action selection from completion and retains explicit control-setting evidence', () => {
    const prepared = browserNext.prepare(input())!
    expect(prepared.questions.operation).not.toHaveProperty('criteria.done')
    expect(prepared.questions.operation.instructions).toContain('If any active requirement remains unfinished')
    expect(prepared.questions.operation.instructions).not.toContain('Choose done')
    expect(prepared.questions.operation.instructions).toContain('Verify explicit UI settings from current controls')
    expect(prepared.questions.operation).toHaveProperty('criteria.escalate',
      'No supported operation can make progress toward an unfinished requirement on this page. A later missing field or unsupported step does not block a useful visible action now.')
  })
  it('allows a low-confidence but valid incomplete winner to proceed with the selected action', () => {
    const fixture = input()
    expect(browserNext.accept(browserEvaluation(fixture, { ...typing,
      completion: { choice: 'incomplete', probability: .51, confidence: .02 } }), fixture)).toEqual({ operation: 'type', ref: 'e1', binding: 0 })
  })
  it('strictly complete evidence dominates a speculative or malformed unused action head', () => {
    const fixture = input()
    const evaluation = browserEvaluation(fixture, { ...typing, completion: { choice: 'complete' } })
    delete evaluation.answers.operation
    delete evaluation.answers.type
    expect(browserNext.accept(evaluation, fixture)).toEqual({ operation: 'done' })
  })
  it.each([{ probability: .84, confidence: .99 }, { probability: .99, confidence: .79 }, { probability: .51, confidence: .02 }])(
    'stops rather than acting when complete wins below the strict terminal boundary: %j', partial => {
      const fixture = input()
      expect(browserNext.accept(browserEvaluation(fixture, { ...typing, completion: { choice: 'complete', ...partial } }), fixture)).toBeNull()
    })
  it('retains the inclusive terminal boundary and all literal predicates', () => {
    const fixture = input()
    const evaluation = browserEvaluation(fixture, { ...typing, completion: { choice: 'complete', probability: .85, confidence: .8 } })
    expect(browserNext.accept(evaluation, fixture)).toEqual({ operation: 'done' })
    fixture.task.completion = [{ kind: 'text', value: 'Matching Berlin results' }]
    expect(browserNext.accept(evaluation, fixture)).toBeNull()
  })
  it('fails closed when an offered completion answer is missing or malformed', () => {
    const fixture = input()
    for (const answer of [undefined, { type: 'choice', choice: 'incomplete', probabilities: { incomplete: 1 } },
      { type: 'choice', choice: 'complete', probabilities: { complete: .9, incomplete: .9 } }]) {
      const evaluation = browserEvaluation(fixture, typing)
      if (answer === undefined) delete evaluation.answers.completion
      else evaluation.answers.completion = answer as Evaluation['answers'][string]
      expect(browserNext.accept(evaluation, fixture)).toBeNull()
    }
  })
  it('ignores unsolicited completion when local predicates did not offer it', () => {
    const fixture = input()
    delete fixture.task.milestones
    fixture.task.completion = [{ kind: 'text', value: 'Matching Berlin results' }]
    const evaluation = browserEvaluation(fixture, typing)
    expect(browserNext.prepare(fixture)!.questions.completion).toBeUndefined()
    evaluation.answers.completion = { type: 'choice', choice: 'complete', probabilities: { complete: .99, incomplete: .01 } }
    expect(browserNext.accept(evaluation, fixture)).toEqual({ operation: 'type', ref: 'e1', binding: 0 })
  })
  it('keeps sensitive target thresholds for both operation and target', () => {
    const fixture = input()
    fixture.observation.elements[0].sensitive = true
    expect(browserNext.accept(browserEvaluation(fixture, typing), fixture)).toBeNull()
    expect(browserNext.accept(browserEvaluation(fixture, { ...typing, operation: { choice: 'type' } }), fixture)).toBeNull()
    expect(browserNext.accept(browserEvaluation(fixture, { ...typing, type: { choice: 'e1_b0' } }), fixture)).toBeNull()
    expect(browserNext.accept(browserEvaluation(fixture, { operation: { choice: 'type' }, type: { choice: 'e1_b0' } }), fixture))
      .toEqual({ operation: 'type', ref: 'e1', binding: 0 })
  })
  it('does not execute another head when the selected target is none or malformed', () => {
    const fixture = input()
    expect(browserNext.accept(browserEvaluation(fixture, { ...typing, type: { choice: 'none' }, click: { choice: 'e2' } }), fixture)).toBeNull()
    const malformed = browserEvaluation(fixture, { ...typing, click: { choice: 'e2' } })
    malformed.answers.type = { type: 'choice', choice: 'e1_b0', probabilities: { e1_b0: .6, none: .6 } }
    expect(browserNext.accept(malformed, fixture)).toBeNull()
  })
  it.each(['scroll_down', 'scroll_up', 'wait', 'escalate'])('accepts only the offered valid %s winner', operation => {
    const fixture = input()
    expect(browserNext.accept(browserEvaluation(fixture, { operation: { choice: operation, probability: .4, confidence: .1 } }), fixture))
      .toEqual({ operation })
  })
})
