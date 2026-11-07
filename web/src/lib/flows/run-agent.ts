/**
 * run_agent executor — the loop engine's SECOND runtime. Where run-skill.ts
 * runs the loop body as a headless skill run that reports, this dispatches a
 * sandboxed coding run (eve `coding-agent` → repo checkout → PR) as a native
 * flow action, via the agent_run infrastructure (agent_run table,
 * `agent/run.requested` event, agentRunExecute, idempotency guard).
 *
 * FIRE-AND-FORGET. The whole executor is: resolve repo/agent/instructions,
 * create an agent_run row, and emit `agent/run.requested`, then return. The
 * minutes-long run executes in agentRunExecute with its OWN retries,
 * concurrency cap, idempotency guard, and outcome recording — none of which
 * this executor touches or waits on. A flow-origin row (no triggering action)
 * carries its own repo / persona / task (migration 163); the eve spec build
 * (src/lib/agent-run/spec-rebuild.ts) reads them straight off the row. A
 * status:'success' result means "queued OK", NOT "the agent finished".
 *
 * ┌───────────────────────────────────────────────────────────────────────┐
 * │ INERT IN v1 — the live dispatch is DISARMED behind                     │
 * │ RUN_AGENT_DISPATCH_ENABLED (default false). With the flag off the      │
 * │ executor short-circuits BEFORE any agent_run row insert or event emit  │
 * │ and records a clean inert ActionResult. No sandbox can boot by         │
 * │ accident. See docs/loop-engine/RUN-AGENT-DESIGN.md → "The safety flag".│
 * └───────────────────────────────────────────────────────────────────────┘
 *
 * The runner (runner.ts) stays pure: callers build this executor and inject it
 * via runFlow's `executors.run_agent`. Every service-role query here filters by
 * workspace_id — this runs RLS-bypassed.
 */
import { getServiceClient } from '@/lib/admin'
import { inngest } from '@/lib/inngest/client'
import { ensureWorkForAgentRun } from '@/lib/work/agent-run-mirror'
import { runEnvironmentIdFor } from '@/lib/environments/resolve'
import { renderTemplate, buildTemplateContext } from './template'
import { composeActionTaskPrompt, fenceUntrustedValue } from '@/lib/ai/agent-run-context'
import type { RunAgentExecutor, RunAgentExecutionResult, RunnerEntityData } from './runner'
import type { RunAgentActionConfig } from './types'
import { storedGithubToken } from '@/lib/oauth/github-token'

/**
 * THE SAFETY FLAG. Default false. When false the executor never inserts an
 * agent_run row and never emits `agent/run.requested` — it short-circuits at
 * the flag gate (step 4) and returns the inert ActionResult. A human flips this
 * (env on Vercel, or this constant) ONLY after migration 158 is applied and the
 * null-action_id context-loader guard has landed. A single, greppable switch
 * between "reviewable, inert" and "live agents opening PRs".
 */
export const RUN_AGENT_DISPATCH_ENABLED =
  process.env.RUN_AGENT_DISPATCH_ENABLED === 'true'

/** "owner/repo" — a single slash, non-empty owner + repo segments. */
const REPO_FULL_NAME_RE = /^[^/\s]+\/[^/\s]+$/

/**
 * Build the real run_agent executor for one flow fire. Bind the flow's
 * workspace + run-as identity + flow id here; the runner then calls the
 * executor once per eligible run_agent action.
 *
 * Run-as identity: the agent run is attributed to that user — their GitHub
 * token authorizes clone + PR. Dispatch fires pass flow.created_by (which the PATCH route
 * re-stamps to whoever last changed the flow's actions or trigger, so a member
 * can never ride another member's GitHub/MCP identity by editing their flow).
 * Test-fires pass the calling user.
 */
export function createRunAgentExecutor(deps: {
  workspaceId: string
  /** The originating flow — recorded on agent_run.flow_id (migration 158). */
  flowId: string | null
  /** User the agent run runs AS — null falls back to the workspace owner. */
  runAsUserId: string | null
  /**
   * Stable-per-fire id (Inngest event id) for the idempotency guard. The
   * enclosing flow-dispatch step runs under retries:1, so a retry re-runs this
   * executor and would otherwise insert a SECOND agent_run row + emit a SECOND
   * `agent/run.requested` (a distinct agent_run_id, so agentRunExecute's own
   * guard can't catch it → doubled sandbox/compute). Absent (test-fire) → no
   * guard, unchanged behaviour.
   */
  fireId?: string | null
}): RunAgentExecutor {
  return async (action, ctx) => {
    const startedAt = Date.now()
    const config = action.config as RunAgentActionConfig
    const summaryUrl = `agent://${config.agent_id || 'inherited'}`

    const failed = (message: string): RunAgentExecutionResult => ({
      status: 'failed',
      request_summary: { method: 'AGENT', url: summaryUrl, header_names: [], body_byte_length: 0 },
      response_status_code: 500,
      response_body_preview: null,
      error_message: message,
      duration_ms: Date.now() - startedAt,
      dispatched: false,
      agent_run_id: null,
    })

    // The small_bug_draft_prs recipe's step (P10 F4) runs nothing of its own:
    // it rides Triage's one read of the call (src/lib/coding/proactive.ts).
    // The ci_fix_loop recipe's step (P10 F7) is the owner's opt-in, read by the
    // GitHub webhook's CI path (src/lib/coding/ci-fix.ts); a PR fire runs nothing.
    if (config.fix_ci === true) {
      return {
        status: 'success',
        request_summary: { method: 'AGENT', url: 'agent://ci-fix', header_names: [], body_byte_length: 0 },
        response_status_code: 204,
        response_body_preview: 'the CI fix loop acts on failing checks, not on this pull request change',
        error_message: null,
        duration_ms: Date.now() - startedAt,
        dispatched: false,
        agent_run_id: null,
      }
    }
    if (config.attempt_small_bugs === true) {
      return {
        status: 'success',
        request_summary: { method: 'AGENT', url: 'agent://small-bugs', header_names: [], body_byte_length: 0 },
        response_status_code: 204,
        response_body_preview: "rides Triage's read: small, clear bugs from this call are attempted there",
        error_message: null,
        duration_ms: Date.now() - startedAt,
        dispatched: false,
        agent_run_id: null,
      }
    }

    try {
      const supabase = getServiceClient()
      const { workspaceId } = deps

      // 1. Resolve the run-as identity.
      let runAsUserId = deps.runAsUserId
      if (!runAsUserId) {
        const { data: owner } = await supabase
          .from('member')
          .select('user_id')
          .eq('workspace_id', workspaceId)
          .eq('role', 'owner')
          .limit(1)
          .maybeSingle()
        runAsUserId = owner?.user_id ?? null
      }
      if (!runAsUserId) {
        return failed('No run-as identity: flow has no creator and workspace has no owner')
      }

      // 2. Resolve repo + agent + instructions. Config carries them explicitly;
      // the use_triggering_action_context override (entity_status_change on an
      // action) inherits repo (project's github_repo), agent (the action's
      // assignee), and augments instructions with the <issue> context block.
      const useAction =
        config.use_triggering_action_context === true &&
        ctx.entity !== null &&
        (ctx.entity as RunnerEntityData).kind === 'action'

      let repo = typeof config.repo === 'string' && config.repo.trim() ? config.repo.trim() : null
      // agent_id from config, or the action's assignee_ai_member_id under the override.
      let aiTeamMemberId: string | null = null
      const agentRecipeId = typeof config.agent_id === 'string' && config.agent_id ? config.agent_id : null
      let triggeringActionId: string | null = null
      let triggeringProjectId: string | null = null
      let issueBlock: string | null = null

      if (useAction) {
        const entityAction = ctx.entity as Extract<RunnerEntityData, { kind: 'action' }>
        triggeringActionId = entityAction.id
        // Inherit repo + assignee + <issue> context from the triggering action.
        const { data: actionRow } = await supabase
          .from('actions')
          .select(
            `id, identifier, title, description, assignee_ai_member_id, project_id,
             workflow_state:workflow_state!status_id(name),
             project:projects!project_id(name, github_repo)`,
          )
          .eq('id', entityAction.id)
          .eq('workspace_id', workspaceId)
          .maybeSingle()
        if (actionRow) {
          triggeringProjectId = (actionRow.project_id as string | null) ?? null
          const project = actionRow.project as unknown as { name?: string; github_repo?: string | null } | null
          if (!repo && project?.github_repo) repo = project.github_repo
          if (!aiTeamMemberId && actionRow.assignee_ai_member_id) {
            aiTeamMemberId = actionRow.assignee_ai_member_id as string
          }
          const ws = actionRow.workflow_state as unknown as { name?: string } | null
          // The same composer as an action-origin run's spec: title and
          // description fenced as untrusted, tags defused.
          issueBlock = composeActionTaskPrompt({
            identifierOrId: (actionRow.identifier as string | null) || (actionRow.id as string),
            title: actionRow.title as string,
            statusName: ws?.name ?? null,
            projectName: project?.name ?? null,
            repoFullName: repo,
            description: actionRow.description as string | null,
          })
        }
      }

      // 3. Precondition checks (clean failures, never throws).
      if (!repo || !REPO_FULL_NAME_RE.test(repo)) {
        return failed(
          'run_agent has no repo (set repo or enable use_triggering_action_context on an action trigger)',
        )
      }

      // Run-as user must have a GitHub token AND be able to reach the repo. This
      // is the honest, early failure the flow author sees — the agentRunExecute
      // precondition guard is the defense-in-depth re-check at run time.
      if (!(await storedGithubToken(supabase, runAsUserId))) {
        return failed('no GitHub access for run-as user')
      }

      // Resolve the agent persona identity. Under the override we may inherit the
      // action's assignee (ai_team_member); otherwise config.agent_id is a recipe
      // id — agentRunExecute's loadAgentPersona is adapted to accept either.
      if (!aiTeamMemberId && !agentRecipeId) {
        return failed('run_agent has no agent persona (pick an agent or enable use_triggering_action_context)')
      }

      // Template-render the task text against the fire.
      const templateCtx = buildTemplateContext(ctx.entity, ctx.trigger, ctx.appBaseUrl, {
        workspaceId,
        capture: ctx.capture ?? null,
      })
      // The flow author's instructions are theirs; the values substituted into
      // them (titles, descriptions, capture text) may come from a meeting or an
      // email, so each is fenced as untrusted. spec-rebuild uses this verbatim.
      const rendered = config.instructions
        ? renderTemplate(config.instructions, templateCtx, { transformValue: fenceUntrustedValue })
        : ''
      const taskPrompt = [issueBlock, rendered].filter(Boolean).join('\n\n')

      // ────────────────────────────────────────────────────────────────────
      // 4. THE FLAG GATE. With RUN_AGENT_DISPATCH_ENABLED off (v1), stop HERE —
      //    before any agent_run row insert (step 5) or event emit (step 6).
      //    Nothing is written; nothing is queued; no sandbox can ever boot.
      //    This is NOT a failure: the feature is deliberately disarmed, so we
      //    record status:'success' with dispatched:false.
      // ────────────────────────────────────────────────────────────────────
      if (!RUN_AGENT_DISPATCH_ENABLED) {
        return {
          status: 'success',
          request_summary: {
            method: 'AGENT',
            url: summaryUrl,
            header_names: [],
            body_byte_length: new TextEncoder().encode(taskPrompt).length,
          },
          response_status_code: 202,
          response_body_preview: 'run_agent dispatch is not yet enabled',
          error_message: null,
          duration_ms: Date.now() - startedAt,
          dispatched: false,
          agent_run_id: null,
        }
      }

      // 4b. Idempotency guard. The flow-dispatch step runs under retries:1, so
      //     a retry re-enters this executor and would insert a SECOND agent_run
      //     + emit a SECOND `agent/run.requested` for the SAME fire — a distinct
      //     agent_run_id, so agentRunExecute's own per-row guard can't dedup it,
      //     doubling sandbox/compute.
      //     With a fireId we get exactly-once via agent_run.fire_key
      //     (migration 196, UNIQUE): the
      //     insert below carries the key and a retry's duplicate hits 23505.
      //     Without one (test-fire), fall back to the approximate guard: if a
      //     non-terminal run already exists for this (flow, action) pair, treat
      //     this as the retry and return the existing dispatch.
      const fireKey = deps.fireId ? `${deps.fireId}:${action.id}` : null
      if (!fireKey) {
        let existingQuery = supabase
          .from('agent_run')
          .select('id')
          .eq('workspace_id', workspaceId)
          // pr_open is terminal too (delegation.ts TERMINAL): a finished run
          // waiting on its PR is not this fire's in-flight retry.
          .not('status', 'in', '(pr_open,completed,failed,canceled)')
          .order('created_at', { ascending: false })
          .limit(1)
        existingQuery = deps.flowId
          ? existingQuery.eq('flow_id', deps.flowId)
          : existingQuery.is('flow_id', null)
        existingQuery = triggeringActionId
          ? existingQuery.eq('action_id', triggeringActionId)
          : existingQuery.is('action_id', null)
        const { data: existing } = await existingQuery.maybeSingle()
        if (existing?.id) {
          return {
            status: 'success',
            request_summary: {
              method: 'AGENT',
              url: summaryUrl,
              header_names: [],
              body_byte_length: new TextEncoder().encode(taskPrompt).length,
            },
            response_status_code: 202,
            response_body_preview: `Agent run ${existing.id} already dispatched for this fire`,
            error_message: null,
            duration_ms: Date.now() - startedAt,
            dispatched: true,
            agent_run_id: existing.id as string,
          }
        }
      }

      // 5. Create the agent_run row (service client, workspace-scoped).
      //    - action_id: the triggering action when one exists (nullable since
      //      migration 158), else NULL for a flow-origin run.
      //    - flow_id: the originating flow.
      //    - ai_team_member_id: set only under the use_triggering_action_context
      //      override (inherited from the action's assignee).
      //    - agent_recipe_id + task_prompt (migration 163): a flow-origin run has
      //      no action to derive its persona/prompt from, so it carries them on
      //      the row — the agentRunExecute loader reads them when action_id is
      //      NULL (loadAgentPersonaFromRecipe + task_prompt verbatim).
      //    - environment_id (migration 420): the environment it starts in, the
      //      triggering action's project's, else the workspace default (for a
      //      flow with no project, the backfilled trusted "Default cloud").
      const environmentId = await runEnvironmentIdFor(supabase, { projectId: triggeringProjectId, workspaceId, userId: runAsUserId })
      const { data: run, error: insertError } = await supabase
        .from('agent_run')
        .insert({
          workspace_id: workspaceId,
          action_id: triggeringActionId,
          flow_id: deps.flowId,
          ai_team_member_id: aiTeamMemberId,
          agent_recipe_id: aiTeamMemberId ? null : agentRecipeId,
          task_prompt: taskPrompt,
          triggered_by: runAsUserId,
          status: 'queued',
          // A loop started it, not a person (P10): its PR is a draft
          // (src/lib/coding/unattended.ts). 'loop' is in agent_run_origin_check.
          origin: 'loop',
          repo_full_name: repo,
          fire_key: fireKey,
          environment_id: environmentId,
        })
        .select('id')
        .single()
      // 23505 = fire_key already exists (a step retry re-ran the dispatch).
      // Idempotent: reuse the existing run instead of booting a second sandbox.
      if (insertError?.code === '23505' && fireKey) {
        const { data: existing } = await supabase
          .from('agent_run')
          .select('id')
          .eq('fire_key', fireKey)
          .maybeSingle()
        if (existing?.id) {
          return {
            status: 'success',
            request_summary: {
              method: 'AGENT',
              url: summaryUrl,
              header_names: [],
              body_byte_length: new TextEncoder().encode(taskPrompt).length,
            },
            response_status_code: 202,
            response_body_preview: `Agent run ${existing.id} already dispatched for this fire`,
            error_message: null,
            duration_ms: Date.now() - startedAt,
            dispatched: true,
            agent_run_id: existing.id as string,
          }
        }
      }
      if (insertError || !run) {
        return failed(`agent_run insert failed: ${insertError?.message ?? 'unknown error'}`)
      }
      const agentRunId = run.id as string

      // The run's ledger row exists from dispatch (queued) so Activity shows it
      // before the sandbox boots. Best-effort: never blocks the dispatch.
      await ensureWorkForAgentRun(supabase, {
        id: agentRunId,
        workspace_id: workspaceId,
        kind: 'coding',
        status: 'queued',
        triggered_by: runAsUserId,
        task_prompt: taskPrompt,
        action_id: triggeringActionId,
        // Its teammate: the action's assignee, else the persona's (bots-v3 Phase 6),
        // else the Assistant's, on the ledger row only (agent-run-mirror.ts runTeammateId).
        ai_team_member_id: aiTeamMemberId,
        agent_recipe_id: aiTeamMemberId ? null : agentRecipeId,
      })

      // 6. Emit the exact same event the action path emits (start-agent/route.ts).
      //    From here agentRunExecute owns the run. --- DISARMED IN v1 ---
      await inngest.send({
        name: 'agent/run.requested',
        data: { agent_run_id: agentRunId, workspace_id: workspaceId },
      })

      // 7. Return the dispatch-OK result (202 Accepted, fire-and-forget).
      return {
        status: 'success',
        request_summary: {
          method: 'AGENT',
          url: summaryUrl,
          header_names: [],
          body_byte_length: new TextEncoder().encode(taskPrompt).length,
        },
        response_status_code: 202,
        response_body_preview: `Queued agent run ${agentRunId} on ${repo}`,
        error_message: null,
        duration_ms: Date.now() - startedAt,
        dispatched: true,
        agent_run_id: agentRunId,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return failed(message)
    }
  }
}
