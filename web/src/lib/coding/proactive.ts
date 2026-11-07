/**
 * Proactive draft PRs for small, clear bugs (P10; eve-templates-lessons.md
 * F4; eve-alignment.md §6 decision 12). BUILT BUT OFF.
 *
 * The path: a bug said on a call → Triage's verdict proposes it as a
 * developer work_proposal → the auto-attempt gate (auto-attempt.ts) hands a
 * developer proposal here → the pre-check says it is a small, clear bug →
 * a SUGGESTED action is filed and a coding run starts on it (origin
 * 'attempt') → the reviewer on another vendor approves → a DRAFT pull request
 * goes to For you (the run's ledger row waits on the person with the PR).
 * When the person marks the PR ready for review, its action is confirmed
 * (the GitHub webhook). Anything less stays the card it always was.
 *
 * Decision 12: only once the reviewer is live and proven on clicked runs,
 * small clear bugs only, a daily cap, draft PRs only, as a flow and never a
 * default. So it runs only when ALL of these hold, the first failure keeping
 * the card:
 *   - the verdict's run-as person has the `small_bug_draft_prs` recipe on (an
 *     enabled capture_processed loop THEY own, whose run_agent step is marked
 *     attempt_small_bugs; src/lib/flows/recipes.ts). No seed, no default;
 *   - this deployment dispatches run_agent at all (RUN_AGENT_DISPATCH_ENABLED,
 *     off by default and off on PROD; create_flow refuses the recipe's step
 *     while it is off). This is the real switch;
 *   - the attempt gate's own switches (env, the workspace's autonomy mode,
 *     an act-mode first-hop verdict), its confidence bar and grounding (a
 *     quote found verbatim in a workspace-visible call), its per-capture
 *     budget and the Developer role's circuit breaker;
 *   - a repo: the recipe's project, else the workspace's only project with
 *     a GitHub repo; PRIVATE (decision 2: nothing pushed into a public repo
 *     on its own); the run-as person has GitHub connected;
 *   - a Developer teammate that may work unattended;
 *   - the plan meter (fail closed);
 *   - the pre-check: actionable, a bug, small. A pre-check that can't run is
 *     a no (unattended fails closed);
 *   - a slot: at most MAX_PROACTIVE_CODING_RUNS_PER_DAY per workspace (CI
 *     fixes aside), claimed atomically with the run's row
 *     (agent_run_claim_proactive_coding, migration 392).
 *
 * The ceiling is enforced where the PR is made, not here: an unattended run's
 * PR is always a draft (unattended.ts prCeilingFor, the outcome route), and
 * it opens only on the reviewer's full approve (review.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { RUN_AGENT_DISPATCH_ENABLED } from '@/lib/flows/run-agent'
import { ensureWorkForAgentRun } from '@/lib/work/agent-run-mirror'
import { runEnvironmentIdFor } from '@/lib/environments/resolve'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { ensureRoleTeammates, resolveRoleTeammate } from '@/lib/work/role-routing'
import { roleBreakerState } from '@/lib/work/role-breaker'
import { planWorkItem } from '@/lib/work/start-work-item'
import type { AttemptCandidate, AttemptOutcome, AutoAttemptContext, AutoAttemptDecision } from '@/lib/work/auto-attempt'
import { runCodingPrecheck, type PrecheckResult } from './precheck'

/** Proactive coding runs per workspace per UTC day (decision 12's daily cap). CI fix runs don't count. */
export const MAX_PROACTIVE_CODING_RUNS_PER_DAY = 2

/** The run_agent step marker the recipe writes (RunAgentActionConfig.attempt_small_bugs). */
export const PROACTIVE_CODING_MARKER = 'attempt_small_bugs'

export type ProactiveCodingRefusal =
  | 'recipe_off'
  | 'dispatch_off'
  | 'no_repo'
  | 'public_repo'
  | 'no_github'
  | 'coding_day_budget'
  | 'precheck_failed'
  | 'not_clear'
  | 'not_a_bug'
  | 'not_small'

/** The owner's switched-on recipe step, or null: the one place "is it on" is decided. */
export async function proactiveCodingRecipe(
  supabase: SupabaseClient,
  workspaceId: string,
  ownerUserId: string,
): Promise<{ flowId: string; projectId: string | null } | null> {
  const { data, error } = await supabase
    .from('flow')
    .select('id, actions')
    .eq('workspace_id', workspaceId)
    .eq('created_by', ownerUserId)
    .eq('enabled', true)
    .eq('trigger_type', 'capture_processed')
    .contains('actions', JSON.stringify([{ type: 'run_agent', config: { [PROACTIVE_CODING_MARKER]: true } }]))
    .limit(1)
  if (error || !data || data.length === 0) return null
  const flow = data[0] as { id: string; actions?: Array<{ type?: string; enabled?: boolean; config?: Record<string, unknown> }> }
  const step = (flow.actions ?? []).find((a) => a.type === 'run_agent' && a.enabled !== false && a.config?.[PROACTIVE_CODING_MARKER] === true)
  if (!step) return null
  const projectId = typeof step.config?.project_id === 'string' && step.config.project_id ? step.config.project_id : null
  return { flowId: flow.id, projectId }
}

/** The repo the bugs go to: the recipe's project, else the only project with a GitHub repo. */
async function bugProject(
  supabase: SupabaseClient,
  workspaceId: string,
  projectId: string | null,
): Promise<{ id: string; name: string | null; repo: string } | null> {
  let query = supabase.from('projects').select('id, name, github_repo').eq('workspace_id', workspaceId)
  if (projectId) query = query.eq('id', projectId)
  const { data } = await query.limit(3)
  const withRepo = ((data ?? []) as Array<{ id: string; name?: string | null; github_repo?: string | null }>).filter((p) => typeof p.github_repo === 'string' && p.github_repo.includes('/'))
  if (withRepo.length !== 1) return null
  return { id: withRepo[0].id, name: withRepo[0].name ?? null, repo: withRepo[0].github_repo as string }
}

/** Whether GitHub says the repo is private. Fails closed: any doubt is 'public'. */
async function repoIsPrivate(repoFullName: string, token: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repoFullName}`, {
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) return false
    return ((await res.json()) as { private?: boolean }).private === true
  } catch {
    return false
  }
}

/** Whether the pre-check let an unattended run through. Pure. */
export function proactivePrecheckPasses(result: PrecheckResult): ProactiveCodingRefusal | null {
  if (result.record.failed) return 'precheck_failed'
  if (result.record.verdict !== 'actionable') return 'not_clear'
  if (result.record.kind !== 'bug') return 'not_a_bug'
  if (result.record.size !== 'small') return 'not_small'
  return null
}

export interface ProactiveDeps {
  /** The attempt gate's grounding (auto-attempt.ts groundedCapture), injected to keep the import one-way. */
  ground: (candidate: AttemptCandidate, ctx: AutoAttemptContext) => Promise<{ captureId: string; quote: string } | { refusal: AutoAttemptDecision }>
  send?: (event: { name: string; data: Record<string, unknown> }) => Promise<unknown>
  /** Overrides RUN_AGENT_DISPATCH_ENABLED (tests). */
  dispatchEnabled?: boolean
  fetchImpl?: typeof fetch
  now?: Date
}

type Refusal = Extract<AttemptOutcome, { attempted: false }>['reason']
const no = (reason: Refusal, detail?: string): AttemptOutcome => ({ attempted: false, reason, ...(detail ? { detail } : {}) })

/**
 * A developer work_proposal from Triage: start a draft-PR coding run, or say
 * why not (the verdict then cards it as before). Never throws.
 */
export async function attemptCodingProposal(
  candidate: AttemptCandidate,
  ctx: AutoAttemptContext & { memberId: string; captureTitle?: string | null },
  deps: ProactiveDeps,
): Promise<AttemptOutcome> {
  try {
    return await attempt(candidate, ctx, deps)
  } catch (err) {
    return no('read_failed', err instanceof Error ? err.message : String(err))
  }
}

async function attempt(
  candidate: AttemptCandidate,
  ctx: AutoAttemptContext & { memberId: string; captureTitle?: string | null },
  deps: ProactiveDeps,
): Promise<AttemptOutcome> {
  const { supabase, workspaceId } = ctx
  // The deployment's switch, then the owner's recipe. Nothing else is read while either is off.
  if (!(deps.dispatchEnabled ?? RUN_AGENT_DISPATCH_ENABLED)) return no('dispatch_off')
  const recipe = await proactiveCodingRecipe(supabase, workspaceId, ctx.userId)
  if (!recipe) return no('recipe_off')
  if (ctx.mode !== 'act') return no('report_mode')
  if (ctx.fireDepth !== 1) return no('fire_depth', String(ctx.fireDepth))

  const anchor = candidate.proposalId ?? candidate.cardId
  if (!anchor) return no('no_idempotency_key')
  const fireKey = `attempt:${anchor}`
  const { data: existing } = await supabase.from('agent_run').select('id').eq('fire_key', fireKey).eq('workspace_id', workspaceId).maybeSingle()
  if (existing?.id) return { attempted: true, reused: true, agentRunId: existing.id as string, fireKey, teammateId: null }

  const bar = ctx.policy.attempt_min_confidence ?? ctx.minConfidence
  if (!(candidate.confidence >= bar)) return no('below_confidence', `${candidate.confidence} < ${bar}`)

  const grounded = await deps.ground(candidate, ctx)
  if ('refusal' in grounded) {
    const r = grounded.refusal
    return no(r.attempt ? 'read_failed' : r.reason, r.attempt ? undefined : r.detail)
  }

  // The attempt gate's per-capture budget, on coding attempts from this call.
  const perCapture = await supabase
    .from('agent_run')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('kind', 'coding')
    .eq('origin', 'attempt')
    .contains('resources', JSON.stringify([{ type: 'capture', id: grounded.captureId }]))
  if (perCapture.error) return no('read_failed', perCapture.error.message)
  if ((perCapture.count ?? 0) >= ctx.policy.max_attempts_per_capture) {
    return no('capture_budget', `${perCapture.count ?? 0}/${ctx.policy.max_attempts_per_capture}`)
  }

  const project = await bugProject(supabase, workspaceId, recipe.projectId)
  if (!project) return no('no_repo', recipe.projectId ? 'the recipe’s project has no GitHub repo' : 'no single project with a GitHub repo')
  const token = await storedGithubToken(supabase, ctx.userId)
  if (!token) return no('no_github')
  if (!(await repoIsPrivate(project.repo, token, deps.fetchImpl ?? fetch))) return no('public_repo', project.repo)

  let routed = await resolveRoleTeammate(supabase, { workspaceId, role: 'developer', purpose: 'attempt' })
  if (!('error' in routed) && !routed.teammate && routed.reason === 'no_teammate') {
    const ensured = await ensureRoleTeammates(supabase, { workspaceId, createdBy: ctx.userId })
    if ('error' in ensured) return no('read_failed', ensured.error)
    if (ensured.seeded > 0) routed = await resolveRoleTeammate(supabase, { workspaceId, role: 'developer', purpose: 'attempt' })
  }
  if ('error' in routed) return no('read_failed', routed.error)
  if (!routed.teammate) return no(routed.reason === 'teammate_off' ? 'teammate_not_attempt' : routed.reason, 'developer')
  const developer = routed.teammate

  const now = deps.now ?? ctx.now ?? new Date()
  // The Developer role's circuit breaker, as the attempt gate reads it.
  const breaker = await roleBreakerState(supabase, { workspaceId, role: 'developer', teammateIds: routed.roster.map((m) => m.id), policy: ctx.policy, now })
  if ('error' in breaker) return no('read_failed', breaker.error)
  if (breaker.open) return no('breaker_open', `last ${breaker.window} developer attempts dismissed`)

  const { data: limit, error: limitErr } = await supabase.rpc('check_ai_usage_limit', { p_user_id: ctx.userId })
  if (limitErr) return no('usage_check_failed', limitErr.message)
  const row = Array.isArray(limit) ? (limit[0] as { allowed?: boolean; reason?: string } | undefined) : undefined
  if (!row) return no('usage_check_failed', 'no limit row')
  if (row.allowed !== true) return no('usage_limit', row.reason ?? 'plan limit')

  // The pre-check, on the proposal itself: small, clear, a bug. It fails closed here.
  const task = typeof candidate.payload.task === 'string' ? candidate.payload.task : ''
  const title = candidate.title.trim() || task.slice(0, 200)
  const description = [task, candidate.why ? `Why: ${candidate.why}` : '', `Said on the call: "${grounded.quote}"`].filter(Boolean).join('\n\n')
  const pre = await runCodingPrecheck({ workspaceId, userId: ctx.userId, supabase, action: { identifier: 'a new bug', title, description, repoFullName: project.repo } })
  const refused = proactivePrecheckPasses(pre)
  if (refused) return no(refused, pre.record.reason || undefined)

  const plan = await planWorkItem(supabase, { workspaceId, resources: [] })
  if (!plan) return no('no_default_state')

  // The daily cap, atomically: the slot and the run's row are one claim
  // (two verdicts at once can't both take the last slot).
  const utcMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
  const { data: claimed, error: claimErr } = await supabase.rpc('agent_run_claim_proactive_coding', {
    p_workspace_id: workspaceId,
    p_user_id: ctx.userId,
    p_flow_id: recipe.flowId,
    p_fire_key: fireKey,
    p_max: MAX_PROACTIVE_CODING_RUNS_PER_DAY,
    p_since: utcMidnight,
  })
  if (claimErr) return no('read_failed', claimErr.message)
  if (!claimed) return no('coding_day_budget', `${MAX_PROACTIVE_CODING_RUNS_PER_DAY} a day`)
  const agentRunId = String(claimed)

  // File the bug as a SUGGESTION (the person never confirmed it): it is
  // confirmed when they mark its draft PR ready for review.
  const { data: action, error: actionErr } = await supabase
    .from('actions')
    .insert({
      user_id: ctx.userId,
      workspace_id: workspaceId,
      team_id: plan.teamId,
      status_id: plan.statusId,
      project_id: project.id,
      title,
      description,
      confirmation: 'suggested',
      assignee_ai_member_id: developer.id,
      source_capture_id: grounded.captureId,
      agent_run_status: 'working',
      context_data: { proactive_coding: true, flow_id: recipe.flowId, quote: grounded.quote },
    })
    .select('id, identifier')
    .single()
  if (actionErr || !action) {
    await supabase.from('agent_run').delete().eq('id', agentRunId).eq('workspace_id', workspaceId)
    return no('launch_failed', `action: ${actionErr?.message ?? 'not created'}`)
  }
  const actionId = (action as { id: string }).id

  // The environment it starts in (migration 420): the project's, else the workspace default.
  const environmentId = await runEnvironmentIdFor(supabase, { projectId: project.id, workspaceId, userId: ctx.userId })
  const { error: runErr } = await supabase
    .from('agent_run')
    .update({
      action_id: actionId,
      ai_team_member_id: developer.id,
      repo_full_name: project.repo,
      environment_id: environmentId,
      precheck: pre.record,
      acceptance_criteria: pre.criteria,
      resources: [{ type: 'capture', id: grounded.captureId, label: (ctx.captureTitle && ctx.captureTitle.trim()) || 'Source capture' }],
    })
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
  if (runErr) {
    await supabase.from('agent_run').delete().eq('id', agentRunId).eq('workspace_id', workspaceId)
    await supabase.from('actions').delete().eq('id', actionId).eq('workspace_id', workspaceId)
    return no('launch_failed', `run: ${runErr.message}`)
  }
  await ensureWorkForAgentRun(
    supabase,
    {
      id: agentRunId,
      workspace_id: workspaceId,
      kind: 'coding',
      status: 'queued',
      triggered_by: ctx.userId,
      action_id: actionId,
      origin: 'attempt',
      ai_team_member_id: developer.id,
      source_capture_id: grounded.captureId,
      provenance: { captureId: grounded.captureId, quote: grounded.quote },
    },
    { actionTitle: title },
  )
  const send = deps.send ?? ((e: { name: string; data: Record<string, unknown> }) => inngest.send(e))
  await send({ name: 'agent/run.requested', data: { agent_run_id: agentRunId, workspace_id: workspaceId } })
  return { attempted: true, reused: false, agentRunId, fireKey, teammateId: developer.id }
}
