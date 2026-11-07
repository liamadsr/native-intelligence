import { describe, expect, it } from 'vitest'
import { browserNext } from '../tasks/browser-next'
import type { Evaluation } from '../contracts'
import { browserFlightFixtures } from './browser-flight-fixtures'
import type { BrowserInput } from '../tasks/browser-next'
import { browserEvaluation } from './browser-evaluation-result'

function answer(input: BrowserInput, operation: string, target: string, operationProbability: number, operationConfidence: number,
  targetProbability: number, targetConfidence: number): Evaluation {
  return browserEvaluation(input, {
    operation: { choice: operation, probability: operationProbability, confidence: operationConfidence },
    [operation]: { choice: target, probability: targetProbability, confidence: targetConfidence },
  })
}

describe('ordered browser flight decisions', () => {
  it('retains multiple useful choices but gives each independent question the same next-step and entity rule', () => {
    const input = browserFlightFixtures[0].input
    const prepared = browserNext.prepare(input)!
    const state = JSON.parse(prepared.state)
    expect(state.task.bindings).toEqual(input.task.bindings)
    expect(state.task.completion).toEqual(input.task.completion)
    expect(state.controls.e10).toContain('combobox Round trip')
    expect(state.controls.e14).toContain('Where to?; editable')
    expect(prepared.questions.click).toMatchObject({ criteria: { e10: 'Click combobox "Round trip".' } })
    expect(prepared.questions.type).toMatchObject({ criteria: { e14_b0: 'Fill combobox "Where to?" with supplied "destination" (binding 0).' } })
    for (const instruction of [state.instruction, ...['operation', 'click', 'type'].map(key => prepared.questions[key].instructions)]) {
      expect(instruction).toContain('first unfinished requirement in the stated task order')
      expect(instruction).toContain('Select the exact requested entity and identifier, rather than a broader group')
      expect(instruction).toContain('Do not retype an already-filled search binding')
    }
  })

  it('uses only the operation-selected target even when another head has higher confidence', () => {
    const input = browserFlightFixtures[0].input
    const previous = answer(input, 'click', 'e10', .88, .86, .71, .69)
    previous.answers.type = browserEvaluation(input, { type: { choice: 'e14_b0' } }).answers.type
    expect(browserNext.accept(previous, input)).toEqual(browserFlightFixtures[0].expected)
    expect(browserNext.accept(answer(input, 'click', 'e10', .99, .98, .99, .98), input)).toEqual(browserFlightFixtures[0].expected)
  })

  it('preserves exact airport and broader city alternatives, accepting the separately evaluated requested choice', () => {
    for (const fixture of browserFlightFixtures.slice(1)) {
      const prepared = browserNext.prepare(fixture.input)!
      expect(prepared.questions.click).toMatchObject({ criteria: {
        e20: 'Click option "Los Angeles".', e21: 'Click option "Los Angeles International Airport".',
      } })
      expect(JSON.parse(prepared.state).controls.e20).toContain('all airports')
      expect(JSON.parse(prepared.state).controls.e21).toContain('LAX airport')
      const expected = fixture.expected
      if (expected.operation !== 'click') throw new Error('Expected a suggestion click fixture')
      expect(browserNext.accept(answer(fixture.input, 'click', expected.ref, .99, .99, .96, .95), fixture.input)).toEqual(expected)
    }
  })

  it('accepts a valid exact suggestion argmax without the general decision thresholds', () => {
    const input = browserFlightFixtures[1].input
    expect(browserNext.accept(answer(input, 'click', 'e21', .97, .97, .84, .80), input)).toEqual({ operation: 'click', ref: 'e21' })
    expect(browserNext.accept(answer(input, 'click', 'e21', .99, .99, .99, .79), input)).toEqual({ operation: 'click', ref: 'e21' })
  })

  it('does not invent typing values for a goal that omitted its bindings', () => {
    const input = structuredClone(browserFlightFixtures[1].input)
    input.task.bindings = []
    const prepared = browserNext.prepare(input)!
    expect(prepared.questions.type).toBeUndefined()
    expect(prepared.questions.operation).not.toHaveProperty('criteria.type')
    expect(browserNext.accept(answer(input, 'type', 'e14_b0', .99, .99, .99, .99), input)).toBeNull()
  })

  it('reserves UTF-8 space for the largest question while retaining every candidate on a repeated-context picker', () => {
    const input = structuredClone(browserFlightFixtures[1].input)
    input.observation.elements = Array.from({ length: 70 }, (_, index) => ({
      ref: `e${index + 1}`, role: 'option', name: `Airport ${index}`, value: '', canType: false,
      disabled: false, sensitive: false, forbidden: false, destination: '',
      context: '空港候補 '.repeat(40), dialog: 'Select a destination: ' + '国際空港 '.repeat(35),
    }))
    const prepared = browserNext.prepare(input)!
    const bytes = (value: string) => new TextEncoder().encode(value).length
    const largestQuestion = Math.max(...Object.values(prepared.questions).map(question => bytes(JSON.stringify(question))))
    expect(bytes(prepared.state) + largestQuestion).toBeLessThanOrEqual(28000)
    expect(Object.keys(JSON.parse(prepared.state).controls)).toHaveLength(70)
    const click = prepared.questions.click
    if (click.type !== 'choice') throw new Error('Expected a click choice')
    expect(Object.keys(click.criteria)).toHaveLength(71)
    expect(JSON.parse(prepared.state).task.bindings).toEqual(input.task.bindings)
  })
})
