import type { Experimental_DecisionQuestion, Experimental_DecisionResult } from 'ai'
import type { z } from 'zod'

export type Questions = Record<string, Experimental_DecisionQuestion>
export type Evaluation = Experimental_DecisionResult<Questions>
export interface DecisionMetrics {
  timingMs: {
    preparation: number
    authorization: number
    cache: number
    budget: number
    /** Complete evaluateJev roundtrip, including Gateway transport; not model inference alone. */
    provider: number
    acceptance: number
    accounting: number
    total: number
  }
  usage?: {
    inputTokens?: number
    outputTokens?: number
    costUsd?: number
    /** 'chatgpt_plan': the decision ran on the person's own ChatGPT plan, at no cost to Native Intelligence. */
    costSource: 'gateway' | 'catalog' | 'chatgpt_plan' | 'unknown'
    /** Both token counts were supplied by the provider. Missing counts are never estimated. */
    known: boolean
  }
  stateBytes?: number
  questionBytes?: number
  questionCount?: number
  /** Browser decisions only: each choice question's answer as Jev gave it,
   * accepted or not (the same values ai_usage_logs records). */
  answers?: Record<string, { choice: string; probability?: number; confidence?: number }>
}
export type DecisionResult<T> = (
  | { status: 'accepted'; value: T; inferenceId: string; version: string; cached?: boolean }
  | { status: 'escalate'; reason: string; inferenceId?: string }
  | { status: 'cancelled'; reason: string; inferenceId?: string }
) & { metrics?: DecisionMetrics }
export interface DecisionContext {
  userId: string; workspaceId: string; signal?: AbortSignal
  runId?: string
  mode?: 'shadow' | 'enforce'
  /**
   * The questions in this call whose answers are recorded but NOT applied
   * (a new question riding an enforced call while it is measured, such as
   * email-reply-v4's trust questions). Logged as `shadow_questions` beside the
   * answers in ai_usage_logs.metadata; changes nothing else.
   */
  shadowQuestions?: readonly string[]
  /**
   * The id of the thing this decision is about, when a rating can point at it
   * later (nudge.worth: the nudge's chat row ui_message_id, which the person's
   * thumbs record as eval_candidate.ref_id). Logged as `message_id` in
   * ai_usage_logs.metadata; changes nothing else.
   */
  messageId?: string
}
export interface DecisionTask<I, O> {
  version: string
  schema: z.ZodType<I>
  deadlineMs: number
  maxStateChars: number
  prepare(input: I): { state: string; questions: Questions } | null
  accept(result: Evaluation, input: I): O | null
  cache?: boolean
  /**
   * Skip the per-user in-flight cap (2 calls). For a gate that runs on every
   * risky tool call (action.review): parallel calls in one turn must not be
   * refused as busy, which would block them spuriously. The global circuit
   * still applies.
   */
  bypassConcurrencyCap?: boolean
  /** Its own failure circuit instead of the process-wide one (action.review). */
  isolatedCircuit?: boolean
}

export function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

/** Confidence is derived from the choice distribution, not independent corroboration. */
export function trustedChoice(result: Evaluation, key: string): string | null {
  const answer = result.answers[key]
  const confidence = (result.providerMetadata?.typesafe?.confidence as Record<string, unknown> | undefined)?.[key]
  if (answer?.type !== 'choice' || !probability(answer.probabilities?.[answer.choice]) ||
      answer.probabilities![answer.choice] < 0.85 || !probability(confidence) || confidence < 0.8) return null
  return answer.choice
}
