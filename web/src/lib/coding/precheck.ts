/**
 * The coding pre-check (P10; eve-templates-lessons.md F5, Foreman's
 * classifier): before a coding run spends a sandbox, is the action clear
 * enough to build?
 *
 *   - It runs on the utility agent (kind `coding_precheck`, the cheap drafting
 *     model, thinking off), on the action's title and description only,
 *     fenced as untrusted data: an action can come from a meeting transcript,
 *     an email or a teammate, so its text is never instructions.
 *   - "Be decisive; ask only when proceeding risks building the wrong thing."
 *     A `needs_clarification` parks the run BEFORE any sandbox: the run goes
 *     to `needs_input` with its questions in `pending_input`, so the action's
 *     run panel and the starter's chat ask them with the picker every parked
 *     run uses (QuestionCard, RunQuestionSection): "ENG-42's run has a
 *     question" in their home thread, the card under it (P13, never For you). The answer goes through the same
 *     respond route (respond-to-run.ts), is kept on the run, and the run
 *     starts. A run asks at most once: the answer, or a skip, is final.
 *   - It writes the acceptance criteria before any code exists (pattern P5),
 *     stored on the run (agent_run.acceptance_criteria, migration 392). The
 *     coder reads them in its task; the reviewer checks each one against the
 *     real diff (review.ts).
 *
 * Fails OPEN for a person's Start: a pre-check that can't run lets the run go
 * ahead with no criteria (the reviewer then checks the action itself). An
 * unattended start (proactive.ts) treats the same failure as a no.
 */
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { wrapUntrusted } from '@/lib/email/untrusted'
import { runUtilityTask, type UtilityObjectResult, type UtilityUsageReport } from '@/lib/eve/utility/run-utility'
import { logRunUsage } from '@/lib/writing/review'
import { MAX_ISSUE_DESCRIPTION_CHARS } from '@/lib/ai/agent-run-context'
import { mirrorAgentRunStatus } from '@/lib/work/agent-run-mirror'
import type { AskUserAnswer, PendingInput, WorkRunQuestion } from '@/lib/agent-run/types'

/** What the pre-check model answers. Lenient: limits are applied after parsing. */
export const PrecheckSchema = z.object({
  verdict: z.enum(['actionable', 'needs_clarification']),
  questions: z.array(
    z.object({
      question: z.string(),
      options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
    }),
  ),
  acceptance_criteria: z.array(z.string()),
  kind: z.enum(['bug', 'feature', 'chore', 'other']),
  size: z.enum(['small', 'medium', 'large']),
  reason: z.string(),
})
export type PrecheckAnswer = z.infer<typeof PrecheckSchema>

export type PrecheckVerdict = PrecheckAnswer['verdict']

/** One question as the pre-check keeps it: the picker's shape minus its header. */
export interface PrecheckQuestion {
  question: string
  options: Array<{ label: string; description?: string }>
}

/** agent_run.precheck (migration 392). */
export interface PrecheckRecord {
  verdict: PrecheckVerdict
  questions: PrecheckQuestion[]
  kind: PrecheckAnswer['kind'] | null
  size: PrecheckAnswer['size'] | null
  reason: string
  /** The bare app model id that ran it; null when it could not run. */
  model: string | null
  at: string
  /** The model call failed; the run went ahead on the person's Start (fail open). */
  failed?: true
  /** The starter's answers, once they replied (or `skipped`). */
  answers?: AskUserAnswer[]
  skipped?: true
  answered_at?: string
}

export interface PrecheckResult {
  record: PrecheckRecord
  criteria: string[]
}

export const MAX_PRECHECK_QUESTIONS = 3
export const MAX_QUESTION_OPTIONS = 4
export const MAX_ACCEPTANCE_CRITERIA = 8
const CRITERION_MAX_CHARS = 240
const QUESTION_MAX_CHARS = 200
const OPTION_MAX_CHARS = 80
const REASON_MAX_CHARS = 300

/** The header chip the picker shows on a pre-check question. */
export const PRECHECK_QUESTION_HEADER = 'Before I build'

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`
}

/**
 * The stored shape of an answer. Pure. Decisive by construction: a
 * `needs_clarification` with no usable question is `actionable` (there is
 * nothing to ask), and questions on an `actionable` answer are dropped.
 */
export function normalizePrecheck(answer: PrecheckAnswer, model: string, now = new Date()): PrecheckResult {
  const questions: PrecheckQuestion[] = answer.questions
    .map((q) => ({
      question: clip(q.question, QUESTION_MAX_CHARS),
      options: q.options
        .map((o) => ({ label: clip(o.label, OPTION_MAX_CHARS), ...(o.description?.trim() ? { description: clip(o.description, OPTION_MAX_CHARS * 2) } : {}) }))
        .filter((o) => o.label.length > 0)
        .slice(0, MAX_QUESTION_OPTIONS),
    }))
    .filter((q) => q.question.length > 0)
    .slice(0, MAX_PRECHECK_QUESTIONS)
  const verdict: PrecheckVerdict = answer.verdict === 'needs_clarification' && questions.length > 0 ? 'needs_clarification' : 'actionable'
  const criteria = normalizeCriteria(answer.acceptance_criteria)
  return {
    record: {
      verdict,
      questions: verdict === 'needs_clarification' ? questions : [],
      kind: answer.kind,
      size: answer.size,
      reason: clip(answer.reason, REASON_MAX_CHARS),
      model,
      at: now.toISOString(),
    },
    criteria,
  }
}

/** Criteria as stored: one line each, clipped, de-duplicated, at most MAX_ACCEPTANCE_CRITERIA. Pure. */
export function normalizeCriteria(raw: readonly unknown[] | null | undefined): string[] {
  const out: string[] = []
  for (const c of raw ?? []) {
    if (typeof c !== 'string') continue
    // Strip one list marker ("- ", "* ", "• ", "1. ", "2) "), never digits
    // that open the criterion itself ("404 responses…", "2FA codes…").
    const line = clip(c.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, ''), CRITERION_MAX_CHARS)
    if (line && !out.some((o) => o.toLowerCase() === line.toLowerCase())) out.push(line)
    if (out.length >= MAX_ACCEPTANCE_CRITERIA) break
  }
  return out
}

/** The record a pre-check that could not run leaves (fail open). */
export function failedPrecheck(now = new Date()): PrecheckResult {
  return {
    record: { verdict: 'actionable', questions: [], kind: null, size: null, reason: 'The pre-check could not run.', model: null, at: now.toISOString(), failed: true },
    criteria: [],
  }
}

export interface PrecheckAction {
  identifier: string
  title: string
  description: string | null
  repoFullName: string | null
}

/** The pre-check's task message: the action, fenced as data. Pure. */
export function buildPrecheckMessage(action: PrecheckAction): string {
  const description = (action.description ?? '').slice(0, MAX_ISSUE_DESCRIPTION_CHARS)
  const item = [`Title: ${action.title}`, description.trim() ? `Description:\n${description}` : 'Description: (none)'].join('\n')
  return [
    `## Work item ${action.identifier}${action.repoFullName ? ` (repository ${action.repoFullName})` : ''}`,
    wrapUntrusted(item, 'WORKSPACE') ?? '',
    '',
    'Decide whether this is clear enough to build, and write its acceptance criteria.',
  ].join('\n')
}

/**
 * Run the pre-check on one action. Never throws: a failed call is
 * failedPrecheck() (the caller decides what a failure means). Usage is
 * logged under feature 'coding_precheck', a failed session included.
 */
export async function runCodingPrecheck(args: {
  workspaceId: string
  userId: string
  action: PrecheckAction
  supabase?: SupabaseClient
}): Promise<PrecheckResult> {
  const startTime = Date.now()
  let report: UtilityUsageReport | undefined
  let result: UtilityObjectResult<PrecheckAnswer> | undefined
  try {
    result = await runUtilityTask({
      kind: 'coding_precheck',
      ...(args.supabase ? { supabase: args.supabase } : {}),
      workspaceId: args.workspaceId,
      userId: args.userId,
      message: buildPrecheckMessage(args.action),
      outputSchema: PrecheckSchema,
      onUsage: (usage) => {
        report = usage
      },
    })
    return normalizePrecheck(result.object, result.model)
  } catch (err) {
    console.warn('[coding-precheck] could not run; going ahead:', err instanceof Error ? err.message : err)
    return failedPrecheck()
  } finally {
    await logRunUsage(args.userId, 'coding_precheck', report, result, startTime).catch(() => {})
  }
}

// ── Asking: the run parks before any sandbox ─────────────────────────────────

/** The pending_input a pre-check park writes: the picker's shape, marked as a pre-check. */
export interface PrecheckPendingInput extends PendingInput {
  kind: 'precheck'
}

/** Whether a run's pending_input is a pre-check's question (not a mid-run one, not a handoff). */
export function isPrecheckPark(pending: unknown): pending is PrecheckPendingInput {
  return !!pending && typeof pending === 'object' && (pending as { kind?: unknown }).kind === 'precheck'
}

/** The picker's questions for a record's questions. Pure. */
export function precheckQuestions(record: Pick<PrecheckRecord, 'questions'>): WorkRunQuestion[] {
  return record.questions.map((q) => ({
    question: q.question,
    header: PRECHECK_QUESTION_HEADER,
    options: q.options.map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) })),
    multiSelect: false,
  }))
}

/** The park's pending_input. Pure. */
export function precheckPendingInput(agentRunId: string, record: Pick<PrecheckRecord, 'questions'>, now = new Date()): PrecheckPendingInput {
  return {
    kind: 'precheck',
    requestId: `precheck:${agentRunId}`,
    approveOptionId: 'approve',
    denyOptionId: 'cancel',
    questions: precheckQuestions(record),
    askedAt: now.toISOString(),
  }
}

/**
 * Park a run on its pre-check's questions: queued → needs_input with the
 * questions, the action's run status to needs_input (its run panel asks
 * them), the ledger row to needs_input (the home thread asks them, with the
 * work_needs_you push). CAS-guarded on a live, unstarted row; returns
 * whether the park took.
 */
export async function parkOnPrecheck(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string; actionId: string | null; record: PrecheckRecord },
): Promise<boolean> {
  const pending = precheckPendingInput(args.agentRunId, args.record)
  const { data: took } = await supabase
    .from('agent_run')
    .update({ status: 'needs_input', pending_input: pending })
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .in('status', ['queued', 'running'])
    .select('id')
  if (!took || took.length === 0) return false
  if (args.actionId) {
    await supabase.from('actions').update({ agent_run_status: 'needs_input' }).eq('id', args.actionId).eq('workspace_id', args.workspaceId)
  }
  await mirrorAgentRunStatus(supabase, { agentRunId: args.agentRunId, workspaceId: args.workspaceId }, { status: 'needs_input', questions: pending.questions })
  return true
}

// ── The coder's task: what it must do, and what the person said ─────────────

/** The block tags this module adds to a task. Text inside them can't open or close one. */
const BLOCK_TAG_RE = /<(\s*\/?\s*)(acceptance_criteria|clarifications)\b/gi

function defuseBlockTags(text: string): string {
  return text.replace(BLOCK_TAG_RE, '&lt;$1$2')
}

/**
 * What the coder reads after the `<issue>` block: the person's answers to the
 * pre-check's questions, and the acceptance criteria the reviewer will check.
 * Both are fenced: the questions and criteria are a model's reading of
 * untrusted text. Empty when there is neither. Pure.
 */
export function precheckTaskBlock(args: { criteria: readonly string[]; precheck: PrecheckRecord | null }): string {
  const lines: string[] = []
  const answers = args.precheck?.answers ?? []
  if (answers.length > 0) {
    const qa = answers.map((a) => `Q: ${a.question}\nA: ${a.answer || '(no answer)'}`).join('\n\n')
    lines.push(
      'Before this run started, the person who started it answered these questions about the issue:',
      `<clarifications>\n${wrapUntrusted(defuseBlockTags(qa), 'WORKSPACE') ?? ''}\n</clarifications>`,
    )
  } else if (args.precheck?.skipped) {
    lines.push('Before this run started, questions about the issue were asked and the person chose to skip them: use sensible defaults and say which ones in the PR body.')
  }
  if (args.criteria.length > 0) {
    const list = args.criteria.map((c) => `- ${c}`).join('\n')
    lines.push(
      'What the finished change must do. Before the pull request opens, a reviewer on another model checks each line against your real diff:',
      `<acceptance_criteria>\n${wrapUntrusted(defuseBlockTags(list), 'WORKSPACE') ?? ''}\n</acceptance_criteria>`,
    )
  }
  return lines.join('\n')
}

/** Read a stored precheck record, tolerantly (a malformed value reads as none). Pure. */
export function readPrecheckRecord(raw: unknown): PrecheckRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Partial<PrecheckRecord>
  if (r.verdict !== 'actionable' && r.verdict !== 'needs_clarification') return null
  return {
    verdict: r.verdict,
    questions: Array.isArray(r.questions) ? r.questions : [],
    kind: r.kind ?? null,
    size: r.size ?? null,
    reason: typeof r.reason === 'string' ? r.reason : '',
    model: typeof r.model === 'string' ? r.model : null,
    at: typeof r.at === 'string' ? r.at : '',
    ...(r.failed ? { failed: true as const } : {}),
    ...(Array.isArray(r.answers) ? { answers: r.answers } : {}),
    ...(r.skipped ? { skipped: true as const } : {}),
    ...(typeof r.answered_at === 'string' ? { answered_at: r.answered_at } : {}),
  }
}

// ── The step before the sandbox (agentRunExecute) ───────────────────────────

export interface PrecheckStepResult {
  /** The run parked on its questions: start no session. */
  parked: boolean
  /** A pre-check ran in this step (false: already done, or nothing to check). */
  ran: boolean
  verdict?: PrecheckVerdict
}

/**
 * The pre-check step of a coding run, before its eve session (and sandbox)
 * is created. Runs once per run: a run whose precheck is already stored (a
 * re-dispatch after the person's answer, an unattended start that checked
 * first, a retry) goes straight on. Only an action's run is checked: a
 * loop's run carries the loop's own instructions. A database without
 * migration 392 reads as "nothing to check", so the run goes on as before.
 *
 * Stores the record and the criteria on the live row, then parks the run
 * when the verdict is needs_clarification. Never throws for a model failure
 * (that fails open); a database error propagates for the step's retry.
 */
export async function precheckBeforeSandbox(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string; userId: string | null },
): Promise<PrecheckStepResult> {
  const { data: row, error } = await supabase
    .from('agent_run')
    .select('precheck, action_id')
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error || !row) return { parked: false, ran: false }
  const r = row as { precheck?: unknown; action_id?: string | null }
  if (!r.action_id || !args.userId) return { parked: false, ran: false }
  const prior = readPrecheckRecord(r.precheck)
  if (prior) {
    // Asked and not answered (no answers, no skip): park on it again, never
    // build past an open question.
    if (prior.verdict === 'needs_clarification' && !prior.answers?.length && !prior.skipped && prior.questions.length > 0) {
      const parked = await parkOnPrecheck(supabase, { agentRunId: args.agentRunId, workspaceId: args.workspaceId, actionId: r.action_id, record: prior })
      return { parked, ran: false, verdict: prior.verdict }
    }
    return { parked: false, ran: false }
  }

  const { data: action } = await supabase
    .from('actions')
    .select('id, identifier, title, description, project:projects!project_id(github_repo)')
    .eq('id', r.action_id)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (!action) return { parked: false, ran: false }
  const a = action as { id: string; identifier?: string | null; title?: string | null; description?: string | null; project?: unknown }
  const project = a.project as { github_repo?: string | null } | null

  const result = await runCodingPrecheck({
    workspaceId: args.workspaceId,
    userId: args.userId,
    supabase,
    action: {
      identifier: a.identifier || a.id,
      title: a.title ?? '',
      description: a.description ?? null,
      repoFullName: project?.github_repo ?? null,
    },
  })
  const { data: stored } = await supabase
    .from('agent_run')
    .update({ precheck: result.record, acceptance_criteria: result.criteria })
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .in('status', ['queued', 'running'])
    .select('id')
  if (!stored || stored.length === 0) return { parked: false, ran: true, verdict: result.record.verdict }
  if (result.record.verdict !== 'needs_clarification') return { parked: false, ran: true, verdict: result.record.verdict }
  const parked = await parkOnPrecheck(supabase, {
    agentRunId: args.agentRunId,
    workspaceId: args.workspaceId,
    actionId: r.action_id,
    record: result.record,
  })
  return { parked, ran: true, verdict: result.record.verdict }
}

/**
 * A run's stored pre-check and criteria, read on their own so a database
 * without migration 392 reads as none (the spec is still served). Never throws.
 */
export async function readRunPrecheck(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string },
): Promise<{ precheck: PrecheckRecord | null; criteria: string[] }> {
  try {
    const { data, error } = await supabase
      .from('agent_run')
      .select('precheck, acceptance_criteria')
      .eq('id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    if (error || !data) return { precheck: null, criteria: [] }
    const row = data as { precheck?: unknown; acceptance_criteria?: unknown }
    return {
      precheck: readPrecheckRecord(row.precheck),
      criteria: Array.isArray(row.acceptance_criteria) ? normalizeCriteria(row.acceptance_criteria) : [],
    }
  } catch {
    return { precheck: null, criteria: [] }
  }
}
