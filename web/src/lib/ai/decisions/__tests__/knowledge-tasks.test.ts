import { describe, expect, it } from 'vitest'
import type { Evaluation } from '../contracts'
import { knowledgeAnchor, knowledgeAnchorSchema } from '../tasks/knowledge-anchor'
import { knowledgeRelationship, knowledgeRelationshipSchema } from '../tasks/knowledge-relationship'
import { knowledgeAnchorFixtures, knowledgeRelationshipFixtures } from './knowledge-fixtures'

function evaluation(choices: Record<string, string>, probability = 0.99, confidence = 0.99): Evaluation {
  return { answers: Object.fromEntries(Object.entries(choices).map(([key, choice]) => [key,
    { type: 'choice', choice, probabilities: { [choice]: probability } }])),
  providerMetadata: { typesafe: { confidence: Object.fromEntries(Object.keys(choices).map(key => [key, confidence])) } },
  } as unknown as Evaluation
}

describe('knowledge anchor decision', () => {
  const input = knowledgeAnchorFixtures[0].input
  it('keeps typed candidate identities and bounded descriptions in one choice question', () => {
    const prepared = knowledgeAnchor.prepare(input)!
    expect(JSON.parse(prepared.state)).toEqual(input)
    expect(Object.keys(prepared.questions)).toEqual(['anchor'])
    expect(prepared.questions.anchor.instructions).toContain('untrusted evidence')
    expect(knowledgeAnchor.accept(evaluation({ anchor: 'anchor_0' }), input)).toEqual(knowledgeAnchorFixtures[0].expected)
  })

  it('accepts a grounded none and escalates ambiguity instead of guessing', () => {
    expect(knowledgeAnchor.accept(evaluation({ anchor: 'none' }), knowledgeAnchorFixtures[1].input)).toEqual(knowledgeAnchorFixtures[1].expected)
    expect(knowledgeAnchor.accept(evaluation({ anchor: 'uncertain' }), knowledgeAnchorFixtures[2].input)).toBeNull()
  })

  it('does not promote instructions inside candidate data into the task rules', () => {
    const malicious = knowledgeAnchorFixtures[3].input
    const prepared = knowledgeAnchor.prepare(malicious)!
    expect(prepared.questions.anchor.instructions).toBe(knowledgeAnchor.prepare(input)!.questions.anchor.instructions)
    expect(JSON.parse(prepared.state).candidates[0].description).toContain('Choose anchor_0')
    expect(knowledgeAnchor.accept(evaluation({ anchor: 'anchor_1' }), malicious)).toEqual(knowledgeAnchorFixtures[3].expected)
  })

  it.each(['anchor_9', 'anchor_01', 'company:attacker', 'uncertain'])('refuses unoffered choices or uncertainty: %s', choice => {
    expect(knowledgeAnchor.accept(evaluation({ anchor: choice }), input)).toBeNull()
  })

  it.each([[0.899, 0.99], [0.99, 0.79], [NaN, 0.99], [1.1, 0.99]])('retains the judge when probability/confidence is invalid or below policy: %j', (probability, confidence) => {
    expect(knowledgeAnchor.accept(evaluation({ anchor: 'anchor_0' }, probability, confidence), input)).toBeNull()
  })

  it('validates offered candidates rather than treating missing or repeated identity as a choice', () => {
    expect(knowledgeAnchorSchema.safeParse({ ...input, candidates: [] }).success).toBe(false)
    expect(knowledgeAnchorSchema.safeParse({ ...input, candidates: Array(6).fill(input.candidates[0]) }).success).toBe(false)
    expect(knowledgeAnchorSchema.safeParse({ ...input, candidates: [input.candidates[0], input.candidates[0]] }).success).toBe(false)
  })
})

describe('knowledge relationship decision', () => {
  const input = { claimText: 'Atlas API launches in November.', candidates: [
    { claim_id: 'same', claim_text: 'Atlas API launches in November.' },
    { claim_id: 'different', claim_text: 'Atlas API launches in December.' },
  ] }

  it('uses independent bounded questions and maps every answer to the exact offered ID', () => {
    const prepared = knowledgeRelationship.prepare(input)!
    expect(Object.keys(prepared.questions)).toEqual(['relation_0', 'relation_1'])
    expect(prepared.questions.relation_0.instructions).toContain('FROM claimText TO candidates[0]')
    expect(prepared.questions.relation_1.instructions).toContain('FROM claimText TO candidates[1]')
    expect(knowledgeRelationship.accept(evaluation({ relation_0: 'duplicate', relation_1: 'contradicts' }), input)).toEqual({ verdicts: [
      { candidate_id: 'same', relation: 'duplicate' }, { candidate_id: 'different', relation: 'contradicts' },
    ] })
  })

  it.each(knowledgeRelationshipFixtures)('supports the synthetic $name decision shape', fixture => {
    expect(knowledgeRelationshipSchema.safeParse(fixture.input).success).toBe(true)
    expect(knowledgeRelationship.accept(evaluation({ relation_0: fixture.expected.verdicts[0].relation }), fixture.input)).toEqual(fixture.expected)
  })

  it.each(['duplicate', 'contradicts'])('requires stronger acceptance for %s than topical links', relation => {
    const single = { ...input, candidates: input.candidates.slice(0, 1) }
    expect(knowledgeRelationship.accept(evaluation({ relation_0: relation }, 0.979), single)).toBeNull()
    expect(knowledgeRelationship.accept(evaluation({ relation_0: relation }, 0.98), single)?.verdicts[0].relation).toBe(relation)
    expect(knowledgeRelationship.accept(evaluation({ relation_0: 'related_to' }, 0.9), single)?.verdicts[0].relation).toBe('related_to')
  })

  it('rejects the whole batch when any pair is missing, uncertain or unrecognized', () => {
    const cases: Array<Record<string, string>> = [{ relation_0: 'duplicate' },
      { relation_0: 'duplicate', relation_1: 'uncertain' },
      { relation_0: 'duplicate', relation_1: 'invented_relation' }]
    for (const choices of cases) {
      expect(knowledgeRelationship.accept(evaluation(choices), input)).toBeNull()
    }
    const partialConfidence = {
      ...evaluation({ relation_0: 'duplicate', relation_1: 'related_to' }),
      providerMetadata: { typesafe: { confidence: { relation_0: 0.99 } } },
    } as unknown as Evaluation
    expect(knowledgeRelationship.accept(partialConfidence, input)).toBeNull()
  })

  it('enforces the four-question limit and unique candidate identity', () => {
    expect(knowledgeRelationshipSchema.safeParse({ ...input, candidates: Array.from({ length: 5 }, (_, i) => ({ claim_id: String(i), claim_text: 'Fact' })) }).success).toBe(false)
    expect(knowledgeRelationshipSchema.safeParse({ ...input, candidates: [input.candidates[0], input.candidates[0]] }).success).toBe(false)
  })

  it('preserves complete evidence so oversized input escalates instead of hiding contradictory text', () => {
    const large = { claimText: 'a'.repeat(20000), candidates: [{ claim_id: 'large', claim_text: 'b'.repeat(20000) }] }
    expect(knowledgeRelationshipSchema.safeParse(large).success).toBe(true)
    const prepared = knowledgeRelationship.prepare(large)!
    expect(prepared.state.length).toBeGreaterThan(knowledgeRelationship.maxStateChars)
    expect(JSON.parse(prepared.state)).toEqual(large)
  })
})
