/**
 * A failed background job as flywheel evidence (./types.ts LoopRunEvidence):
 * the ledger row's facts (src/lib/work/types.ts), its flow run's failed
 * actions and the end of its agent run's log, never a transcript.
 *
 * WHICH FAILURES COUNT. Only `tracked_job.status = 'failed'`: a canceled job
 * (status 'canceled', the person's Stop or the kill switch's fan-out) and a
 * skipped one (status 'skipped': the kill switch's paused fires, a dormant
 * workspace's gated fires, flow-functions.ts) are never read. A failed row is
 * still left out when its `error_message` says the agent never had a fair run:
 *   - the usage limit or a missing plan: /usage limit/ (guardBackgroundUsage's
 *     "Usage limit reached…", the line presentation.ts and notify.ts already
 *     read as "paused, not failed"), `subscription_required`, "plan limit";
 *   - the kill switch: AGENT_PAUSED, "autonomy off" (AGENT_PAUSED_REASON, what
 *     a loop's refused tool calls carry once the switch flips mid-run);
 *   - a dormant workspace: "dormant", "workspace inactive" (DORMANT_SKIP_PREVIEW);
 *   - a cancel that settled as a failure: "canceled" / "cancelled";
 *   - the reaper's NO_REPORT_BACK: the run stopped reporting (a lost worker,
 *     a deploy, a queue), which says nothing about what the agent did.
 * Everything else (a model error, a tool refusal, a wall hit, a bad output) is
 * a candidate.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { clipTail, clipText } from './record'
import { FLYWHEEL_LIMITS, type LoopRunEvidence } from './types'

/** A `tracked_job` row as the flywheel reads it. */
export interface FailedJobRow {
  id: string
  workspace_id: string
  member_id: string
  kind: string
  title: string | null
  status: string
  error_message: string | null
  source: Record<string, unknown> | null
  agent_run_id?: string | null
  flow_run_id?: string | null
  finished_at?: string | null
}

export interface FlowRunRow {
  id: string
  flow_id: string | null
  action_results: unknown
}

export interface AgentRunRow {
  id: string
  error_message: string | null
  log_tail: string | null
}

/** A flow's actions, as far as the evidence reads them (the action's type and the skill it runs). */
export interface FlowActionsRow {
  id: string
  actions: unknown
}

export const SKIP_RULES: ReadonlyArray<{ reason: string; test: RegExp }> = [
  { reason: 'usage_limit', test: /usage limit|subscription[_ ]required|plan limit/i },
  { reason: 'kill_switch', test: /AGENT_PAUSED|autonomy off/i },
  { reason: 'dormant', test: /dormant|workspace inactive/i },
  { reason: 'canceled', test: /\bcancell?ed\b/i },
  { reason: 'no_report_back', test: /^no report back\b/i },
]

/**
 * Why a job is left out of the flywheel, or null when it is a candidate (see
 * the module header).
 */
export function loopSkipReason(job: Pick<FailedJobRow, 'status' | 'error_message'>): string | null {
  if (job.status !== 'failed') return 'not_failed'
  const error = (job.error_message ?? '').trim()
  for (const rule of SKIP_RULES) if (rule.test.test(error)) return rule.reason
  return null
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** The flow run's executed actions that failed: their type (else id) and error. */
function flowErrorsOf(flowRun: FlowRunRow | null, actions: Map<string, { type?: string }>): Array<{ action: string; error: string }> {
  if (!flowRun || !Array.isArray(flowRun.action_results)) return []
  const out: Array<{ action: string; error: string }> = []
  for (const r of flowRun.action_results as Array<Record<string, unknown>>) {
    if (!r || typeof r !== 'object' || r.skipped === true || r.status !== 'failed') continue
    const id = str(r.action_id) ?? 'action'
    out.push({
      action: actions.get(id)?.type ?? id,
      error: clipText(str(r.error_message) ?? 'failed', FLYWHEEL_LIMITS.stepError),
    })
  }
  return out
}

/** A flow's actions by id: their type and, for run_skill, the skill (recipe) id. */
export function flowActionsById(flow: FlowActionsRow | null): Map<string, { type?: string; skillId?: string }> {
  const out = new Map<string, { type?: string; skillId?: string }>()
  if (!flow || !Array.isArray(flow.actions)) return out
  for (const a of flow.actions as Array<Record<string, unknown>>) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string') continue
    const config = a.config && typeof a.config === 'object' ? (a.config as Record<string, unknown>) : {}
    out.set(a.id, { type: str(a.type), skillId: str(config.skill_id) })
  }
  return out
}

/** The skill (recipe) id of the first failed run_skill action, else of the flow's first run_skill action. */
export function failedSkillId(flowRun: FlowRunRow | null, actions: Map<string, { type?: string; skillId?: string }>): string | null {
  const results = flowRun && Array.isArray(flowRun.action_results) ? (flowRun.action_results as Array<Record<string, unknown>>) : []
  for (const r of results) {
    if (r?.status !== 'failed' || r.skipped === true) continue
    const skillId = typeof r.action_id === 'string' ? actions.get(r.action_id)?.skillId : undefined
    if (skillId) return skillId
  }
  for (const a of actions.values()) if (a.type === 'run_skill' && a.skillId) return a.skillId
  return null
}

/** Build a failed job's evidence from its row and what it points at. Pure. */
export function buildLoopRunEvidence(
  job: FailedJobRow,
  context: {
    flowRun?: FlowRunRow | null
    agentRun?: AgentRunRow | null
    flow?: FlowActionsRow | null
    skill?: string | null
  } = {},
): LoopRunEvidence {
  const source = job.source && typeof job.source === 'object' ? job.source : {}
  const flowRun = context.flowRun ?? null
  const evidence: LoopRunEvidence = { kind: 'loop_run', jobKind: clipText(job.kind, 60) || 'job' }
  const title = clipText(job.title, FLYWHEEL_LIMITS.title)
  if (title) evidence.title = title
  const error = clipText(job.error_message ?? context.agentRun?.error_message, FLYWHEEL_LIMITS.error)
  if (error) evidence.error = error
  const flowErrors = flowErrorsOf(flowRun, flowActionsById(context.flow ?? null))
  if (flowErrors.length) evidence.flowErrors = flowErrors
  const logTail = clipTail(context.agentRun?.log_tail, FLYWHEEL_LIMITS.logTail)
  if (logTail) evidence.logTail = logTail
  const flowId = str(flowRun?.flow_id) ?? str(source.flow_id)
  if (flowId) evidence.flowId = flowId
  const flowRunId = str(job.flow_run_id) ?? str(source.flow_run_id)
  if (flowRunId) evidence.flowRunId = flowRunId
  const agentRunId = str(job.agent_run_id) ?? str(source.agent_run_id)
  if (agentRunId) evidence.agentRunId = agentRunId
  const captureId = str(source.capture_id)
  if (captureId) evidence.captureId = captureId
  if (context.skill) evidence.skill = context.skill
  if (job.finished_at) evidence.at = job.finished_at
  return evidence
}

/** What a batch of failed jobs points at, read once for the batch. */
export interface LoopContext {
  /** member id → its user id. */
  users: Map<string, string>
  flowRuns: Map<string, FlowRunRow>
  agentRuns: Map<string, AgentRunRow>
  flows: Map<string, FlowActionsRow>
  /** recipe id → its slug. */
  skillSlugs: Map<string, string>
}

async function readIn<T extends { id: string }>(supabase: SupabaseClient, table: string, columns: string, ids: string[]): Promise<Map<string, T>> {
  const out = new Map<string, T>()
  if (!ids.length) return out
  const { data, error } = await supabase.from(table).select(columns).in('id', ids)
  if (error || !Array.isArray(data)) return out
  for (const row of data as unknown as T[]) if (row?.id) out.set(row.id, row)
  return out
}

/**
 * Read what a batch of failed jobs points at: each owner's user, the flow
 * runs, the agent runs (error and log tail only), the flows' actions and the
 * skills' slugs. Five batched reads at most; a failed read leaves its map
 * empty (the evidence just has less), never throws.
 */
export async function loadLoopContext(supabase: SupabaseClient, jobs: readonly FailedJobRow[]): Promise<LoopContext> {
  const unique = (values: Array<unknown>) => [...new Set(values.filter((v): v is string => typeof v === 'string' && !!v))]
  const sourceOf = (j: FailedJobRow) => (j.source && typeof j.source === 'object' ? j.source : {})
  try {
    const [members, flowRuns, agentRuns] = await Promise.all([
      readIn<{ id: string; user_id: string }>(supabase, 'member', 'id, user_id', unique(jobs.map((j) => j.member_id))),
      readIn<FlowRunRow>(supabase, 'flow_run', 'id, flow_id, action_results', unique(jobs.map((j) => j.flow_run_id ?? sourceOf(j).flow_run_id))),
      readIn<AgentRunRow>(supabase, 'agent_run', 'id, error_message, log_tail', unique(jobs.map((j) => j.agent_run_id ?? sourceOf(j).agent_run_id))),
    ])
    const flowIds = unique([...flowRuns.values()].map((r) => r.flow_id).concat(jobs.map((j) => sourceOf(j).flow_id as string)))
    const flows = await readIn<FlowActionsRow>(supabase, 'flow', 'id, actions', flowIds)
    const skillIds = unique([...flows.values()].flatMap((f) => [...flowActionsById(f).values()].map((a) => a.skillId)))
    const recipes = await readIn<{ id: string; slug: string | null }>(supabase, 'recipe', 'id, slug', skillIds)
    const users = new Map<string, string>()
    for (const m of members.values()) if (m.user_id) users.set(m.id, m.user_id)
    const skillSlugs = new Map<string, string>()
    for (const r of recipes.values()) if (r.slug) skillSlugs.set(r.id, r.slug)
    return { users, flowRuns, agentRuns, flows, skillSlugs }
  } catch (err) {
    console.error('[eval-flywheel] loop context read failed:', err instanceof Error ? err.message : 'unknown error')
    return { users: new Map(), flowRuns: new Map(), agentRuns: new Map(), flows: new Map(), skillSlugs: new Map() }
  }
}

/** One job's evidence and skill from a batch's context. */
export function loopEvidenceFrom(job: FailedJobRow, context: LoopContext): { evidence: LoopRunEvidence; skill: string | null } {
  const source = job.source && typeof job.source === 'object' ? job.source : {}
  const flowRunId = str(job.flow_run_id) ?? str(source.flow_run_id)
  const agentRunId = str(job.agent_run_id) ?? str(source.agent_run_id)
  const flowRun = flowRunId ? (context.flowRuns.get(flowRunId) ?? null) : null
  const flowId = str(flowRun?.flow_id) ?? str(source.flow_id)
  const flow = flowId ? (context.flows.get(flowId) ?? null) : null
  const skillId = failedSkillId(flowRun, flowActionsById(flow))
  const skill = skillId ? (context.skillSlugs.get(skillId) ?? null) : null
  const evidence = buildLoopRunEvidence(job, {
    flowRun,
    agentRun: agentRunId ? (context.agentRuns.get(agentRunId) ?? null) : null,
    flow,
    skill,
  })
  return { evidence, skill }
}
