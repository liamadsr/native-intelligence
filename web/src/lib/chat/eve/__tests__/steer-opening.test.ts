/**
 * When a held message may go to eve as a steer (steer-opening.ts, UI-2): POST
 * only when eve would act on it next, so Edit stays honest while it waits.
 */
import { describe, it, expect } from 'vitest'
import { steerOpening, type SteerOpeningFacts } from '../steer-opening'

const facts = (over: Partial<SteerOpeningFacts> = {}): SteerOpeningFacts => ({
  identified: true,
  parked: false,
  answerStarted: false,
  toolExecuting: false,
  toolCallStarting: false,
  ...over,
})

describe('steerOpening', () => {
  it('never posts while the turn is parked on a question (typed words answer it)', () => {
    expect(steerOpening(facts({ parked: true }))).toEqual({ action: 'never' })
    expect(steerOpening(facts({ parked: true, answerStarted: true, toolExecuting: true }))).toEqual({ action: 'never' })
  })

  it('holds until the running turn knows its own delivery ids (no fold into its start)', () => {
    expect(steerOpening(facts({ identified: false }))).toEqual({ action: 'hold' })
  })

  it('posts before any answer text when no tool runs: eve interrupts the pending call (reasoning included)', () => {
    expect(steerOpening(facts())).toEqual({ action: 'post', reason: 'before_output' })
    // A tool call whose input is only streaming is still the pending call.
    expect(steerOpening(facts({ toolCallStarting: true }))).toEqual({ action: 'post', reason: 'before_output' })
  })

  it('holds while a tool executes before any answer text, so the next call is interrupted before output', () => {
    expect(steerOpening(facts({ toolExecuting: true }))).toEqual({ action: 'hold' })
  })

  it('posts once answer text started and a tool runs or a tool call starts: the boundary eve would use anyway', () => {
    expect(steerOpening(facts({ answerStarted: true, toolExecuting: true }))).toEqual({ action: 'post', reason: 'tool_boundary' })
    expect(steerOpening(facts({ answerStarted: true, toolCallStarting: true }))).toEqual({ action: 'post', reason: 'tool_boundary' })
  })

  it('holds while answer text streams with no tool: if the turn ends it goes as the next turn', () => {
    expect(steerOpening(facts({ answerStarted: true }))).toEqual({ action: 'hold' })
  })
})
