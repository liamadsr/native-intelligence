/**
 * email.trust on the reply gate's call (email-reply-v4, A5 slice 1): the two
 * trust questions, the trust-only call, the asymmetric policy, and the
 * labelled fixtures the live evaluation runs.
 */
import { describe, expect, it } from 'vitest'
import type { Evaluation } from '../contracts'
import { emailReply, trustVerdict, TRUST_QUESTIONS } from '../tasks/email-reply'
import { emailReplyFixtures } from './email-reply-fixtures'
import { emailTrustFixtures } from './email-trust-fixtures'

const input = emailReplyFixtures[0].input
const answers = (values: Record<string, unknown>) => ({
  answers: Object.fromEntries(Object.entries(values).map(([key, probability]) => [key, { type: 'boolean', probability }])),
}) as unknown as Evaluation

describe('email-reply-v5 questions', () => {
  it('is a new version (the cache key changes) and asks reply + phishing + injection on a complete thread', () => {
    expect(emailReply.version).toBe('email-reply-v5')
    expect(Object.keys(emailReply.prepare(input)!.questions)).toEqual(['reply', 'phishing', 'injection'])
    expect(TRUST_QUESTIONS).toEqual(['phishing', 'injection'])
  })

  it('asks only the trust questions on a trust-only call, even for incomplete evidence, and says attachments are unseen', () => {
    const prepared = emailReply.prepare({ ...input, complete: false, trustOnly: true, attachmentsUnseen: true })!
    expect(Object.keys(prepared.questions)).toEqual(['phishing', 'injection'])
    expect(JSON.parse(prepared.state).note).toMatch(/Attachment contents are not shown/)
  })

  it('still refuses the reply question on incomplete evidence', () => {
    expect(emailReply.prepare({ ...input, complete: false })).toBeNull()
  })
})

describe('the trust policy (safe ≤ 0.1 both, flag ≥ 0.9, else uncertain)', () => {
  it.each([
    [0, 0, 'safe'], [0.1, 0.1, 'safe'], [0.9, 0, 'phishing'], [0.99, 0.95, 'phishing'], [0.05, 0.9, 'injection'],
    [0.11, 0, 'uncertain'], [0, 0.5, 'uncertain'], [0.89, 0.89, 'uncertain'], [null, 0, 'uncertain'], [0, null, 'uncertain'],
    [null, 0.95, 'injection'],
  ] as const)('phishing %s, injection %s → %s', (phishing, injection, expected) => {
    expect(trustVerdict(phishing, injection)).toBe(expected)
  })

  it('carries the trust verdict beside a decisive reply answer', () => {
    expect(emailReply.accept(answers({ reply: 0.95, phishing: 0.02, injection: 0.01 }), input))
      .toEqual({ replyRequired: true, probability: 0.95, trust: 'safe', phishing: 0.02, injection: 0.01 })
  })

  it('accepts a decisive trust verdict even when the reply answer is uncertain', () => {
    expect(emailReply.accept(answers({ reply: 0.5, phishing: 0.97, injection: 0.02 }), input))
      .toEqual({ replyRequired: null, probability: null, trust: 'phishing', phishing: 0.97, injection: 0.02 })
  })

  it('escalates (null) when nothing is decisive, so drafting is preserved and nothing is cached', () => {
    expect(emailReply.accept(answers({ reply: 0.5, phishing: 0.5, injection: 0 }), input)).toBeNull()
  })

  it('a trust-only call never answers the reply question, and ignores a supplied reply answer', () => {
    const trustOnly = { ...input, complete: false, trustOnly: true }
    expect(emailReply.accept(answers({ reply: 0.01, phishing: 0, injection: 0 }), trustOnly))
      .toEqual({ replyRequired: null, probability: null, trust: 'safe', phishing: 0, injection: 0 })
    // Uncertain but valid: accepted (and so cached for this revision), applying nothing.
    expect(emailReply.accept(answers({ phishing: 0.5, injection: 0 }), trustOnly))
      .toEqual({ replyRequired: null, probability: null, trust: 'uncertain', phishing: 0.5, injection: 0 })
    // A missing answer is not cached.
    expect(emailReply.accept(answers({ phishing: 0.5 }), trustOnly)).toBeNull()
  })

  it.each([NaN, Infinity, -1, 2, '0.99', undefined])('treats an invalid trust probability as missing: %s', bad => {
    expect(emailReply.accept(answers({ reply: 0.5, phishing: bad, injection: bad }), input)).toBeNull()
  })
})

describe('labelled email.trust fixtures', () => {
  it('has about 30 cases: the 25 reply fixtures plus phishing, injection and hard negatives', () => {
    expect(emailTrustFixtures.length).toBeGreaterThanOrEqual(30)
    const count = (label: string) => emailTrustFixtures.filter(f => f.expected === label).length
    // The enforce gate needs these floors before the eval can gate enforcing (A5 review).
    expect(count('phishing')).toBeGreaterThanOrEqual(10)
    expect(emailTrustFixtures.filter(f => f.input.trustOnly).length).toBeGreaterThanOrEqual(5)
    expect(count('injection')).toBeGreaterThanOrEqual(3)
    expect(count('safe')).toBeGreaterThanOrEqual(25)
    expect(new Set(emailTrustFixtures.map(f => f.name)).size).toBe(emailTrustFixtures.length)
  })

  it('every fixture prepares within the budget and asks the trust questions', () => {
    for (const fixture of emailTrustFixtures) {
      const prepared = emailReply.prepare(fixture.input)
      expect(prepared, fixture.name).not.toBeNull()
      expect(prepared!.state.length, fixture.name).toBeLessThanOrEqual(emailReply.maxStateChars)
      expect(Object.keys(prepared!.questions), fixture.name).toEqual(expect.arrayContaining(['phishing', 'injection']))
    }
  })

  it('a fixture\'s injected instructions stay in the evidence, never in the questions', () => {
    for (const fixture of emailTrustFixtures.filter(f => f.expected === 'injection')) {
      const prepared = emailReply.prepare(fixture.input)!
      const questionText = JSON.stringify(prepared.questions)
      for (const message of fixture.input.messages) expect(questionText).not.toContain(message.body.slice(0, 40))
    }
  })

  it('answers matching each label produce that label (the evaluation harness agrees with the policy)', () => {
    const probabilities = { safe: [0.02, 0.02], phishing: [0.97, 0.03], injection: [0.03, 0.97] } as const
    for (const fixture of emailTrustFixtures) {
      const [phishing, injection] = probabilities[fixture.expected]
      const value = emailReply.accept(answers({ reply: 0.5, phishing, injection }), fixture.input)
      expect(value?.trust, fixture.name).toBe(fixture.expected)
    }
  })
})
