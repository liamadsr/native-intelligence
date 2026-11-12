import { z } from 'zod'

/** Portable, content-free results. Uploaded reports never authorize application actions. */
export const evaluationKinds = ['browser.next_action', 'email.reply_required', 'knowledge.anchor',
  'knowledge.relationship', 'knowledge.extraction_required', 'retrieval.relevance', 'automation.reconcile_required',
  // A5: email.trust (the trust answers of email-reply-v4, scored on their own) and the reviewer.
  'email.trust', 'action.review',
  // Auto model selection: model.tier (chat and helper tasks the rules left undecided).
  'model.tier',
  // The router (A6): event.needs_person, deciding where it is proven.
  'event.needs_person',
  // Live sidekick Phase 7: nudge.worth (shadow), false suppression the key metric.
  'nudge.worth',
  // Email through the agent (E1): email.understand, a missed "should know" the key metric.
  'email.understand',
  // Arriving confirmations close a matching open to-do: a wrong close the key metric.
  'action.done_by_email',
  // Meeting prep's check (live): a skipped real meeting the key metric (false suppression).
  'meeting.needs_prep',
  // Records kept up to date from mail, meetings and texts: a wrong change the key metric.
  'record.kept_up_to_date'] as const
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const amount = z.number().finite().nonnegative()
const shortText = z.string().min(1).max(160)
const evaluationCaseSchema = z.object({
  id: shortText,
  kind: z.enum(evaluationKinds),
  taskVersion: shortText,
  status: z.enum(['accepted', 'escalated', 'error']),
  correct: z.boolean().nullable(),
  falseSuppression: z.boolean(),
  /** action.review: an accepted decision that ALLOWED a call the fixture says must be blocked. Absent on older reports. */
  falseAllow: z.boolean().default(false),
  providerMs: amount,
  deadlineMs: amount.positive(),
  inputTokens: count.nullable(),
  outputTokens: count.nullable(),
  costUsd: amount.nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.status === 'accepted') !== (value.correct !== null)) {
    ctx.addIssue({ code: 'custom', message: 'Only accepted decisions have a correctness label.' })
  }
  if (value.falseSuppression && (value.status !== 'accepted' || value.correct !== false)) {
    ctx.addIssue({ code: 'custom', message: 'A false suppression must be an incorrect accepted decision.' })
  }
  if (value.falseAllow && (value.status !== 'accepted' || value.correct !== false)) {
    ctx.addIssue({ code: 'custom', message: 'A false allow must be an incorrect accepted decision.' })
  }
})

export const evaluationReportSchema = z.object({
  schemaVersion: z.literal(1),
  provenance: z.literal('synthetic'),
  dataset: shortText,
  createdAt: z.iso.datetime(),
  model: shortText,
  gitCommit: z.string().regex(/^[a-f0-9]{7,40}$/).nullable(),
  reverseChoices: z.boolean(),
  latencyScope: z.literal('provider_roundtrip'),
  plannedCases: count.max(1000),
  cases: z.array(evaluationCaseSchema).max(1000),
}).strict().superRefine((report, ctx) => {
  if (report.cases.length > report.plannedCases) {
    ctx.addIssue({ code: 'custom', message: 'Completed cases exceed the planned case count.' })
  }
  if (new Set(report.cases.map(value => value.id)).size !== report.cases.length) {
    ctx.addIssue({ code: 'custom', message: 'Case IDs must be unique.' })
  }
})

export type EvaluationCase = z.infer<typeof evaluationCaseSchema>
export type DecisionEvaluationReport = z.infer<typeof evaluationReportSchema>
export interface EvaluationFeatureSummary {
  kind: EvaluationCase['kind']
  total: number
  acceptedCorrect: number
  acceptedIncorrect: number
  escalated: number
  errors: number
  falseSuppressions: number
  /** action.review's enforce gate: must be 0 on the fixtures. */
  falseAllows: number
  overDeadline: number
  inputTokens: number
  outputTokens: number
  unknownTokenCases: number
  knownCostUsd: number
  unknownCostCases: number
  p50ProviderMs: number | null
  p95ProviderMs: number | null
}

export function parseEvaluationReport(text: string): DecisionEvaluationReport {
  if (new TextEncoder().encode(text).length > 2 * 1024 * 1024) throw new Error('Evaluation report exceeds 2 MB.')
  return evaluationReportSchema.parse(JSON.parse(text))
}

/** Nearest-rank percentiles; empty sets stay unknown instead of becoming zero. */
function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]
}

export function summarizeEvaluationReport(report: DecisionEvaluationReport): EvaluationFeatureSummary[] {
  return evaluationKinds.flatMap(kind => {
    const cases = report.cases.filter(item => item.kind === kind)
    if (!cases.length) return []
    return [{
      kind, total: cases.length,
      acceptedCorrect: cases.filter(item => item.status === 'accepted' && item.correct === true).length,
      acceptedIncorrect: cases.filter(item => item.status === 'accepted' && item.correct === false).length,
      escalated: cases.filter(item => item.status === 'escalated').length,
      errors: cases.filter(item => item.status === 'error').length,
      falseSuppressions: cases.filter(item => item.falseSuppression).length,
      falseAllows: cases.filter(item => item.falseAllow).length,
      overDeadline: cases.filter(item => item.providerMs > item.deadlineMs).length,
      inputTokens: cases.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
      outputTokens: cases.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
      unknownTokenCases: cases.filter(item => item.inputTokens === null || item.outputTokens === null).length,
      knownCostUsd: cases.reduce((sum, item) => sum + (item.costUsd ?? 0), 0),
      unknownCostCases: cases.filter(item => item.costUsd === null).length,
      p50ProviderMs: percentile(cases.filter(item => item.status !== 'error').map(item => item.providerMs), 0.5),
      p95ProviderMs: percentile(cases.filter(item => item.status !== 'error').map(item => item.providerMs), 0.95),
    }]
  })
}
