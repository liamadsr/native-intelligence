/**
 * The main chat's plan (docs/plans/always-on-agent.md §4b, A4 slice 1): the
 * checklist the agent keeps for a long job with `update_plan`
 * (../tools/update_plan.ts), and its recitation after a checkpoint
 * (../instructions/plan.ts).
 *
 * ── Where it lives ──────────────────────────────────────────────────────────
 * Durable session state (`chat-agent.plan`), the same pattern as the turn's
 * model selection (../agent.ts) and the usage meter. No app round trip, no
 * schema: the main chat's own plan is not a ledger row (a per-conversation
 * `tracked_job` would set off counts, bots, For you and log lines). Each call
 * replaces the whole list. The browser draws it from the tool part itself
 * (the chat's plan card), so nothing else needs to read the state.
 *
 * ── The rules ───────────────────────────────────────────────────────────────
 * Twins of src/lib/work/plan.ts (this eve root cannot import the app;
 * plan-drift.test.ts keeps the limits and the validator's answers equal): 1 to
 * 12 steps, each one line of at most 140 characters, pending / in_progress /
 * done / skipped, at most one in progress.
 *
 * ── Recitation ──────────────────────────────────────────────────────────────
 * The tool returns the whole plan every call, so each step update re-states
 * it: that covers compaction in the middle of a long turn. Across a turn
 * boundary, a checkpoint (eve's `context.compaction` marker, then its summary)
 * can summarize every update_plan call away. planRecitationDue answers from
 * the pre-turn history alone: a checkpoint is in it and, after the newest
 * marker, the model can't see the plan (no update_plan call or result, no
 * earlier recitation). That holds on the first turn after a checkpoint (A3's
 * firstTurnAfterCheckpoint case: nothing has run since the marker) unless the
 * kept tail still shows a plan call, and also on the turn after a checkpoint
 * made inside a turn whose own turn-context block survived in the kept tail,
 * which a "no turn-context block after the marker" test alone misses. Once
 * recited, the recitation sits after the marker and later turns skip it, so
 * it goes out once per compaction cycle. Only a plan with open steps is
 * recited. Replay-safe: the same history answers the same.
 *
 * ── An abandoned plan is never recited ──────────────────────────────────────
 * Recitation must never restart dead work. The state keeps when the plan was
 * last written and the turns that have started since (by turn id, so a
 * replayed turn.started counts once). A plan last written more than
 * PLAN_STALE_TURNS turns or PLAN_STALE_MS ago is abandoned, as is one whose
 * job ended (no step left to do), and a plan from before this record existed
 * (no time on it): none is recited. And the block itself says to carry on
 * only if the person's latest message continues the job.
 */
import { defineState } from 'eve/context'

export const PLAN_STEP_STATUSES = ['pending', 'in_progress', 'done', 'skipped'] as const
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number]
export const PLAN_MAX_STEPS = 12
export const PLAN_STEP_MAX_CHARS = 140

/** The tool's name, as the history and the browser see it. */
export const UPDATE_PLAN_TOOL_NAME = 'update_plan'

export interface PlanStep {
  text: string
  status: PlanStepStatus
}

const STATUS_SET: ReadonlySet<string> = new Set(PLAN_STEP_STATUSES)

export type PlanValidation = { ok: true; steps: PlanStep[] } | { ok: false; error: string }

function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Validate a whole plan. Twin of src/lib/work/plan.ts validatePlanSteps, word
 * for word in its answers (plan-drift.test.ts). Pure; never throws.
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

/** A plan last written more than this many turns ago is abandoned: never recited. */
export const PLAN_STALE_TURNS = 6
/** A plan last written longer ago than this is abandoned: never recited. */
export const PLAN_STALE_MS = 24 * 60 * 60 * 1000
/** More turn ids than the staleness rule needs; a runaway list is cut here. */
const MAX_TURNS_KEPT = 32

/** The plan as durable state keeps it. */
export interface PlanRecord {
  steps: PlanStep[]
  /** When it was last written (ISO); null for a plan saved before this was kept. */
  updatedAt: string | null
  /** The turns that have started since it was last written, by id. */
  turnsSince: string[]
}

/**
 * This conversation's plan. Durable: survives steps, replays and crashes. Null
 * until one is written. (A bare list is the first shape this slot held: read
 * as a record with no time on it.)
 */
const planState = defineState<PlanRecord | PlanStep[] | null>('chat-agent.plan', () => null)

function asRecord(value: PlanRecord | PlanStep[] | null): PlanRecord | null {
  if (!value) return null
  if (Array.isArray(value)) return { steps: value, updatedAt: null, turnsSince: [] }
  return value
}

/** The plan as durable state holds it, or null. */
export function currentPlan(): PlanRecord | null {
  return asRecord(planState.get())
}

/** Replace the plan with these (already validated) steps, written now. */
export function savePlan(steps: PlanStep[], now: Date = new Date()): void {
  planState.update(() => ({ steps, updatedAt: now.toISOString(), turnsSince: [] }))
}

/** Count a turn that started since the plan was written (idempotent by turn id: a replay counts once). */
export function noteTurnStarted(turnId: string | null): void {
  if (!turnId) return
  planState.update((value) => {
    const record = asRecord(value)
    if (!record || record.turnsSince.includes(turnId)) return value
    return { ...record, turnsSince: [...record.turnsSince, turnId].slice(-MAX_TURNS_KEPT) }
  })
}

/** Whether a plan is abandoned (see the file header): too many turns or too long since it was written, or no time on it. */
export function planIsStale(record: PlanRecord, now: Date): boolean {
  if (!record.updatedAt) return true
  const at = Date.parse(record.updatedAt)
  if (!Number.isFinite(at) || now.getTime() - at > PLAN_STALE_MS) return true
  return record.turnsSince.length > PLAN_STALE_TURNS
}

export function planHasOpenSteps(steps: readonly PlanStep[]): boolean {
  return steps.some((s) => s.status === 'pending' || s.status === 'in_progress')
}

/** The recitation's opening line, alone on its line: how an earlier one is found in the history. */
export const PLAN_RECITATION_OPEN = '<plan>'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A user-role instruction message's text, or null (the user's own messages and tool results are never one). */
function instructionText(message: unknown): string | null {
  if (!isRecord(message) || message.role !== 'user' || message.kind !== 'context.instruction') return null
  const { content } = message
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  return content.map((p) => (isRecord(p) && p.type === 'text' ? String(p.text ?? '') : '')).join('')
}

/** Whether a message carries an update_plan call or its result. */
function carriesPlanCall(message: unknown): boolean {
  if (!isRecord(message) || (message.role !== 'assistant' && message.role !== 'tool') || !Array.isArray(message.content)) return false
  return message.content.some(
    (p) => isRecord(p) && (p.type === 'tool-call' || p.type === 'tool-result') && p.toolName === UPDATE_PLAN_TOOL_NAME,
  )
}

/**
 * Whether the plan should be recited this turn (see the file header): the
 * pre-turn history holds a checkpoint, and after its newest marker there is no
 * update_plan call or result and no earlier recitation. Pure; never throws.
 */
export function planRecitationDue(messages: readonly unknown[]): boolean {
  const list = Array.isArray(messages) ? messages : []
  let marker = -1
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]
    if (isRecord(m) && m.role === 'user' && m.kind === 'context.compaction') {
      marker = i
      break
    }
  }
  if (marker < 0) return false
  for (let i = marker + 1; i < list.length; i++) {
    if (carriesPlanCall(list[i])) return false
    if (instructionText(list[i])?.startsWith(PLAN_RECITATION_OPEN)) return false
  }
  return true
}

const MARK: Record<PlanStepStatus, string> = {
  pending: 'to do',
  in_progress: 'in progress',
  done: 'done',
  skipped: 'skipped',
}

/** The recitation block. A step's text is the model's own; a `<` in it is neutralized so it can't close the block. */
export function renderPlanRecitation(steps: readonly PlanStep[]): string {
  const lines = steps.map((s, i) => `${i + 1}. [${MARK[s.status]}] ${s.text.replace(/</g, '‹')}`)
  return [
    PLAN_RECITATION_OPEN,
    'Your plan from update_plan before the conversation was summarized. If the person\'s latest message continues this job, carry on from it and call update_plan when a step starts or finishes. If they have moved on, leave it: never restart work they didn\'t ask for. Don\'t mention this block to the user.',
    ...lines,
    '</plan>',
  ].join('\n')
}

/** The recitation for this plan and this history, or null for none (no plan, its job ended, abandoned, or not due). */
export function planRecitation(record: PlanRecord | null, messages: readonly unknown[], now: Date = new Date()): string | null {
  if (!record || record.steps.length === 0 || !planHasOpenSteps(record.steps)) return null
  if (planIsStale(record, now)) return null
  if (!planRecitationDue(messages)) return null
  return renderPlanRecitation(record.steps)
}
