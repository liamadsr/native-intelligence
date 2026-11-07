import 'server-only'
import { z } from 'zod'
import { runUtilityTask } from '@/lib/eve/utility/run-utility'
import type { DecisionKind } from './registry'
import type { Evaluation, Questions } from './contracts'

/**
 * A Jev decision on a free user's own ChatGPT plan (the free tier,
 * docs/plans/chatgpt-free-tier.md). Jev (typesafe-ai/jev) runs on the AI
 * Gateway on Dial8's key, so it never runs for them; without an answer these
 * decisions escalate, and a free user got no automatic email drafts, no
 * `email.arrived` events and a browser agent that couldn't pick its steps.
 *
 * Here the task's own `prepare()` state and questions go to the utility agent
 * on the person's plan (the `plan_decision` kind, its helper model), and the
 * answers map back onto Jev's result shape so the task's own `accept()` still
 * decides. The plan model has no calibrated probabilities, so the mapping is
 * deliberately coarse: a choice it is sure of clears Jev's thresholds
 * (trustedChoice: ≥ 0.85, confidence ≥ 0.8), one it isn't sure of never does;
 * a boolean is a clear yes (0.9), a clear no (0.1) or unsure (0.5, which every
 * task reads as unsure). Unsure means the system asks or escalates, as with
 * an unsure Jev.
 */

/** How a decision runs on the plan. */
export interface PlanDecisionPolicy {
  /** Its deadline there: a model call through eve takes seconds where Jev takes under one. */
  deadlineMs: number
  /**
   * Boolean questions whose answers are recorded but never applied on the
   * plan: a "yes" maps just under every flag bar (PLAN_RECORDED_YES). The
   * trust questions: marking a thread phishing drops its draft on every
   * copy, which an uncalibrated yes must not do.
   */
  recordOnly?: readonly string[]
}

/**
 * The decisions that run on the plan. The browser's fit the decision route's
 * 20 s with room to spare (a step may ask browser.next_action, then
 * browser.completion, then resolve a field's text); email.reply_required's
 * fits a drafting pass that may judge many threads. meeting.needs_prep runs
 * from the 5-minute meeting sweep, one event at a time, so a few seconds fit
 * (every feature is on for everyone: a free user's trip fills their thread
 * with preps too); an unsure plan answer is `prep`, as an unsure Jev's. Every
 * other kind escalates for a person on the plan, as before: its caller falls
 * back on its own (the knowledge judges already run on the plan) or the
 * decision is only measured (shadow).
 */
export const PLAN_DECISIONS: Partial<Record<DecisionKind, PlanDecisionPolicy>> = {
  'email.reply_required': { deadlineMs: 15_000, recordOnly: ['phishing', 'injection'] },
  'email.understand': { deadlineMs: 20_000 },
  'browser.next_action': { deadlineMs: 6_000 },
  'browser.completion': { deadlineMs: 6_000 },
  'meeting.needs_prep': { deadlineMs: 6_000 },
}

/** Jev's answer values a plan answer maps to (see the header). */
export const PLAN_SURE = 0.9
export const PLAN_UNSURE = 0.5
export const PLAN_YES = 0.9
export const PLAN_NO = 0.1
/** A recorded-only "yes" (PlanDecisionPolicy.recordOnly): under every flag bar (the trust questions' 0.9). */
export const PLAN_RECORDED_YES = 0.85

const planAnswers = z.object({
  answers: z
    .array(
      z.object({
        key: z.string().max(200),
        choice: z.string().max(300).optional(),
        sure: z.boolean().optional(),
        answer: z.enum(['yes', 'no', 'unsure']).optional(),
      }),
    )
    .max(8),
})
export type PlanAnswers = z.infer<typeof planAnswers>

/** The task message: the state as Jev gets it, and each question with its options. Pure. */
export function planDecisionMessage(state: string, questions: Questions): string {
  return JSON.stringify({
    state,
    questions: Object.entries(questions).map(([key, q]) => {
      const question = q as { type: string; instructions?: string; criteria?: Record<string, string> }
      return {
        key,
        type: question.type,
        instructions: question.instructions ?? '',
        ...(question.type === 'choice' && question.criteria ? { options: question.criteria } : {}),
      }
    }),
  })
}

/**
 * The plan's answers as Jev's result (see the header), for the task's own
 * accept(). A choice outside its options, a malformed entry or a question
 * type other than choice and boolean is left out (the task reads it as no
 * answer). Pure.
 */
export function planEvaluation(
  questions: Questions,
  parsed: PlanAnswers,
  meta: { model: string; inputTokens: number; outputTokens: number },
  opts: { recordOnly?: readonly string[] } = {},
): Evaluation {
  const answers: Record<string, unknown> = {}
  const confidence: Record<string, number> = {}
  for (const entry of parsed.answers) {
    const question = questions[entry.key] as { type: string; criteria?: Record<string, string> } | undefined
    if (!question || entry.key in answers) continue
    if (question.type === 'choice') {
      if (!entry.choice || !question.criteria || !Object.hasOwn(question.criteria, entry.choice)) continue
      const p = entry.sure === true ? PLAN_SURE : PLAN_UNSURE
      // A full distribution, as Jev's (browserChoice checks it sums to 1 with
      // the choice on top): the rest shared evenly by the other options.
      const others = Object.keys(question.criteria).filter((option) => option !== entry.choice)
      const share = others.length ? (1 - p) / others.length : 0
      const probabilities = Object.fromEntries([[entry.choice, others.length ? p : 1], ...others.map((option) => [option, share])])
      answers[entry.key] = { type: 'choice', choice: entry.choice, probabilities }
      confidence[entry.key] = p
    } else if (question.type === 'boolean') {
      if (!entry.answer) continue
      const yes = opts.recordOnly?.includes(entry.key) ? PLAN_RECORDED_YES : PLAN_YES
      answers[entry.key] = { type: 'boolean', probability: entry.answer === 'yes' ? yes : entry.answer === 'no' ? PLAN_NO : PLAN_UNSURE }
    }
  }
  return {
    answers,
    usage: { inputTokens: meta.inputTokens, outputTokens: meta.outputTokens },
    providerMetadata: { typesafe: { confidence } },
    response: { id: `plan:${meta.model}`, modelId: meta.model, timestamp: new Date() },
  } as unknown as Evaluation
}

/** The answers in a model's text: the JSON object, also when fenced or wrapped in a sentence. Pure. */
export function parsePlanAnswers(text: string): PlanAnswers | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = planAnswers.safeParse(JSON.parse(text.slice(start, end + 1)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export interface PlanDecisionResult {
  evaluation: Evaluation
  model: string
  inputTokens: number
  outputTokens: number
}

/**
 * Answer one prepared decision on the person's plan. Throws when the session
 * fails or its answer can't be read (runDecision then escalates, as for a Jev
 * failure); `signal` and `timeoutMs` bound it.
 */
export async function decideOnPlan(
  prepared: { state: string; questions: Questions },
  ctx: { userId: string; workspaceId: string; signal: AbortSignal; timeoutMs: number; recordOnly?: readonly string[] },
): Promise<PlanDecisionResult> {
  const result = await runUtilityTask({
    kind: 'plan_decision',
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    chatgptPlan: true,
    signal: ctx.signal,
    timeoutMs: Math.max(1, ctx.timeoutMs),
    message: planDecisionMessage(prepared.state, prepared.questions),
  })
  const parsed = parsePlanAnswers(result.text)
  if (!parsed) throw new Error('[plan-decision] the answer could not be read')
  const meta = { model: result.model, inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens }
  return { evaluation: planEvaluation(prepared.questions, parsed, meta, { recordOnly: ctx.recordOnly }), ...meta }
}
