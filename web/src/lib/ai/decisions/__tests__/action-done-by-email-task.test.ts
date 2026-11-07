/**
 * action.done_by_email: one pick-one question in its own call, options keyed
 * option_1..option_n plus none (never by a to-do's words), the mail and the
 * to-dos in the state as untrusted evidence, a to-do picked only at DONE_MIN
 * with Jev's confidence (it gets marked done), "none" kept, anything less
 * sure escalated; the labelled fixtures well-formed and within budget.
 */
import { describe, expect, it } from 'vitest'
import type { Evaluation } from '../contracts'
import { decisionTasks } from '../registry'
import { PLAN_DECISIONS } from '../plan-decision'
import { ACTION_DONE_INSTRUCTIONS, DONE_MIN, actionDoneByEmail, actionDoneByEmailSchema, todoOptionKey } from '../tasks/action-done-by-email'
import { actionDoneFixtures } from './action-done-by-email-fixtures'

function result(choice: string, p: number, c: number): Evaluation {
  return {
    answers: { done: { type: 'choice', choice, probabilities: { [choice]: p } } },
    providerMetadata: { typesafe: { confidence: { done: c } } },
  } as unknown as Evaluation
}

const input = actionDoneFixtures[0].input

describe('action.done_by_email', () => {
  it('is registered (never on a free user’s plan, whose uncalibrated "sure" would clear the bar), and asks one pick-one: which to-do, or none', () => {
    expect(decisionTasks['action.done_by_email']).toBe(actionDoneByEmail)
    expect(PLAN_DECISIONS['action.done_by_email']).toBeUndefined()
    const prepared = actionDoneByEmail.prepare(input)!
    expect(Object.keys(prepared.questions)).toEqual(['done'])
    const done = prepared.questions.done as { type: string; instructions: string; criteria: Record<string, string> }
    expect(done.type).toBe('choice')
    expect(Object.keys(done.criteria)).toEqual([...input.todos.map((_, i) => todoOptionKey(i)), 'none'])
    expect(done.instructions).toBe(ACTION_DONE_INSTRUCTIONS)
    expect(done.instructions).toContain('untrusted evidence')
  })

  it('the state holds the mail and the to-dos under option keys; no to-do’s words or id reach the question', () => {
    const prepared = actionDoneByEmail.prepare(input)!
    const state = JSON.parse(prepared.state)
    expect(state).toMatchObject({ messageOrder: 'oldest_first', now: input.now })
    expect(state.note).toContain('untrusted')
    expect(state.todos[0]).toMatchObject({ option: 'option_1', title: input.todos[0].title, due: '2026-10-20' })
    expect(state.todos[0].id).toBeUndefined()
    const question = JSON.stringify(prepared.questions)
    for (const t of input.todos) {
      expect(question).not.toContain(t.title)
      expect(question).not.toContain(t.id)
    }
  })

  it('picks a to-do only at DONE_MIN with Jev’s confidence; keeps none; escalates anything less sure', () => {
    expect(actionDoneByEmail.accept(result('option_1', 0.96, 0.9), input)).toEqual({ actionId: input.todos[0].id })
    expect(actionDoneByEmail.accept(result('option_2', DONE_MIN, 0.85), input)).toEqual({ actionId: input.todos[1].id })
    // Sure enough to pick, not sure enough to mark it done.
    expect(actionDoneByEmail.accept(result('option_1', 0.87, 0.9), input)).toBeNull()
    expect(actionDoneByEmail.accept(result('option_1', 0.97, 0.6), input)).toBeNull()
    expect(actionDoneByEmail.accept(result('none', 0.88, 0.85), input)).toEqual({ actionId: null })
    expect(actionDoneByEmail.accept(result('none', 0.6, 0.85), input)).toBeNull()
    // An option past the list, or no answer at all.
    expect(actionDoneByEmail.accept(result('option_99', 0.99, 0.99), input)).toBeNull()
    expect(actionDoneByEmail.accept({ answers: {}, providerMetadata: {} } as unknown as Evaluation, input)).toBeNull()
  })

  it('refuses duplicate to-do ids, an empty list and more than the cap', () => {
    const dup = { ...input, todos: [input.todos[0], input.todos[0]] }
    expect(actionDoneByEmailSchema.safeParse(dup).success).toBe(false)
    expect(actionDoneByEmailSchema.safeParse({ ...input, todos: [] }).success).toBe(false)
    const many = { ...input, todos: Array.from({ length: 26 }, (_, i) => ({ id: `t${i}`, title: `To-do ${i}` })) }
    expect(actionDoneByEmailSchema.safeParse(many).success).toBe(false)
  })

  it('every fixture fits the runner’s budget (state plus the question within 28,000 bytes), and the labels point at a to-do', () => {
    const encoder = new TextEncoder()
    for (const f of actionDoneFixtures) {
      const prepared = actionDoneByEmail.prepare(f.input)!
      const size = encoder.encode(JSON.stringify(prepared.questions.done)).length
      expect(encoder.encode(prepared.state).length + size, f.name).toBeLessThanOrEqual(28000)
      expect(prepared.state.length, f.name).toBeLessThanOrEqual(actionDoneByEmail.maxStateChars)
      if (f.done !== null) expect(f.input.todos[f.done], f.name).toBeDefined()
    }
    // Both answers are labelled: closes and none.
    expect(actionDoneFixtures.some((f) => f.done === null)).toBe(true)
    expect(actionDoneFixtures.some((f) => f.done !== null)).toBe(true)
  })

  it('a full list of long to-dos still fits', () => {
    const long = actionDoneByEmailSchema.parse({
      now: input.now,
      messages: [input.messages[0], { ...input.messages[0], body: 'x'.repeat(3000) }],
      todos: Array.from({ length: 25 }, (_, i) => ({ id: `t-${i}`, title: 'y'.repeat(300), details: 'z'.repeat(240), due: '2026-10-30' })),
    })
    const prepared = actionDoneByEmail.prepare(long)!
    expect(prepared.state.length).toBeLessThanOrEqual(actionDoneByEmail.maxStateChars)
  })
})
