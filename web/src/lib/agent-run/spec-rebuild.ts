/**
 * Deterministic spec rebuild for the eve `coding-agent` (Phase 3) — the ONE
 * place a coding run's spec is built, for BOTH origins.
 *
 * Given a run's routing facts (agentRunId + workspace tenancy), reconstruct
 * EXACTLY what the eve coding-agent resolvers need — the persona system prompt,
 * the task text, the target repo/branch, the cloud-environment shaping (network
 * policy, env vars, setup script) — and, for the app's own server-side use
 * only, the triggering user's GitHub OAuth token, from live DB state.
 *
 * One function for every caller (so they can never disagree on "is this runnable"):
 *   - the internal spec route (rebuildAgentRunSpec, keyed by a VERIFIED run token)
 *     — what the eve agent's resolvers fetch at session start (without the
 *     GitHub token: CodingAgentSpec);
 *   - agentRunExecute's precondition guard (buildAgentRunSpec), which fails a run
 *     with an origin-aware reason BEFORE an eve session is ever created;
 *   - the git gate (loadPushTarget in git-push-proxy.ts), which reads the
 *     run's repo, branch and GitHub token on every clone, fetch and push.
 *
 * ── Two origins ─────────────────────────────────────────────────────────────
 *   - ACTION-ORIGIN (`action_id` set — "Start" on an assigned action, or a
 *     run_agent flow action with use_triggering_action_context): the task is the
 *     `<issue>` block composed from the action (composeActionTaskPrompt), the repo
 *     is the action's project repo, the persona is the assigned ai_team_member, and
 *     the project may link a cloud environment.
 *   - FLOW-ORIGIN (`action_id` NULL — a run_agent flow action with no triggering
 *     action): there is no action to derive from, so the run carries everything on
 *     its own row (run-agent.ts's insert, migration 163): `task_prompt` (the
 *     flow's pre-rendered instructions, used verbatim), `repo_full_name`, and the
 *     persona as `agent_recipe_id` (a config-picked agent recipe) or, failing
 *     that, `ai_team_member_id`. No project: the run's own environment, else
 *     the workspace's default cloud environment (migration 420 backfilled a
 *     trusted "Default cloud" for every workspace with a flow, the network
 *     these runs always got), else the sandbox defaults.
 *
 * ── The cloud environment (migration 420, resolveRunEnvironment) ────────────
 *   the run's own (agent_run.environment_id, stamped when it was created);
 *   if that one was archived or can't be used any more, the run fails with a
 *   plain reason and never runs anywhere else. A run that recorded none
 *   (made before 420) gets its action's project's, else the workspace
 *   default, else the defaults (trusted egress, no setup, no user env). Read
 *   at every session start, so an edit to the environment applies to the
 *   run's next session.
 *
 * This runs in the Next runtime (the internal route / Inngest), where the
 * Next-coupled persona loader and the OAuth-token table are available — the eve
 * Nitro runtime never imports them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { surfaceModelSlug } from '@/lib/ai/model-defaults'
import {
  loadAgentPersona,
  loadAgentPersonaFromRecipe,
  composeEveCodingSystemPrompt,
  composeActionTaskPrompt,
  type AgentPersona,
} from '@/lib/ai/agent-run-context'
import { resolveRepoDefaultBranch } from '@/lib/agent-run/github-default-branch'
import { parseEnvText } from '@/lib/agent-run/env-parsing'
import { gatewayTelemetryValues, type GatewayTelemetryValues } from '@/lib/ai/gateway-telemetry'
import type { AgentRunTokenClaims } from './agent-run-token'
import { mintGitPushToken } from './git-push-token'
import { gitGateAddressBound } from './git-gate-address'
import { precheckTaskBlock, readRunPrecheck } from '@/lib/coding/precheck'
import { ciFixTaskBlock, readCiFix } from '@/lib/coding/ci-fix-task'
import { resolveRunEnvironment } from '@/lib/environments/resolve'
import { EnvironmentError, isRepoFullName } from '@/lib/environments/types'

// The persona prompt is composeEveCodingSystemPrompt: the eve coding-agent has
// no Native Intelligence MCP server and never opens the PR itself (push + finish_run).
//
// The base branch (clone ref + PR base) is the repo's REAL default branch,
// resolved from GitHub (github-default-branch.ts, 'main' on any failure), and
// the prompt names it so the model's finish_run `pr.base` matches the clone.

type NetworkAccess = 'trusted' | 'restricted' | 'isolated'

/** The eve-facing spec — the exact shape the design doc pins. */
export interface EveAgentRunSpec {
  systemPrompt: string
  taskPrompt: string
  model: string
  /** "owner/repo" to clone + open a PR against. */
  repoFullName: string
  /** The branch the PR merges INTO (clone ref / PR base). */
  baseBranch: string
  /** The branch the agent pushes — `dial8/<identifier>-<first-8-of-run-id>`. */
  branchName: string
  /** Cloud-environment network reach; maps to the sandbox network policy. */
  networkAccess: NetworkAccess
  /** Bash run after clone, before the agent starts. Null when no environment. */
  setupScript: string | null
  /** User-supplied env vars from the linked cloud environment (parsed .env). */
  envVars: Record<string, string>
  /**
   * Triggering user's GitHub OAuth token (repo scope). SERVER-SIDE ONLY: the
   * git gate (git-read-proxy.ts, git-push-proxy.ts) reads it through this
   * build to clone, fetch and push for the run. It is never served to the
   * coding agent: the spec route's build (rebuildAgentRunSpec,
   * CodingAgentSpec) drops it.
   */
  githubToken: string
  /**
   * A CI fix run (P10 F7): the open PR's branch, which the sandbox fetches
   * and forks the working branch (a side branch) from, instead of the base.
   * Absent for every other run.
   */
  startFrom?: string
  /**
   * Per-user Gateway attribution (Phase A). The eve coding-agent's model resolver
   * rebuilds `providerOptions.gateway` from this so coding-run spend is attributed
   * per user/feature. Present ONLY when GATEWAY_USER_TAGGING is on; absent (no-op)
   * when off.
   */
  gatewayTelemetry?: GatewayTelemetryValues
}

/**
 * The spec the coding agent is served (the spec route's response): the build
 * WITHOUT the GitHub token, plus the run's git gate token (git-push-token.ts),
 * the only credential the sandbox side gets. The sandbox refuses to start
 * without it, since it could neither clone nor push. `gitGateAddressBound`
 * says whether the gate takes that token only from the sandbox server's
 * addresses (AGENT_RUN_GIT_GATE_ALLOWED_ADDRESSES, git-gate-address.ts): the
 * coding agent refuses to run on its own sandbox runtime, where the token sits
 * in the sandbox, unless it is true.
 */
export type CodingAgentSpec = Omit<EveAgentRunSpec, 'githubToken'> & { gitPushToken: string; gitGateAddressBound: boolean }

/** Which kind of agent_run row the spec was built from. */
export type AgentRunOrigin = 'action' | 'flow'

/**
 * The outcome of building a run's spec. `ok:false` carries a human-readable,
 * origin-aware `reason` — the SAME message the run is failed with — so the
 * dispatcher's precondition guard and the spec route agree on runnability.
 * `run` is null only when the agent_run row itself doesn't exist (workspace-
 * scoped); otherwise it carries the non-secret routing facts the dispatcher
 * needs (never the GitHub token).
 */
export interface AgentRunFacts {
  actionId: string | null
  triggeredBy: string | null
  /** The row's status at build time (the spec route refuses non-live runs). */
  status: string | null
}

export type AgentRunSpecBuild =
  | {
      ok: true
      spec: EveAgentRunSpec
      origin: AgentRunOrigin
      run: AgentRunFacts
    }
  | {
      ok: false
      reason: string
      origin: AgentRunOrigin | null
      run: AgentRunFacts | null
    }

/** The reason a missing agent_run row yields (also the route's 404 cause). */
export const AGENT_RUN_NOT_FOUND = 'agent_run not found'

/** The reason a run fails when its cloud environment can't be read (never the open defaults instead). */
export const RUN_ENVIRONMENT_UNREADABLE = "The run's cloud environment could not be read."

/** Why a run whose repository field isn't a plain owner/repo never builds (the field is member-written). */
export const BAD_REPO_REASON = "The project's GitHub repository isn't a plain owner/repo. Fix it on the project, then start the run again."

/**
 * Statuses in which a run may no longer be handed its spec (and with it a git
 * gate token), nor use the git gate: the user asked it to stop, or it settled.
 */
export const NOT_LIVE_STATUSES: ReadonlySet<string> = new Set(['canceling', 'pr_open', 'completed', 'failed', 'canceled'])

/**
 * Generate the run's head branch: `dial8/<identifier-lowercased>-<first-8-of-run-id>`.
 * Keyed off the run id + identifier so re-mints are stable for one run.
 */
export function branchNameFor(identifierOrId: string, agentRunId: string): string {
  return `dial8/${identifierOrId.toLowerCase()}-${agentRunId.slice(0, 8)}`
}

/**
 * A flow-origin run has no action identifier, so its branch is keyed off the
 * run id (the branch template slugs + truncates this anyway): dial8/flow-<8>-<8>.
 */
function flowRunIdentifier(agentRunId: string): string {
  return `flow-${agentRunId.slice(0, 8)}`
}

/** The head/base pair a run's first spec build stored (agent_run.branch / base_branch). */
export interface StoredSpecBranches {
  branchName: string | null
  baseBranch: string | null
}

/**
 * Read the stored head/base pair. A separate, error-tolerant query: before
 * migration 371 is applied the base_branch column doesn't exist, and that must
 * not break building a spec (it reads as "nothing stored").
 */
export async function readSpecBranches(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string },
): Promise<StoredSpecBranches> {
  const { data, error } = await supabase
    .from('agent_run')
    .select('branch, base_branch')
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error || !data) return { branchName: null, baseBranch: null }
  const row = data as { branch?: unknown; base_branch?: unknown }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)
  return { branchName: str(row.branch), baseBranch: str(row.base_branch) }
}

/**
 * Store the spec's head/base pair once (only while base_branch is still NULL,
 * so a concurrent build can't overwrite the first). Best-effort: a failure
 * (e.g. migration 371 not applied yet) is logged and the spec is still served.
 */
async function persistSpecBranches(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string; branchName: string; baseBranch: string },
): Promise<void> {
  try {
    const { error } = await supabase
      .from('agent_run')
      .update({ branch: args.branchName, base_branch: args.baseBranch })
      .eq('id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .is('base_branch', null)
    if (error) console.warn(`[spec-rebuild] could not store the spec branches for ${args.agentRunId}: ${error.message}`)
  } catch (err) {
    console.warn(`[spec-rebuild] could not store the spec branches for ${args.agentRunId}:`, err)
  }
}

/**
 * The head branch a coding run's spec names (the branch the sandbox checked out
 * and the push guard allows), derived the same way buildAgentRunSpec derives it
 * and without the rest of the spec. The outcome route holds `pr.head` to it.
 * Null when an action-origin run's action no longer exists.
 */
export async function specHeadBranch(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string; actionId: string | null },
): Promise<string | null> {
  if (!args.actionId) return branchNameFor(flowRunIdentifier(args.agentRunId), args.agentRunId)
  const { data: action } = await supabase
    .from('actions')
    .select('id, identifier')
    .eq('id', args.actionId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (!action) return null
  const identifierOrId = (action.identifier as string | null) || (action.id as string)
  return branchNameFor(identifierOrId, args.agentRunId)
}

/**
 * The first unmet precondition, in the order the run was always checked (repo →
 * GitHub token → persona → task), phrased for the run's origin. Null when the run
 * is runnable. A flow-origin run has no "action" to blame, so its messages point
 * at the run_agent flow action instead.
 */
function preconditionFailure(
  origin: AgentRunOrigin,
  facts: { repoFullName: string | null; githubToken: string | null; hasPersona: boolean; taskPrompt: string },
): string | null {
  const isFlow = origin === 'flow'
  if (!facts.repoFullName) {
    return isFlow
      ? 'No repository for this run — set a repo on the run_agent action (or enable "use triggering action context").'
      : "The action has no project repository (set the project's github_repo)."
  }
  if (!facts.githubToken) return 'No GitHub token for the user who started the run — connect GitHub.'
  if (!facts.hasPersona) {
    return isFlow
      ? 'The agent could not be loaded — pick a valid agent (an agent recipe, not a skill).'
      : 'The assigned agent could not be loaded.'
  }
  if (!facts.taskPrompt.trim()) {
    return 'No task text — the run_agent action has no instructions and no triggering action to derive a task from.'
  }
  return null
}

/**
 * Build a coding run's eve spec from live DB state (service-role client; every
 * read is scoped to `workspaceId`). Never throws for an unrunnable run — returns
 * `ok:false` with the reason instead.
 */
export async function buildAgentRunSpec(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string },
): Promise<AgentRunSpecBuild> {
  const { agentRunId, workspaceId } = args

  const { data: run } = await supabase
    .from('agent_run')
    .select('id, kind, status, action_id, flow_id, ai_team_member_id, agent_recipe_id, task_prompt, repo_full_name, triggered_by, environment_id')
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!run) return { ok: false, reason: AGENT_RUN_NOT_FOUND, origin: null, run: null }
  // Work runs (kind='workspace') share this table and the run-token format but
  // are never coding runs: a work-run row is "not found" here, by design, so a
  // work-run token can never be turned into a coding spec (+ GitHub token).
  // `kind` is NOT NULL DEFAULT 'coding' (migration 197).
  if (run.kind && run.kind !== 'coding') {
    return { ok: false, reason: AGENT_RUN_NOT_FOUND, origin: null, run: null }
  }

  const actionId = (run.action_id as string | null) ?? null
  const triggeredBy = (run.triggered_by as string | null) ?? null
  const runFacts: AgentRunFacts = { actionId, triggeredBy, status: (run.status as string | null) ?? null }

  let origin: AgentRunOrigin
  let identifierOrId: string
  let repoFullName: string | null
  let taskPrompt: string
  let persona: AgentPersona | null = null
  let projectId: string | null = null
  let attributionTag: string | null
  let startFrom: string | null = null

  if (!actionId) {
    // ── FLOW-ORIGIN: everything comes off the row itself ──
    origin = 'flow'
    identifierOrId = flowRunIdentifier(agentRunId)
    repoFullName = (run.repo_full_name as string | null)?.trim() || null
    if (repoFullName && !isRepoFullName(repoFullName)) return { ok: false, reason: BAD_REPO_REASON, origin, run: runFacts }
    taskPrompt = (run.task_prompt as string | null) ?? ''
    // Persona: a config-picked agent recipe, else an inherited assignee.
    if (run.agent_recipe_id) {
      persona = await loadAgentPersonaFromRecipe(supabase, run.agent_recipe_id as string, workspaceId)
    } else if (run.ai_team_member_id) {
      persona = await loadAgentPersona(supabase, run.ai_team_member_id as string, workspaceId)
    }
    attributionTag = run.flow_id ? `flow:${run.flow_id as string}` : null
  } else {
    // ── ACTION-ORIGIN: derive from the action + its project ──
    origin = 'action'
    const { data: action } = await supabase
      .from('actions')
      .select(
        `id, identifier, title, description, priority, project_id,
         workflow_state:workflow_state!status_id(name),
         project:projects!project_id(name, github_repo)`,
      )
      .eq('id', actionId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!action) {
      return { ok: false, reason: "The run's action no longer exists.", origin, run: runFacts }
    }

    const project = action.project as unknown as {
      name?: string
      github_repo?: string | null
    } | null
    repoFullName = project?.github_repo?.trim() || null
    projectId = (action.project_id as string | null) ?? null
    // Member-written text (projects UPDATE RLS): a run clones, and its prompt
    // names, only a plain owner/repo.
    if (repoFullName && !isRepoFullName(repoFullName)) return { ok: false, reason: BAD_REPO_REASON, origin, run: runFacts }

    if (run.ai_team_member_id) {
      persona = await loadAgentPersona(supabase, run.ai_team_member_id as string, workspaceId)
    }

    const ws = action.workflow_state as unknown as { name?: string } | null
    identifierOrId = (action.identifier as string | null) || (action.id as string)
    taskPrompt = composeActionTaskPrompt({
      identifierOrId,
      title: action.title as string,
      statusName: ws?.name ?? null,
      priority: action.priority as string | null,
      projectName: project?.name ?? null,
      repoFullName,
      description: action.description as string | null,
    })
    // The pre-check's acceptance criteria and the person's answers to its
    // questions (P10 F5, migration 392), after the <issue> block.
    const pre = await readRunPrecheck(supabase, { agentRunId, workspaceId })
    const preBlock = precheckTaskBlock({ criteria: pre.criteria, precheck: pre.precheck })
    if (preBlock) taskPrompt = `${taskPrompt}\n\n${preBlock}`
    // A CI fix run (P10 F7, migration 394): the failing checks, fenced, and a
    // side branch forked from the open PR's branch. Decided on the fix link
    // alone: a fix run never forks from the base.
    const ciFix = await readCiFix(supabase, { agentRunId, workspaceId })
    if (ciFix.fixOf) {
      if (ciFix.failure) taskPrompt = `${taskPrompt}\n\n${ciFixTaskBlock(ciFix.failure)}`
      if (!ciFix.prBranch) return { ok: false, reason: 'The pull request this CI fix run fixes no longer has a branch.', origin, run: runFacts }
      startFrom = ciFix.prBranch
    }
    attributionTag = `action:${actionId}`
  }

  // The run's cloud environment. One it can't use, or a read that fails,
  // fails the build rather than falling back to another environment or to
  // the defaults, the most open network.
  let networkAccess: NetworkAccess = 'trusted'
  let setupScript: string | null = null
  let envVars: Record<string, string> = {}
  try {
    const env = await resolveRunEnvironment(supabase, {
      runEnvironmentId: (run.environment_id as string | null) ?? null,
      projectId,
      workspaceId,
      userId: triggeredBy,
    })
    if (env) {
      networkAccess = env.networkAccess
      setupScript = env.setupScript
      envVars = parseEnvText(env.envVars)
    }
  } catch (err) {
    if (err instanceof EnvironmentError) return { ok: false, reason: err.message, origin, run: runFacts }
    console.error(`[spec-rebuild] the environment of ${agentRunId} could not be read:`, err instanceof Error ? err.message : err)
    return { ok: false, reason: RUN_ENVIRONMENT_UNREADABLE, origin, run: runFacts }
  }

  // The triggering user's stored GitHub token (the lookup every coding path makes).
  const githubToken = triggeredBy ? await storedGithubToken(supabase, triggeredBy) : null
  const derivedBranchName = branchNameFor(identifierOrId, agentRunId)

  // Precondition order stays repo → token → persona → task. The persona prompt
  // is composed after, once the base branch it names is known.
  const failure = preconditionFailure(origin, { repoFullName, githubToken, hasPersona: persona !== null, taskPrompt })
  if (failure || !repoFullName || !githubToken || !persona) {
    return { ok: false, reason: failure ?? 'The run is not runnable.', origin, run: runFacts }
  }

  // One head/base pair per run: the first build stores it, every later build
  // (the dispatcher's guard, each spec fetch) reuses it, so the sandbox clone,
  // the prompt and the outcome route's check can't disagree (migration 371).
  const stored = await readSpecBranches(supabase, { agentRunId, workspaceId })
  const hasStored = Boolean(stored.baseBranch && stored.branchName)
  const branchName = hasStored ? stored.branchName! : derivedBranchName
  const baseBranch = hasStored ? stored.baseBranch! : await resolveRepoDefaultBranch(repoFullName, githubToken)
  if (!hasStored && runFacts.status && !NOT_LIVE_STATUSES.has(runFacts.status)) {
    await persistSpecBranches(supabase, { agentRunId, workspaceId, branchName, baseBranch })
  }
  const systemPrompt = composeEveCodingSystemPrompt(persona, { baseBranch, branchName })

  // Per-user Gateway attribution (Phase A). Feature 'coding_run'; identity is the
  // triggering user (run.triggered_by), tagged runtime:eve + the action (or flow)
  // the run came from. `?? undefined` keeps the field absent when the flag is
  // off. The agent-side resolver shape-guards it.
  const gatewayTelemetry =
    gatewayTelemetryValues(triggeredBy, 'coding_run', {
      workspaceId,
      runtime: 'eve',
      extraTags: attributionTag ? [attributionTag] : [],
    }) ?? undefined

  return {
    ok: true,
    origin,
    run: runFacts,
    spec: {
      systemPrompt,
      taskPrompt,
      // The Strong tier (STRONG_MODEL, the newest Sonnet), as a Gateway slug:
      // the coding agent runs Anthropic models (SURFACE_MODELS.coding_runs).
      model: surfaceModelSlug('coding_runs'),
      repoFullName,
      baseBranch,
      branchName,
      networkAccess,
      setupScript,
      envVars,
      githubToken,
      gatewayTelemetry,
      ...(startFrom ? { startFrom } : {}),
    },
  }
}

/**
 * Rebuild the eve-facing spec from VERIFIED token claims (the internal spec
 * route). Tenancy is the token's. Returns null when the run can't be rebuilt —
 * a missing run, a missing action, or a missing repo/token/persona/task — and the
 * route then 404s; the watcher settles the run failed.
 *
 * Also null once the run is canceling or settled: a run token lives an hour, and
 * a canceled or finished run must not be able to re-obtain the spec (and the
 * git gate token minted with it). The dispatcher calls buildAgentRunSpec
 * directly and keeps its own idempotency guard for terminal rows, so this
 * check lives here.
 *
 * The GitHub token is dropped here: the coding agent never receives it (the git
 * gate adds it server-side). The run's git gate token is minted instead.
 */
export async function rebuildAgentRunSpec(
  claims: AgentRunTokenClaims,
): Promise<CodingAgentSpec | null> {
  const built = await buildAgentRunSpec(getServiceClient(), {
    agentRunId: claims.agentRunId,
    workspaceId: claims.workspaceId,
  })
  if (!built.ok) return null
  if (built.run.status && NOT_LIVE_STATUSES.has(built.run.status)) return null
  const { githubToken: _serverSideOnly, ...served } = built.spec
  void _serverSideOnly
  const gitPushToken = mintGitPushToken({
    agentRunId: claims.agentRunId,
    workspaceId: claims.workspaceId,
    repoFullName: served.repoFullName,
    branchName: served.branchName,
  })
  return { ...served, gitPushToken, gitGateAddressBound: gitGateAddressBound() }
}
