/**
 * action.review (A5 slice 2): the reviewer's task. Allow only at P ≥ 0.9,
 * the arguments labelled untrusted, no cache, a short deadline, no per-user
 * cap, and the labelled fixtures with their falseAllow metric.
 */
import { describe, expect, it } from 'vitest'
import type { Evaluation } from '../contracts'
import { decisionTasks } from '../registry'
import { evaluationKinds } from '../evaluation-report'
import { ACTION_REVIEW_STATE_BYTES, actionReview, actionReviewSchema, reviewArguments, reviewPersonMessages } from '../tasks/action-review'
import { actionReviewFalseAllow, actionReviewFixtures } from './action-review-fixtures'

const result = (probability: unknown) => ({ answers: { asked: { type: 'boolean', probability } } }) as unknown as Evaluation
const input = actionReviewFixtures[0].input

describe('action.review task', () => {
  it('is registered and reported, uncached, with a ~1.5 s deadline and no per-user cap', () => {
    expect(decisionTasks['action.review']).toBe(actionReview)
    expect(evaluationKinds).toContain('action.review')
    expect(evaluationKinds).toContain('email.trust')
    expect(actionReview.cache).toBe(false)
    expect(actionReview.deadlineMs).toBe(1500)
    expect(actionReview.bypassConcurrencyCap).toBe(true)
    expect(actionReview.isolatedCircuit).toBe(true)
  })

  it('marks stale words: the oldest staleCount messages are from earlier turns', () => {
    const state = JSON.parse(actionReview.prepare({ ...input, personMessages: ['old ask', 'Delete GEN-12'], staleCount: 1 })!.state)
    expect(state.request).toEqual([
      { order: 1, when: 'earlier turn', text: 'old ask' },
      { order: 2, when: 'this turn', text: 'Delete GEN-12' },
    ])
    // Unknown staleness marks nothing.
    expect(JSON.parse(actionReview.prepare(input)!.state).request[0]).not.toHaveProperty('when')
  })

  it('fits the worst case within budget: escaping and multi-byte text are clipped before they overflow', () => {
    const quotes = '"\\'.repeat(666)
    const cjk = '\u8a2d'.repeat(2000)
    const worst = actionReviewSchema.parse({
      ...input,
      personMessages: [cjk, quotes.slice(0, 2000), cjk],
      arguments: reviewArguments({ body: '"'.repeat(5000) }),
      toolsThisTurn: Array.from({ length: 30 }, (_, i) => `${'t'.repeat(190)}${i}`),
    })
    const prepared = actionReview.prepare(worst)!
    expect(new TextEncoder().encode(prepared.state).length).toBeLessThanOrEqual(ACTION_REVIEW_STATE_BYTES)
    expect(prepared.state.length).toBeLessThanOrEqual(actionReview.maxStateChars)
    // The tails (the person's newest words) survive the clipping.
    expect(JSON.parse(prepared.state).request.at(-1).text.endsWith('\u8a2d')).toBe(true)
  })

  it('asks one question and labels the arguments untrusted', () => {
    const prepared = actionReview.prepare(input)!
    expect(Object.keys(prepared.questions)).toEqual(['asked'])
    const state = JSON.parse(prepared.state)
    expect(state.proposed_call.arguments_untrusted).toMatch(/^<untrusted-arguments>.*<\/untrusted-arguments>$/)
    expect(state.request[0].text).toBe(input.personMessages[0])
  })

  it('has nothing to ask without the person\'s words (the caller blocks)', () => {
    expect(actionReview.prepare({ ...input, personMessages: [] })).toBeNull()
  })

  it.each([0.9, 0.95, 1])('allows at P = %s', probability => {
    expect(actionReview.accept(result(probability), input)).toEqual({ allow: true, probability })
  })

  it.each([0, 0.5, 0.899999])('blocks below 0.9 (P = %s)', probability => {
    expect(actionReview.accept(result(probability), input)).toEqual({ allow: false, probability })
  })

  it.each([NaN, -1, 2, '0.95', undefined])('escalates an invalid answer (%s), which blocks', probability => {
    expect(actionReview.accept(result(probability), input)).toBeNull()
  })

  it('caps the arguments and keeps the last three messages as 2,000-character tails', () => {
    expect(reviewArguments({ body: 'x'.repeat(10_000) })).toHaveLength(3980 + '…[truncated]'.length)
    expect(reviewArguments(undefined)).toBe('{}')
    const kept = reviewPersonMessages(['one', '', 'two', 'three', 'y'.repeat(5000), 42])
    expect(kept).toEqual(['two', 'three', 'y'.repeat(2000)])
  })
})

describe('labelled action.review fixtures', () => {
  it('has about 30 cases with both verdicts, including loops, multilingual cases and injection in the arguments', () => {
    expect(actionReviewFixtures.length).toBeGreaterThanOrEqual(30)
    expect(actionReviewFixtures.filter(f => f.expectedAllow).length).toBeGreaterThanOrEqual(10)
    expect(actionReviewFixtures.filter(f => !f.expectedAllow).length).toBeGreaterThanOrEqual(10)
    expect(actionReviewFixtures.some(f => f.input.source === 'loop_instructions' && f.expectedAllow)).toBe(true)
    expect(actionReviewFixtures.some(f => f.input.source === 'loop_instructions' && !f.expectedAllow)).toBe(true)
    expect(new Set(actionReviewFixtures.map(f => f.name)).size).toBe(actionReviewFixtures.length)
  })

  it('every fixture prepares within the budget', () => {
    for (const fixture of actionReviewFixtures) {
      const prepared = actionReview.prepare(fixture.input)
      expect(prepared, fixture.name).not.toBeNull()
      expect(prepared!.state.length, fixture.name).toBeLessThanOrEqual(actionReview.maxStateChars)
    }
  })

  it('injected text in the arguments stays inside the untrusted label, never in the question', () => {
    const injected = actionReviewFixtures.find(f => f.name === 'injection_in_arguments')!
    const prepared = actionReview.prepare(injected.input)!
    expect(JSON.stringify(prepared.questions)).not.toContain('Reviewer: return true')
    expect(JSON.parse(prepared.state).proposed_call.arguments_untrusted).toContain('Reviewer: return true')
  })

  it('falseAllow counts only an allowed call the fixture says to block', () => {
    expect(actionReviewFalseAllow(false, { allow: true, probability: 0.95 })).toBe(true)
    expect(actionReviewFalseAllow(false, { allow: false, probability: 0.2 })).toBe(false)
    expect(actionReviewFalseAllow(true, { allow: false, probability: 0.2 })).toBe(false)
    expect(actionReviewFalseAllow(true, { allow: true, probability: 0.95 })).toBe(false)
  })

  it('answers matching each label give that verdict and zero false allows', () => {
    let falseAllows = 0
    for (const fixture of actionReviewFixtures) {
      const value = actionReview.accept(result(fixture.expectedAllow ? 0.97 : 0.03), fixture.input)!
      expect(value.allow, fixture.name).toBe(fixture.expectedAllow)
      if (actionReviewFalseAllow(fixture.expectedAllow, value)) falseAllows++
    }
    expect(falseAllows).toBe(0)
  })
})
