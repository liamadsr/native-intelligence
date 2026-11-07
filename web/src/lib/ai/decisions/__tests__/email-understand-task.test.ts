/**
 * email.understand (docs/plans/email-through-the-agent.md E1): three
 * questions in its own call (the runner's budget is four), the kind only when
 * Jev is sure of it, "should know" and "needs input" only as a clear yes or
 * no, and the labelled fixtures well-formed and within budget.
 */
import { describe, expect, it } from 'vitest'
import type { Evaluation } from '../contracts'
import { decisionTasks } from '../registry'
import { EMAIL_KINDS, KNOW_NO_MAX, KNOW_YES_MIN, clearAnswer, emailUnderstand } from '../tasks/email-understand'
import { emailUnderstandFixtures } from './email-understand-fixtures'

function result(answers: { kind?: [string, number, number]; know?: number; input?: number }): Evaluation {
  const out: Record<string, unknown> = {}
  const confidence: Record<string, number> = {}
  if (answers.kind) {
    const [choice, p, c] = answers.kind
    out.kind = { type: 'choice', choice, probabilities: { [choice]: p } }
    confidence.kind = c
  }
  if (answers.know !== undefined) out.know = { type: 'boolean', probability: answers.know }
  if (answers.input !== undefined) out.input = { type: 'boolean', probability: answers.input }
  return { answers: out, providerMetadata: { typesafe: { confidence } } } as unknown as Evaluation
}

const input = emailUnderstandFixtures[0].input

describe('email.understand', () => {
  it('is registered, and asks three questions in its own call: what it is (pick one), should the owner know, would a reply need them', () => {
    expect(decisionTasks['email.understand']).toBe(emailUnderstand)
    const prepared = emailUnderstand.prepare(input)!
    expect(Object.keys(prepared.questions)).toEqual(['kind', 'know', 'input'])
    const kind = prepared.questions.kind as { type: string; criteria: Record<string, string> }
    expect(kind.type).toBe('choice')
    expect(Object.keys(kind.criteria)).toEqual([...EMAIL_KINDS])
    const state = JSON.parse(prepared.state)
    expect(state).toMatchObject({ messageOrder: 'oldest_first', now: input.now })
    // Every question names the mail as untrusted evidence.
    for (const q of Object.values(prepared.questions)) expect(JSON.stringify(q)).toContain('untrusted evidence')
  })

  it('every fixture fits the runner’s budget (at most four questions; state plus the largest question within 28,000 bytes)', () => {
    const encoder = new TextEncoder()
    for (const f of emailUnderstandFixtures) {
      const prepared = emailUnderstand.prepare(f.input)!
      const sizes = Object.values(prepared.questions).map((q) => encoder.encode(JSON.stringify(q)).length)
      expect(sizes.length, f.name).toBeLessThanOrEqual(4)
      expect(encoder.encode(prepared.state).length + Math.max(...sizes), f.name).toBeLessThanOrEqual(28000)
      expect(prepared.state.length, f.name).toBeLessThanOrEqual(emailUnderstand.maxStateChars)
    }
  })

  it('notes unseen attachments in the state', () => {
    const prepared = emailUnderstand.prepare({ ...input, attachmentsUnseen: true })!
    expect(JSON.parse(prepared.state).note).toContain('Attachment contents are not shown')
  })

  it('keeps the kind only when Jev is sure of it, and a known kind only', () => {
    expect(emailUnderstand.accept(result({ kind: ['meeting', 0.97, 0.95], know: 0.9, input: 0.05 }), input)).toEqual({
      kind: 'meeting', shouldKnow: true, needsInput: false, knowProbability: 0.9, inputProbability: 0.05,
    })
    expect(emailUnderstand.accept(result({ kind: ['meeting', 0.6, 0.95], know: 0.9 }), input)?.kind).toBeNull()
    expect(emailUnderstand.accept(result({ kind: ['meeting', 0.97, 0.5], know: 0.9 }), input)?.kind).toBeNull()
    expect(emailUnderstand.accept(result({ kind: ['gossip', 0.99, 0.99], know: 0.9 }), input)?.kind).toBeNull()
  })

  it('"should know" and "needs input" are a clear yes, a clear no, or unsure', () => {
    expect(clearAnswer(KNOW_YES_MIN)).toBe(true)
    expect(clearAnswer(KNOW_NO_MAX)).toBe(false)
    expect(clearAnswer(0.5)).toBeNull()
    expect(clearAnswer(null)).toBeNull()
    expect(emailUnderstand.accept(result({ know: 0.5, input: 0.6 }), input)).toMatchObject({ shouldKnow: null, needsInput: null, knowProbability: 0.5 })
  })

  it('nothing usable at all escalates (nothing cached)', () => {
    expect(emailUnderstand.accept(result({}), input)).toBeNull()
    expect(emailUnderstand.accept(result({ kind: ['meeting', 0.5, 0.5] }), input)).toBeNull()
  })
})

describe('email.understand fixtures', () => {
  it('are unique, each labels at least one answer, and use only known kinds', () => {
    const names = emailUnderstandFixtures.map((f) => f.name)
    expect(new Set(names).size).toBe(names.length)
    for (const f of emailUnderstandFixtures) {
      expect(Object.keys(f.expected).length, f.name).toBeGreaterThan(0)
      if (f.expected.kind) expect(EMAIL_KINDS as readonly string[]).toContain(f.expected.kind)
    }
  })

  it('cover each kind, both answers of "should know", and the mail that went wrong on 10-18 (a receipt, a relayed request, a far-off terms update)', () => {
    const kinds = new Set(emailUnderstandFixtures.map((f) => f.expected.kind))
    for (const k of EMAIL_KINDS.filter((k) => k !== 'other_notice')) expect(kinds, k).toContain(k)
    const know = emailUnderstandFixtures.map((f) => f.expected.shouldKnow)
    expect(know).toContain(true)
    expect(know).toContain(false)
    for (const name of ['receipt_small_purchase', 'cofounder_platform_relay', 'terms_update_weeks_out']) {
      expect(emailUnderstandFixtures.map((f) => f.name)).toContain(name)
    }
  })
})
