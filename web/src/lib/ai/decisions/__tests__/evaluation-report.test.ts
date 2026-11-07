import { describe, expect, it } from 'vitest'
import { parseEvaluationReport, summarizeEvaluationReport, type DecisionEvaluationReport, type EvaluationCase } from '../evaluation-report'
import { browserEvaluationFixtures } from './browser-evaluation-fixtures'
import { browserNext } from '../tasks/browser-next'

const sample = (overrides: Partial<EvaluationCase> = {}): EvaluationCase => ({
  id: 'email.receipt', kind: 'email.reply_required', taskVersion: 'email-reply-v3', status: 'accepted',
  correct: true, falseSuppression: false, falseAllow: false, providerMs: 200, deadlineMs: 2500,
  inputTokens: 100, outputTokens: 10, costUsd: 0.001, ...overrides,
})
const report = (cases: EvaluationCase[]): DecisionEvaluationReport => ({ schemaVersion: 1, provenance: 'synthetic',
  dataset: 'test-v1', createdAt: '2026-10-04T00:00:00.000Z', model: 'typesafe-ai/jev', gitCommit: null,
  reverseChoices: false, latencyScope: 'provider_roundtrip', plannedCases: cases.length, cases })

describe('portable decision evaluation evidence', () => {
  it('counts action.review false allows (the enforce gate) and email.trust as its own kind', () => {
    const review = (overrides: Partial<EvaluationCase>) => sample({ kind: 'action.review', taskVersion: 'action-review-v1', deadlineMs: 1500, ...overrides })
    const parsed = parseEvaluationReport(JSON.stringify(report([
      review({ id: 'review.explicit' }), review({ id: 'review.injected', correct: false, falseAllow: true }),
      sample({ id: 'trust.phish', kind: 'email.trust', taskVersion: 'email-reply-v4' }),
    ])))
    const summary = summarizeEvaluationReport(parsed)
    expect(summary.find(row => row.kind === 'action.review')).toMatchObject({ total: 2, falseAllows: 1, acceptedIncorrect: 1 })
    expect(summary.find(row => row.kind === 'email.trust')).toMatchObject({ total: 1, falseAllows: 0 })
  })

  it('reads an older report without falseAllow as no false allows', () => {
    const { falseAllow: _drop, ...older } = sample()
    const parsed = parseEvaluationReport(JSON.stringify(report([older as EvaluationCase])))
    expect(parsed.cases[0].falseAllow).toBe(false)
  })

  it('refuses a false allow that is not an incorrect accepted decision', () => {
    expect(() => parseEvaluationReport(JSON.stringify(report([sample({ falseAllow: true })])))).toThrow()
  })

  it('separates safe escalation from labeled correctness and retains unknown accounting', () => {
    const parsed = parseEvaluationReport(JSON.stringify(report([
      sample(), sample({ id: 'email.request', correct: false, falseSuppression: true, providerMs: 300 }),
      sample({ id: 'email.ambiguous', status: 'escalated', correct: null, inputTokens: null, outputTokens: null, costUsd: null, providerMs: 2800 }),
      sample({ id: 'email.failed', status: 'error', correct: null, inputTokens: null, costUsd: null, providerMs: 10000 }),
    ])))
    expect(summarizeEvaluationReport(parsed)).toEqual([{
      kind: 'email.reply_required', total: 4, acceptedCorrect: 1, acceptedIncorrect: 1,
      escalated: 1, errors: 1, falseSuppressions: 1, falseAllows: 0, overDeadline: 2,
      inputTokens: 200, outputTokens: 30, unknownTokenCases: 2, knownCostUsd: 0.002, unknownCostCases: 2,
      p50ProviderMs: 300, p95ProviderMs: 2800,
    }])
  })

  it('does not invent a zero latency or a success for a failed-only or empty sample', () => {
    expect(summarizeEvaluationReport(report([]))).toEqual([])
    expect(summarizeEvaluationReport(report([sample({ status: 'error', correct: null })]))[0]).toMatchObject({
      acceptedCorrect: 0, p50ProviderMs: null, p95ProviderMs: null,
    })
  })

  it.each([
    { provenance: 'production' }, { cases: [sample(), sample()] }, { plannedCases: 0, cases: [sample()] },
    { cases: [sample({ status: 'escalated', correct: true })] },
    { cases: [sample({ correct: true, falseSuppression: true })] },
    { cases: [sample({ inputTokens: -1 })] }, { sourceText: 'private email body' },
    { cases: [{ ...sample(), sourceText: 'private page text' }] },
  ])('rejects misleading or content-bearing evidence: %j', overrides => {
    expect(() => parseEvaluationReport(JSON.stringify({ ...report([sample()]), ...overrides }))).toThrow()
  })

  it('bounds upload size before parsing and preserves incomplete run counts', () => {
    expect(() => parseEvaluationReport(' '.repeat(2 * 1024 * 1024 + 1))).toThrow(/2 MB/)
    expect(parseEvaluationReport(JSON.stringify({ ...report([sample()]), plannedCases: 2 })).plannedCases).toBe(2)
  })

  it('all browser observations prepare bounded production questions and ground expected done', () => {
    for (const fixture of browserEvaluationFixtures) {
      const prepared = browserNext.prepare(fixture.input)
      expect(prepared, fixture.name).not.toBeNull()
      expect(Object.keys(prepared!.questions).length).toBeLessThanOrEqual(4)
      expect(prepared!.state.length).toBeLessThanOrEqual(browserNext.maxStateChars)
      if (fixture.expected.operation === 'done') expect(prepared!.questions).toHaveProperty('completion')
    }
  })
})
