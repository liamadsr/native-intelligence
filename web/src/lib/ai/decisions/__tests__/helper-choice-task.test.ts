import { describe, expect, it } from 'vitest'
import type { Evaluation } from '../contracts'
import { decisionTasks } from '../registry'
import { GENERIC_HELPER_ID, helperChoice, helperChoiceSchema, helperOptionKey, HELPER_CHOICE_INSTRUCTIONS } from '../tasks/helper-choice'
import { helperChoiceFixtures } from './helper-choice-fixtures'

/** A pick-one answer for `fit`, with the provider's confidence. */
const answer = (choice: string, probability: number, confidence = 0.9) =>
  ({
    answers: { fit: { type: 'choice', choice, probabilities: { [choice]: probability } } },
    providerMetadata: { typesafe: { confidence: { fit: confidence } } },
  }) as unknown as Evaluation

const byName = (name: string) => helperChoiceFixtures.find((f) => f.name === name)!

describe('helper.choice decision policy', () => {
  it('is registered as a decision task', () => {
    expect(decisionTasks['helper.choice']).toBe(helperChoice)
  })

  it('every labelled fixture parses, and its expected pick is a candidate or unclear', () => {
    expect(helperChoiceFixtures.length).toBeGreaterThanOrEqual(10)
    for (const f of helperChoiceFixtures) {
      const ids = f.input.candidates.map((c) => c.id)
      expect(f.expected === 'unclear' || ids.includes(f.expected), f.name).toBe(true)
      expect(ids[0], f.name).toBe(GENERIC_HELPER_ID)
      expect(helperChoice.prepare(f.input)!.state.length, f.name).toBeLessThanOrEqual(helperChoice.maxStateChars)
    }
  })

  it('one pick-one question: an option per candidate plus unclear, keyed by position, never by member-written text', () => {
    const input = byName('prospect_research_fits_sdr').input
    const prepared = helperChoice.prepare(input)!
    const q = prepared.questions.fit
    expect(Object.keys(prepared.questions)).toEqual(['fit'])
    expect(q.type).toBe('choice')
    expect(Object.keys((q as { criteria: Record<string, string> }).criteria)).toEqual(['option_1', 'option_2', 'option_3', 'unclear'])
    const state = JSON.parse(prepared.state)
    expect(state.candidates.map((c: { option: string }) => c.option)).toEqual(['option_1', 'option_2', 'option_3'])
    expect(state.candidates[0].kind).toBe('general helper')
    expect(state.candidates[1].kind).toBe('custom agent')
    // The main agent's own pick is not shown: an independent read.
    expect(prepared.state).not.toContain('picked')
  })

  it('labels candidate text untrusted and keeps injected text in the state, out of the question', () => {
    const malicious = byName('injection_in_description_ignored').input
    const prepared = helperChoice.prepare(malicious)!
    expect(JSON.parse(prepared.state).note).toMatch(/untrusted/)
    expect(HELPER_CHOICE_INSTRUCTIONS).toMatch(/untrusted text written by workspace members/)
    expect(JSON.stringify(prepared.questions)).not.toContain('IGNORE ALL PREVIOUS INSTRUCTIONS')
    expect(prepared.state).toContain('IGNORE ALL PREVIOUS INSTRUCTIONS')
    // Same question whatever the candidates say.
    expect(prepared.questions.fit.instructions).toBe(helperChoice.prepare(byName('meeting_recap_is_general').input)!.questions.fit.instructions)
  })

  it('accepts a trusted pick and maps it back to the candidate id; preferred only when it differs from the agent\'s pick', () => {
    const input = byName('prospect_research_fits_sdr').input // picked: the general helper
    const sdrId = input.candidates[1].id
    expect(helperChoice.accept(answer(helperOptionKey(1), 0.95), input)).toEqual({ choice: sdrId, preferred: sdrId })
    expect(helperChoice.accept(answer(helperOptionKey(0), 0.95), input)).toEqual({ choice: GENERIC_HELPER_ID, preferred: null })
    const agreed = byName('sdr_picked_and_right').input
    expect(helperChoice.accept(answer(helperOptionKey(1), 0.9), agreed)).toEqual({ choice: agreed.candidates[1].id, preferred: null })
  })

  it('lets the agent\'s choice stand on unclear, low probability, low confidence, an unknown option or a wrong answer type', () => {
    const input = byName('prospect_research_fits_sdr').input
    expect(helperChoice.accept(answer('unclear', 0.99), input)).toBeNull()
    expect(helperChoice.accept(answer(helperOptionKey(1), 0.84), input)).toBeNull()
    expect(helperChoice.accept(answer(helperOptionKey(1), 0.95, 0.7), input)).toBeNull()
    expect(helperChoice.accept(answer('option_9', 0.99), input)).toBeNull()
    expect(helperChoice.accept({ answers: {} } as Evaluation, input)).toBeNull()
    expect(helperChoice.accept({ answers: { fit: { type: 'boolean', probability: 1 } } } as unknown as Evaluation, input)).toBeNull()
  })

  it('the schema needs 2..8 unique candidates and a pick among them', () => {
    const base = byName('prospect_research_fits_sdr').input
    expect(helperChoiceSchema.safeParse({ ...base, candidates: base.candidates.slice(0, 1) }).success).toBe(false)
    expect(helperChoiceSchema.safeParse({ ...base, candidates: Array.from({ length: 9 }, (_, i) => ({ ...base.candidates[0], id: `c${i}` })) }).success).toBe(false)
    expect(helperChoiceSchema.safeParse({ ...base, candidates: [base.candidates[0], base.candidates[0]] }).success).toBe(false)
    expect(helperChoiceSchema.safeParse({ ...base, picked: 'someone-else' }).success).toBe(false)
    expect(helperChoiceSchema.safeParse(base).success).toBe(true)
  })
})
