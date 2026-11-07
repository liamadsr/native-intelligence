/**
 * A job's plan: the checklist an agent writes to get one job done, rewritten
 * as it learns (docs/plans/always-on-agent.md §4b, A4 slice 2).
 *
 * ── Where it lives ──────────────────────────────────────────────────────────
 * Its own column, `tracked_job.plan` (migration 331), never `progress.plan`.
 * The recorder rewrites the whole `progress` object from its in-memory copy on
 * every step, finish and fail; the agent-run mirror, the reaper and resolve
 * write it whole too. A plan written into `progress` from another process
 * would be lost to whichever write landed next. A separate column is never
 * named by those writes, so each keeps the other's.
 *
 * ── One writer ──────────────────────────────────────────────────────────────
 * setWorkPlan is the only server path that writes the column: the agent-run
 * event route (`kind: 'plan'`, work runs) and the skill-run tool route (the
 * skill-runner's `update_plan`) both call it. It validates every write, writes
 * only to a live row, and adds no step-log line (the plan is not a step).
 *
 * ── Client-safe ─────────────────────────────────────────────────────────────
 * The panels and the chat's plan card import the readers below, so this file
 * imports nothing server-side; setWorkPlan takes the client it writes with.
 *
 * The main chat's own plan is not a ledger row: it lives in the chat agent's
 * durable state (agents/chat-agent/lib/plan.ts, the twin of the rules here;
 * plan-drift.test.ts keeps them equal).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { WORK_LIVE_STATUSES } from './types'

/** A step's state. One step at a time is in progress. */
export const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'done', 'skipped'] as const
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number]

/** At most this many steps: a plan, not a backlog. */
export const PLAN_MAX_STEPS = 12
/** A step's text, at most this long: one short line. */
export const PLAN_STEP_MAX_CHARS = 140
/**
 * The main chat's plan is abandoned once it was last written more than this
 * many turns ago, or longer ago than PLAN_STALE_MS (the chat agent's
 * recitation rule, agents/chat-agent/lib/plan.ts planIsStale): its recitation
 * stops, and the chat's Plan widget shows it without a count.
 */
export const PLAN_STALE_TURNS = 6
export const PLAN_STALE_MS = 24 * 60 * 60 * 1000

export interface PlanStep {
  text: string
  status: PlanStepStatus
}

/** The `tracked_job.plan` object (the column's check: a JSON object). */
export interface WorkPlan {
  steps: PlanStep[]
  /** When it was last written (ISO). */
  updated_at: string
}

const STATUS_SET: ReadonlySet<string> = new Set(PLAN_STEP_STATUSES)

export type PlanValidation = { ok: true; steps: PlanStep[] } | { ok: false; error: string }

/** A step's text on one line, its whitespace collapsed. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Validate a whole plan as an agent sends it: 1 to PLAN_MAX_STEPS steps, each
 * a non-blank line of at most PLAN_STEP_MAX_CHARS (whitespace collapsed) with a
 * known status, and at most one step in progress. The error says what to fix,
 * in words the model can act on. Pure; never throws.
 */
export function validatePlanSteps(value: unknown): PlanValidation {
  if (!Array.isArray(value)) return { ok: false, error: 'steps must be a list of { text, status }.' }
  if (value.length === 0) return { ok: false, error: 'A plan needs at least one step.' }
  if (value.length > PLAN_MAX_STEPS) {
    return { ok: false, error: `A plan has at most ${PLAN_MAX_STEPS} steps; merge some (it has ${value.length}).` }
  }
  const steps: PlanStep[] = []
  for (const [i, raw] of value.entries()) {
    const n = i + 1
    if (!raw || typeof raw !== 'object') return { ok: false, error: `Step ${n} must be { text, status }.` }
    const { text, status } = raw as { text?: unknown; status?: unknown }
    if (typeof text !== 'string' || !tidy(text)) return { ok: false, error: `Step ${n} needs its text.` }
    const line = tidy(text)
    if (line.length > PLAN_STEP_MAX_CHARS) {
      return { ok: false, error: `Step ${n} is ${line.length} characters; keep each step to ${PLAN_STEP_MAX_CHARS}.` }
    }
    if (typeof status !== 'string' || !STATUS_SET.has(status)) {
      return { ok: false, error: `Step ${n}'s status must be one of ${PLAN_STEP_STATUSES.join(', ')}.` }
    }
    steps.push({ text: line, status: status as PlanStepStatus })
  }
  const inProgress = steps.filter((s) => s.status === 'in_progress').length
  if (inProgress > 1) {
    return { ok: false, error: `Only one step can be in_progress at a time (${inProgress} are).` }
  }
  return { ok: true, steps }
}

/**
 * The steps a stored or sent plan holds, for display: a `{ steps }` object (the
 * column, a tool's output) or a bare list (a tool's input). Lenient: a
 * malformed step is dropped, an over-long one clipped, and past
 * PLAN_MAX_STEPS the rest are cut. Null when no step reads. Pure; never throws.
 */
export function planStepsFrom(value: unknown): PlanStep[] | null {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === 'object' && Array.isArray((value as { steps?: unknown }).steps)
      ? ((value as { steps: unknown[] }).steps)
      : null
  if (!list) return null
  const steps: PlanStep[] = []
  for (const raw of list.slice(0, PLAN_MAX_STEPS)) {
    if (!raw || typeof raw !== 'object') continue
    const { text, status } = raw as { text?: unknown; status?: unknown }
    if (typeof text !== 'string' || typeof status !== 'string' || !STATUS_SET.has(status)) continue
    const line = tidy(text)
    if (!line) continue
    steps.push({
      text: line.length > PLAN_STEP_MAX_CHARS ? `${line.slice(0, PLAN_STEP_MAX_CHARS - 1)}…` : line,
      status: status as PlanStepStatus,
    })
  }
  return steps.length > 0 ? steps : null
}

/** How far along a plan is: finished steps (done or skipped), the total, and the step in progress. */
export interface PlanProgress {
  finished: number
  total: number
  /** The step in progress, else null. */
  current: string | null
}

export function planProgress(steps: readonly PlanStep[]): PlanProgress {
  return {
    finished: steps.filter((s) => s.status === 'done' || s.status === 'skipped').length,
    total: steps.length,
    current: steps.find((s) => s.status === 'in_progress')?.text ?? null,
  }
}

/** Whether a plan still has a step to do (pending or in progress). */
export function planHasOpenSteps(steps: readonly PlanStep[]): boolean {
  return steps.some((s) => s.status === 'pending' || s.status === 'in_progress')
}

/** "3/5": the badge a row carries. */
export function planBadge(steps: readonly PlanStep[]): string {
  const { finished, total } = planProgress(steps)
  return `${finished}/${total}`
}

/**
 * "step 3 of 5": where a job stands, for the action it works (the action's
 * panel and card, decision 9). The step in progress, else the next one to do,
 * out of the total; a finished plan reads its last step.
 */
export function planStepLabel(steps: readonly PlanStep[]): string {
  const { finished, total } = planProgress(steps)
  return `step ${Math.min(finished + 1, total)} of ${total}`
}

/**
 * A plan as the main agent reads a job (list_bot_work, get_bot_item): the
 * count and the step in progress, and with `steps` the whole list.
 */
export interface PlanReading {
  done: number
  total: number
  now?: string
  steps?: PlanStep[]
}

export function planReading(value: unknown, withSteps: boolean): PlanReading | null {
  const steps = planStepsFrom(value)
  if (!steps) return null
  const { finished, total, current } = planProgress(steps)
  return { done: finished, total, ...(current ? { now: current } : {}), ...(withSteps ? { steps } : {}) }
}

// ── A database without migration 331 ────────────────────────────────────────
//
// `plan` rides every light ledger read (queries.ts LIGHT_COLUMNS) and the main
// agent's own-row read (bot-work-server.ts). On a database that hasn't had
// migration 331 yet, PostgREST refuses a select naming it (42703), and those
// reads would go empty: no counts, no bots, no bot work. So a read that fails
// on the column is made again without it, and the process remembers the
// column is missing (one failed read per process, not one per request). A row
// read without it has no `plan`, which every reader takes as none.

/** Whether the process has seen `tracked_job.plan` missing (no migration 331). */
let planColumnKnownMissing = false

/** Whether a PostgREST error says the `plan` column doesn't exist. */
export function isMissingPlanColumnError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  const message = error.message ?? ''
  const missingColumn = error.code === '42703' || /column .* does not exist|could not find .* column/i.test(message)
  return missingColumn && /\bplan\b/.test(message)
}

/** A select with its `plan` column taken out. */
export function withoutPlanColumn(select: string): string {
  return select.replace(/,\s*plan\b(?=\s*(,|$))/, '').replace(/^\s*plan\s*,\s*/, '')
}

/**
 * Run a read with `select`, and once more without `plan` when it fails on the
 * column (remembered for the process: later reads leave it out at once).
 */
export async function readWithPlanFallback<R extends { error: { code?: string | null; message?: string | null } | null }>(
  select: string,
  run: (columns: string) => PromiseLike<R>,
): Promise<R> {
  if (planColumnKnownMissing) return run(withoutPlanColumn(select))
  const first = await run(select)
  if (!isMissingPlanColumnError(first.error)) return first
  planColumnKnownMissing = true
  console.warn('[work] tracked_job.plan is missing (migration 331 not applied): reading without plans')
  return run(withoutPlanColumn(select))
}

/** Test seam: forget that the column was seen missing. */
export function resetPlanColumnMemo(): void {
  planColumnKnownMissing = false
}

export type SetWorkPlanResult =
  | { ok: true; plan: WorkPlan }
  | { ok: false; code: 'INPUT_INVALID' | 'NOT_LIVE' | 'NOT_AVAILABLE' | 'WRITE_FAILED'; error: string }

const PLAN_NOT_AVAILABLE = 'Plans are not available on this workspace yet. Carry on without update_plan.'

/**
 * Write a job's plan: the whole list, replacing the last one. Validated
 * (validatePlanSteps), fenced on the row's workspace, and only while the row
 * is live (a settled job keeps the plan it finished with, for its history).
 * Writes the `plan` column alone: never `progress`, never a step line.
 * Never throws.
 */
export async function setWorkPlan(
  supabase: SupabaseClient,
  args: { workspaceId: string; workItemId: string; steps: unknown; now?: Date },
): Promise<SetWorkPlanResult> {
  const valid = validatePlanSteps(args.steps)
  if (!valid.ok) return { ok: false, code: 'INPUT_INVALID', error: valid.error }
  const plan: WorkPlan = { steps: valid.steps, updated_at: (args.now ?? new Date()).toISOString() }
  if (planColumnKnownMissing) return { ok: false, code: 'NOT_AVAILABLE', error: PLAN_NOT_AVAILABLE }
  try {
    const { data, error } = await supabase
      .from('tracked_job')
      .update({ plan })
      .eq('id', args.workItemId)
      .eq('workspace_id', args.workspaceId)
      .in('status', [...WORK_LIVE_STATUSES])
      .select('id')
    if (isMissingPlanColumnError(error)) {
      planColumnKnownMissing = true
      return { ok: false, code: 'NOT_AVAILABLE', error: PLAN_NOT_AVAILABLE }
    }
    if (error) return { ok: false, code: 'WRITE_FAILED', error: error.message }
    if (!Array.isArray(data) || data.length === 0) {
      return { ok: false, code: 'NOT_LIVE', error: 'This job is no longer running, so its plan stays as it was.' }
    }
    return { ok: true, plan }
  } catch (err) {
    return { ok: false, code: 'WRITE_FAILED', error: err instanceof Error ? err.message : String(err) }
  }
}
