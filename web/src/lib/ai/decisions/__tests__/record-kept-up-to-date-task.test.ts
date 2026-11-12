/**
 * record.kept_up_to_date: two pick-ones in one call (which change, and the
 * sentence that states it), options keyed option_1..n and sentence_1..n plus
 * none (never by their words), the source and the records in the state as
 * untrusted evidence; a change picked only at KEPT_MIN with Jev's confidence
 * AND a quoted sentence, "none" kept, anything less sure escalated; never on
 * a free user's plan; the labelled fixtures well-formed and within budget.
 */
import { describe, expect, it } from 'vitest'
import type { Evaluation } from '../contracts'
import { decisionTasks } from '../registry'
import { PLAN_DECISIONS } from '../plan-decision'
import { evaluationKinds } from '../evaluation-report'
import {
  EVIDENCE_MIN,
  KEPT_INSTRUCTIONS,
  KEPT_MAX_CHANGES,
  KEPT_MIN,
  changeOptionKey,
  recordKeptUpToDate,
  recordKeptUpToDateSchema,
  sentenceOptionKey,
} from '../tasks/record-kept-up-to-date'
import { keptFixtures } from './record-kept-up-to-date-fixtures'

function result(change: string, p: number, c: number, evidence: string | null = 'sentence_2', q = 0.8): Evaluation {
  return {
    answers: {
      change: { type: 'choice', choice: change, probabilities: { [change]: p } },
      ...(evidence ? { evidence: { type: 'choice', choice: evidence, probabilities: { [evidence]: q } } } : {}),
    },
    providerMetadata: { typesafe: { confidence: { change: c } } },
  } as unknown as Evaluation
}

const signed = keptFixtures.find((f) => f.name === 'signed_is_won')!
const input = signed.input
const wonIndex = input.changes.findIndex((c) => c.id === 'stage-won')

describe('record.kept_up_to_date', () => {
  it('is registered (never on a free user’s plan), is an evaluation kind, and asks two pick-ones: which change and which sentence', () => {
    expect(decisionTasks['record.kept_up_to_date']).toBe(recordKeptUpToDate)
    expect(PLAN_DECISIONS['record.kept_up_to_date']).toBeUndefined()
    expect(evaluationKinds).toContain('record.kept_up_to_date')
    const prepared = recordKeptUpToDate.prepare(input)!
    expect(Object.keys(prepared.questions)).toEqual(['change', 'evidence'])
    const change = prepared.questions.change as { type: string; instructions: string; criteria: Record<string, string> }
    const evidence = prepared.questions.evidence as { type: string; criteria: Record<string, string> }
    expect(change.type).toBe('choice')
    expect(Object.keys(change.criteria)).toEqual([...input.changes.map((_, i) => changeOptionKey(i)), 'none'])
    expect(Object.keys(evidence.criteria)).toEqual([...input.sentences.map((_, i) => sentenceOptionKey(i)), 'none'])
    expect(change.instructions).toBe(KEPT_INSTRUCTIONS)
    expect(change.instructions).toContain('untrusted evidence')
    // The bar: a plan is not the fact.
    expect(change.instructions).toContain('"we\'re signing Friday" does not make a deal won')
  })

  it('the state holds the source, the records and the changes under keys; no record’s words or change’s id reach the questions', () => {
    const prepared = recordKeptUpToDate.prepare(input)!
    const state = JSON.parse(prepared.state)
    expect(state.note).toContain('untrusted')
    expect(state.sentences[1]).toEqual({ sentence: 'sentence_2', text: input.sentences[1] })
    expect(state.records[0]).toMatchObject({ record: 'record_1', kind: 'row', title: 'Acme Robotics renewal', table: 'Pipeline' })
    expect(state.changes[wonIndex]).toEqual({ option: changeOptionKey(wonIndex), record: 'record_1', field: 'Stage', from: 'Proposal', to: 'Won' })
    expect(state.changes[0].id).toBeUndefined()
    const questions = JSON.stringify(prepared.questions)
    for (const c of input.changes) expect(questions).not.toContain(c.id)
    for (const s of input.sentences) expect(questions).not.toContain(s)
    expect(questions).not.toContain('Acme')
  })

  it('a to-do’s change reads as "mark done"', () => {
    const meeting = keptFixtures.find((f) => f.name === 'todo_done_in_a_meeting')!.input
    expect(JSON.parse(recordKeptUpToDate.prepare(meeting)!.state).changes[0]).toEqual({ option: 'option_1', record: 'record_1', change: 'mark done' })
  })

  it('picks a change only at KEPT_MIN with Jev’s confidence and a quoted sentence; keeps none; escalates anything less sure', () => {
    const won = changeOptionKey(wonIndex)
    expect(recordKeptUpToDate.accept(result(won, 0.96, 0.9), input)).toEqual({ changeId: 'stage-won', evidence: 1 })
    expect(recordKeptUpToDate.accept(result(won, KEPT_MIN, 0.85, 'sentence_2', EVIDENCE_MIN), input)).toEqual({ changeId: 'stage-won', evidence: 1 })
    // Sure enough to pick, not sure enough to apply.
    expect(recordKeptUpToDate.accept(result(won, 0.87, 0.9), input)).toBeNull()
    expect(recordKeptUpToDate.accept(result(won, 0.97, 0.6), input)).toBeNull()
    // No sentence that says it, or a doubtful one: nothing is changed.
    expect(recordKeptUpToDate.accept(result(won, 0.97, 0.9, null), input)).toBeNull()
    expect(recordKeptUpToDate.accept(result(won, 0.97, 0.9, 'none'), input)).toBeNull()
    expect(recordKeptUpToDate.accept(result(won, 0.97, 0.9, 'sentence_2', 0.3), input)).toBeNull()
    expect(recordKeptUpToDate.accept(result(won, 0.97, 0.9, 'sentence_99'), input)).toBeNull()
    expect(recordKeptUpToDate.accept(result('none', 0.88, 0.85, null), input)).toEqual({ changeId: null, evidence: null })
    expect(recordKeptUpToDate.accept(result('none', 0.6, 0.85, null), input)).toBeNull()
    expect(recordKeptUpToDate.accept(result('option_99', 0.99, 0.99), input)).toBeNull()
    expect(recordKeptUpToDate.accept({ answers: {}, providerMetadata: {} } as unknown as Evaluation, input)).toBeNull()
  })

  it('refuses duplicate change ids, a change naming no record, empty lists and more than the cap', () => {
    expect(recordKeptUpToDateSchema.safeParse({ ...input, changes: [input.changes[0], input.changes[0]] }).success).toBe(false)
    expect(recordKeptUpToDateSchema.safeParse({ ...input, changes: [{ ...input.changes[0], record: 3 }] }).success).toBe(false)
    expect(recordKeptUpToDateSchema.safeParse({ ...input, changes: [] }).success).toBe(false)
    expect(recordKeptUpToDateSchema.safeParse({ ...input, sentences: [] }).success).toBe(false)
    const many = Array.from({ length: KEPT_MAX_CHANGES + 1 }, (_, i) => ({ ...input.changes[0], id: `c${i}` }))
    expect(recordKeptUpToDateSchema.safeParse({ ...input, changes: many }).success).toBe(false)
  })

  it('every fixture fits the runner’s budget, and its labels point at listed changes', () => {
    const encoder = new TextEncoder()
    for (const f of keptFixtures) {
      const prepared = recordKeptUpToDate.prepare(f.input)!
      const size = encoder.encode(JSON.stringify(prepared.questions)).length
      expect(encoder.encode(prepared.state).length + size, f.name).toBeLessThanOrEqual(28000)
      expect(prepared.state.length, f.name).toBeLessThanOrEqual(recordKeptUpToDate.maxStateChars)
      for (const id of f.expected) expect(f.input.changes.some((c) => c.id === id), `${f.name}: ${id}`).toBe(true)
    }
    // The cases the bar exists for are there.
    const names = keptFixtures.map((f) => f.name)
    for (const n of ['signing_friday_is_not_won', 'signed_is_won', 'push_to_march_is_close_date', 'ambiguous_check_in_is_none']) expect(names).toContain(n)
    expect(keptFixtures.find((f) => f.name === 'signing_friday_is_not_won')!.expected).not.toContain('stage-won')
  })
})
