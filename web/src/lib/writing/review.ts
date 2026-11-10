/**
 * reviewDraft: the fresh-eyes review of one draft (plan P1), as the utility
 * kind `draft_review` on the eve utility agent.
 *
 * The writer never judges its own work:
 *   - the reviewer gets ONLY the surface (a token param that picks its rubric,
 *     src/lib/eve/utility/prompts.ts draftReviewInstructions) and the draft
 *     text (the task message, inside an untrusted-content marker). Never the
 *     thread, the writer's prompt or the workspace context;
 *   - it runs on another vendor than the writer (pickReviewerModel), and the
 *     spec route refuses a token that breaks that rule.
 *
 * Usage is logged like every other utility kind: feature 'draft_review',
 * against the model that ran, with the surface in the metadata.
 *
 * Throws when the call fails (timeout, failed session, invalid structured
 * output). Callers treat a throw as "no review" and keep the draft.
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { logUsage } from '@/lib/ai/auth'
import { usageProviderLabel } from '@/lib/ai/models'
import { differentPlanModels, differentVendors, pickReviewerModel, planReviewerModel } from '@/lib/ai/reviewer-model'
import { usageCacheMetadata } from '@/lib/chat/eve-usage'
import { wrapUntrusted } from '@/lib/email/untrusted'
import {
  runUtilityTask,
  type UtilityObjectResult,
  type UtilityRunUsage,
  type UtilityUsageReport,
} from '@/lib/eve/utility/run-utility'
import type { WritingSeverity } from './rules'

/** What the reviewer answers. Lenient on purpose: limits are applied after parsing. */
export const DraftReviewSchema = z.object({
  verdict: z.enum(['ready', 'revise']),
  issues: z.array(
    z.object({
      severity: z.enum(['high', 'medium', 'low']),
      rule: z.string(),
      quote: z.string(),
      fix: z.string(),
    }),
  ),
})

export type DraftReviewAnswer = z.infer<typeof DraftReviewSchema>

export interface ReviewIssue {
  severity: WritingSeverity
  rule: string
  quote: string
  fix: string
}

export interface DraftReview {
  verdict: 'ready' | 'revise'
  issues: ReviewIssue[]
  /** The bare app model id the reviewer ran on. */
  model: string
}

/** Most draft characters a review reads. A longer draft is reviewed by its start. */
export const MAX_REVIEW_CHARS = 12_000
/** Most issues kept from one review. */
export const MAX_REVIEW_ISSUES = 8

const SEVERITY_ORDER: Record<WritingSeverity, number> = { high: 0, medium: 1, low: 2 }

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`
}

/**
 * The stored shape of an answer: issues clipped, unquoted ones dropped, high
 * first, at most MAX_REVIEW_ISSUES. The verdict follows the issues: 'revise'
 * whenever a high or medium issue is left, and a 'revise' with nothing to fix
 * is 'ready'. Pure.
 */
export function normalizeReview(answer: DraftReviewAnswer, model: string): DraftReview {
  const issues = answer.issues
    .map((issue) => ({
      severity: issue.severity,
      rule: clip(issue.rule, 40) || 'other',
      quote: clip(issue.quote, 160),
      fix: clip(issue.fix, 300),
    }))
    // An issue that can't quote the draft isn't one (the prompt says so too).
    .filter((issue) => issue.quote.length > 0)
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
    .slice(0, MAX_REVIEW_ISSUES)
  const blocking = issues.some((issue) => issue.severity !== 'low')
  const verdict = blocking || (answer.verdict === 'revise' && issues.length > 0) ? 'revise' : 'ready'
  return { verdict, issues, model }
}

/** The reviewer's task message: the draft, fenced as data. */
export function buildReviewMessage(text: string): string {
  const draft = text.length > MAX_REVIEW_CHARS ? text.slice(0, MAX_REVIEW_CHARS) : text
  return `## Draft\n${wrapUntrusted(draft, 'WORKSPACE') ?? ''}\n\nReview this draft.`
}

export interface ReviewDraftArgs {
  /** A writing surface id (src/lib/writing/surfaces.ts), e.g. 'email'. */
  surface: string
  text: string
  /** The bare app model id (or Gateway slug) that wrote the draft. */
  writerModel: string
  userId: string
  workspaceId: string | null
  supabase?: SupabaseClient
  /** Which pass asked, for the usage row's metadata ('content_review' for a post). Absent: the draft pass. */
  pass?: string
  /**
   * The person runs on their own ChatGPT plan (the free tier): the review
   * runs on it too, on the plan's other model (planReviewerModel), never
   * Native Intelligence's models.
   */
  chatgptPlan?: boolean
}

/**
 * Review one draft. See the module doc.
 *
 * Billing follows the session, not the answer: usage comes from
 * runUtilityTask's onUsage report, which fires for every dispatched session,
 * so a review whose structured output failed (tokens spent, nothing usable)
 * is still logged, marked incomplete.
 */
export async function reviewDraft(args: ReviewDraftArgs): Promise<DraftReview> {
  // On the person's own ChatGPT plan: the plan's other model (the plan has
  // only OpenAI's), run on their plan.
  const model = args.chatgptPlan ? planReviewerModel(args.writerModel) : pickReviewerModel(args.writerModel)
  // Decision 13, checked before a token is minted. The spec route refuses the
  // same thing; failing here costs no round trip.
  if (args.chatgptPlan ? !differentPlanModels(model, args.writerModel) : !differentVendors(model, args.writerModel)) {
    console.warn(`[writing] no reviewer from another vendor than ${args.writerModel}; review skipped`)
    throw new Error(`[writing] no reviewer from another vendor than ${args.writerModel}`)
  }
  const startTime = Date.now()
  let report: UtilityUsageReport | undefined
  let result: UtilityObjectResult<DraftReviewAnswer> | undefined
  try {
    result = await runUtilityTask({
      kind: 'draft_review',
      model,
      ...(args.chatgptPlan ? { chatgptPlan: true, planModel: model } : {}),
      ...(args.supabase ? { supabase: args.supabase } : {}),
      workspaceId: args.workspaceId,
      userId: args.userId,
      params: { surface: args.surface, writerModel: args.writerModel },
      message: buildReviewMessage(args.text),
      outputSchema: DraftReviewSchema,
      onUsage: (usage) => {
        report = usage
      },
    })
  } finally {
    await logRunUsage(args.userId, 'draft_review', report, result, startTime, { surface: args.surface, ...(args.pass ? { pass: args.pass } : {}) })
  }
  return normalizeReview(result.object, result.model)
}

/**
 * Log one utility session's usage: from its onUsage report when there is one
 * (it covers failed sessions too), else from the result. Nothing when the
 * session never dispatched. A session that produced no result is marked
 * `incomplete` in the metadata.
 */
export async function logRunUsage(
  userId: string,
  feature: string,
  report: UtilityUsageReport | undefined,
  result: { model: string; usage: UtilityRunUsage } | undefined,
  startTime: number,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const usage = report?.usage ?? result?.usage
  const model = report?.model ?? result?.model
  if (!usage || !model) return
  const extra = { ...metadata, ...usageCacheMetadata(usage), ...(result ? {} : { incomplete: true }) }
  await logUsage(userId, {
    provider: usageProviderLabel(model),
    model,
    feature,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    durationMs: Date.now() - startTime,
    costUsd: usage.costUsd ?? undefined,
    ...(Object.keys(extra).length > 0 ? { metadata: extra } : {}),
  })
}
