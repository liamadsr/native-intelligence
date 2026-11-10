/**
 * Flow runner. Pure function that takes a flow definition + the data needed
 * to render its body, performs the outbound HTTP call, and returns a
 * structured result. No DB writes here — caller (the Inngest function or
 * the manual test-fire endpoint) is responsible for recording the flow_run
 * row.
 *
 * Why a pure function: keeps the test surface small. Mock fetch, call
 * runFlowAction(...), assert the result. No Supabase mocking needed.
 */
import { decryptCredentialOrNull } from '@/lib/crypto/credentials'
import { renderTemplate, buildTemplateContext, missingStepReference } from './template'
import { evaluateCondition } from './condition'
import { isPublicHttpUrl } from './url-guard'
import { actionStepReferences, actionTemplateFields, stepsContext, withStepOutput, type StepOutputs } from './step-data'
import type {
  ActionResult,
  ConnectorDeliverySummary,
  FlowAction,
  FlowRunStatus,
  HttpPostActionConfig,
  RequestSummary,
  TriggerContext,
} from './types'

/** Outbound request timeout. Fire-and-forget — we don't retry, we fail fast. */
const REQUEST_TIMEOUT_MS = 5000

/** Cap response body capture to keep flow_run rows small. Shared with the
 * run_skill executor's output preview (run-skill.ts). */
export const RESPONSE_BODY_PREVIEW_BYTES = 1024

export interface RunnerActionData {
  kind: 'action'
  id: string
  identifier: string | null
  title: string
  status_id: string
  status_name: string | null
  status_category: string | null
  priority: number | null
  assignees: { id: string; display_name: string | null }[]
  /** Member ids of assignees — convenience for condition evaluation. */
  assignee_ids: string[]
  /** Label ids attached to the action — for the 'label' condition field. */
  label_ids: string[]
  /** Labels (id + name) — for the {{action.labels}} template token. */
  labels: { id: string; name: string }[]
  /** Parent project id (nullable) — for the 'project' condition field. */
  project_id: string | null
  /** Owning team id (nullable) — for the 'team' condition field. */
  team_id: string | null
  workspace_id: string
}

export interface RunnerProjectData {
  kind: 'project'
  id: string
  name: string
  description: string | null
  status_value: string
  workspace_id: string
}

export interface RunnerInitiativeData {
  kind: 'initiative'
  id: string
  name: string
  description: string | null
  status_value: string
  workspace_id: string
}

export interface RunnerMilestoneData {
  kind: 'milestone'
  id: string
  name: string
  description: string | null
  status_value: string
  project_id: string
  workspace_id: string
}

export type RunnerEntityData =
  | RunnerActionData
  | RunnerProjectData
  | RunnerInitiativeData
  | RunnerMilestoneData

export interface RunResult {
  status: 'success' | 'failed'
  request_summary: RequestSummary
  response_status_code: number | null
  response_body_preview: string | null
  error_message: string | null
  duration_ms: number
  /**
   * F4 data passing: what this step leaves for the steps after it
   * (`{{steps.<id>.output}}`). Kept redacted and capped (step-data.ts), never
   * on action_results (flow_run is readable by the whole workspace).
   */
  step_output?: string
  /** F4: the step brought outside text into the run (see ActionResult.read_outside_text). */
  read_outside_text?: boolean
}

/**
 * The context every injected executor gets. `steps` (F4) holds the outputs of
 * the steps that ran before this one on this fire; `readOutsideText` is true
 * once any of them brought outside text in.
 */
export interface ExecutorContext {
  entity: RunnerEntityData | null
  trigger: TriggerContext
  appBaseUrl: string
  capture?: { id: string; title: string | null } | null
  steps?: Record<string, { output: string }>
  readOutsideText?: boolean
}

/**
 * What a call_tool executor returns (F4, call-tool.ts): the RunResult shape
 * plus the connector it called and, when the input-aware rule asked, the
 * approval the run parked on (status 'pending').
 */
export type CallToolExecutionResult = Omit<RunResult, 'status'> & {
  status: FlowRunStatus
  parked?: { approval_id: string; card_id: string; title: string } | null
  called?: { connection: string; server: string; tool: string; policy: 'read' | 'inert' | 'ask' } | null
  /** An inert write: what it did, for the run's summary and the digest. */
  delivered?: ConnectorDeliverySummary | null
}

/** Injected call_tool executor (call-tool.ts createCallToolExecutor). */
export type CallToolExecutor = (action: FlowAction, ctx: ExecutorContext) => Promise<CallToolExecutionResult>

/**
 * What a run_skill executor returns — the http RunResult shape (SKILL results
 * ride the same ActionResult/legacy-snapshot plumbing) plus the delivered
 * output document, when one was created.
 */
export type RunSkillExecutionResult = RunResult & {
  output_document_id?: string | null
  /** Verdict-class runs (Phase 2, Workstream B): the applied-verdict ledger. */
  verdict?: import('./types').VerdictLedger | null
  /** F3: what a structured output connector or a lens delivered. */
  delivered?: import('./types').ConnectorDeliverySummary | null
}

/**
 * What a run_agent executor returns — the http RunResult shape (agent-dispatch
 * results ride the same ActionResult/legacy-snapshot plumbing) plus the
 * dispatch outcome: whether an agent run was actually queued and, if so, its
 * agent_run row id (for the Cloud-run deep link). Fire-and-forget — a
 * status:'success' here means "queued OK", not "the agent finished".
 */
export type RunAgentExecutionResult = RunResult & {
  dispatched?: boolean
  agent_run_id?: string | null
}

/**
 * Injected run_skill executor. The runner stays pure (no Supabase, no LLM):
 * callers that can execute skills (Inngest dispatchers, the test-fire route)
 * inject the real executor from run-skill.ts; unit tests inject a mock; a
 * caller that injects nothing gets a failed result for run_skill actions.
 *
 * `entity` is null for workspace-scoped fires (schedule / capture_processed)
 * that have no triggering entity; `capture` carries the capture_processed
 * fire's template garnish (see FireExtras).
 */
export type RunSkillExecutor = (action: FlowAction, ctx: ExecutorContext) => Promise<RunSkillExecutionResult>

/**
 * Injected run_agent executor. Same injection contract as RunSkillExecutor: the
 * runner stays pure; callers that can dispatch agent runs (Inngest dispatchers,
 * the test-fire route) inject the real executor from run-agent.ts, unit tests
 * inject a mock, and a caller that injects nothing gets a failed result for
 * run_agent actions.
 */
export type RunAgentExecutor = (action: FlowAction, ctx: ExecutorContext) => Promise<RunAgentExecutionResult>

/**
 * What an archive_capture executor returns — the http RunResult shape plus the
 * archived capture id (when one was archived; null on a no-op skip).
 */
export type ArchiveCaptureExecutionResult = RunResult & { archived_capture_id?: string | null }

/**
 * Injected archive_capture executor. Same injection contract as the others: the
 * runner stays pure; the Inngest dispatchers inject the real executor from
 * archive-capture.ts, unit tests inject a mock, and a caller that injects
 * nothing gets a failed result. Archives the TRIGGERING capture (ctx.capture)
 * — on a fire with no capture (schedule / entity_status_change) it returns a
 * clean no-op success (nothing to archive), never a failure.
 */
export type ArchiveCaptureExecutor = (action: FlowAction, ctx: ExecutorContext) => Promise<ArchiveCaptureExecutionResult>

/**
 * What a run_local_agent executor returns (L5, run-local-agent.ts): the http
 * RunResult shape plus whether a job was started on the owner's Mac and its
 * session. Fire-and-forget: a status:'success' means "handed to the Mac" (or
 * a clean skip), not "the job finished"; the job reports on its own.
 */
export type RunLocalAgentExecutionResult = RunResult & {
  dispatched?: boolean
  local_agent_session_id?: string | null
}

/** Injected run_local_agent executor. Same injection contract as the others. */
export type RunLocalAgentExecutor = (action: FlowAction, ctx: ExecutorContext) => Promise<RunLocalAgentExecutionResult>

export interface FlowExecutors {
  run_skill?: RunSkillExecutor
  run_agent?: RunAgentExecutor
  archive_capture?: ArchiveCaptureExecutor
  call_tool?: CallToolExecutor
  run_local_agent?: RunLocalAgentExecutor
}

/**
 * F4: carrying a PARKED run on (flow-step-resume.ts). `results` are the
 * run's results so far, the parked step's own now settled (its approval was
 * accepted and the call ran); every result not marked `waiting` is kept as
 * is, and the waiting steps run now, with the outputs so far.
 */
export interface FlowResume {
  results: ActionResult[]
  stepOutputs: StepOutputs
  readOutsideText: boolean
}

/** What runFlow returns. */
export interface FlowRunOutcome {
  /** 'pending' when a step parked the run on an approval card. */
  status: FlowRunStatus
  action_results: ActionResult[]
  /** F4: every step's output so far (redacted, capped), by step id. */
  step_outputs: StepOutputs
  /** F4: some step brought outside text into this run. */
  read_outside_text: boolean
  /** F4: the step the run parked on, when it did. */
  parked: { action_id: string; approval_id: string; card_id: string; title: string } | null
}

/**
 * Fire context that isn't part of the triggering entity. Workspace-scoped
 * fires (schedule / capture_processed) pass entity: null, so nothing else
 * carries the workspace id for the `{{workspace.id}}` template token;
 * capture_processed fires additionally supply the processed capture for the
 * `{{capture.*}}` tokens (in http_post bodies and run_skill instructions /
 * document_title templates alike).
 */
export interface FireExtras {
  capture?: { id: string; title: string | null } | null
  /** Required when entity is null. */
  workspaceId?: string
}

/**
 * Run a whole flow: walk its action TREE in parent-before-child order, evaluate
 * each action's condition against the triggering entity, and fire the ones that
 * match. Disabled actions (enabled:false) are skipped — and, since a disabled
 * node logically removes its branch, its whole subtree is skipped too.
 *
 * Fan-out semantics (not a pipeline): each ENABLED action is gated only by its
 * own condition, never by a parent's success/failure — a failing action does
 * NOT abort siblings or descendants. Every action gets a recorded result. The
 * overall flow status is the worst-of the EXECUTED (non-skipped) actions:
 * 'failed' if any executed action failed, otherwise 'success' (a flow whose
 * actions were all skipped, or which has no actions, is 'success').
 *
 * `appBaseUrl` builds the `action.url` token in body templates so automations
 * can deep-link back into Native Intelligence. Pass `process.env.NEXT_PUBLIC_APP_URL` ??
 * 'https://nativeintelligence.dev'.
 *
 * `entity` is null for workspace-scoped fires (schedule / capture_processed):
 * conditions on entity fields evaluate against empty sets and the entity
 * template namespaces render empty; pass `opts.extras.workspaceId` (and
 * `.capture` for capture_processed) so those tokens still resolve.
 */
export async function runFlow(
  flow: { actions: FlowAction[] },
  entity: RunnerEntityData | null,
  trigger: TriggerContext,
  appBaseUrl: string,
  opts: { fetch?: typeof fetch; executors?: FlowExecutors; extras?: FireExtras; resume?: FlowResume } = {},
): Promise<FlowRunOutcome> {
  const fetchImpl = opts.fetch ?? fetch
  const action_results: ActionResult[] = []
  let anyExecuted = false
  let anyFailed = false
  // F4 data passing: the outputs so far, and whether outside text came in.
  let stepOutputs: StepOutputs = { ...(opts.resume?.stepOutputs ?? {}) }
  let readOutside = opts.resume?.readOutsideText === true
  let parked: FlowRunOutcome['parked'] = null
  // Steps skipped because an output they use was empty (their dependants skip too).
  const nothingToPass = new Set<string>()
  // A resumed run keeps every settled result; its waiting steps run now.
  const prior = new Map((opts.resume?.results ?? []).filter((r) => !r.waiting).map((r) => [r.action_id, r]))

  // Disabling a node removes its branch: collect the ids of every action that
  // is itself disabled or has a disabled ancestor, so we skip the whole subtree.
  const prunedIds = collectPrunedActionIds(flow.actions)
  const ctxFor = (): ExecutorContext => ({
    entity,
    trigger,
    appBaseUrl,
    capture: opts.extras?.capture ?? null,
    steps: stepsContext(stepOutputs),
    readOutsideText: readOutside,
  })
  /** Record what an executed step leaves for the steps after it. */
  const keep = (actionId: string, result: { step_output?: string; read_outside_text?: boolean }) => {
    if (typeof result.step_output === 'string') stepOutputs = withStepOutput(stepOutputs, actionId, result.step_output)
    if (result.read_outside_text === true) readOutside = true
  }

  for (const action of orderParentsBeforeChildren(flow.actions)) {
    // Resumed: a step that already settled keeps its result (and its output).
    const done = prior.get(action.id)
    if (done) {
      action_results.push(done)
      if (!done.skipped) {
        anyExecuted = true
        if (done.status === 'failed') anyFailed = true
      }
      continue
    }
    // Parked: every step after the parked one waits for the card.
    if (parked) {
      action_results.push(waitingResult(action.id))
      continue
    }
    // Disabled (or under a disabled ancestor): record as skipped, no HTTP.
    if (prunedIds.has(action.id)) {
      action_results.push({
        action_id: action.id,
        condition_met: false,
        disabled: true,
        incomplete: false,
        skipped: true,
        status: 'success',
        request_summary: null,
        response_status_code: null,
        response_body_preview: null,
        error_message: null,
        duration_ms: 0,
      })
      continue
    }

    const conditionMet = evaluateCondition(action.condition, entity, trigger)
    if (!conditionMet) {
      action_results.push({
        action_id: action.id,
        condition_met: false,
        disabled: false,
        incomplete: false,
        skipped: true,
        status: 'success',
        request_summary: null,
        response_status_code: null,
        response_body_preview: null,
        error_message: null,
        duration_ms: 0,
      })
      continue
    }

    // Enabled + condition-eligible but still a draft (no usable URL / no
    // resolvable skill_id): skip it, not an error. The rest of the flow keeps
    // firing — a half-finished action never breaks a live flow. Does NOT
    // prune children (they're independent).
    if (!isActionRunnable(action)) {
      action_results.push({
        action_id: action.id,
        condition_met: true,
        disabled: false,
        incomplete: true,
        skipped: true,
        status: 'success',
        request_summary: null,
        response_status_code: null,
        response_body_preview: null,
        error_message: null,
        duration_ms: 0,
      })
      continue
    }

    // F4: a step that uses an output with nothing in it (a lens that kept
    // nothing from this call) has nothing to do: it is skipped, and so is any
    // step that uses ITS output. Not a failure.
    const emptyRef = actionStepReferences(action).find((id) => nothingToPass.has(id) || (stepOutputs[id] !== undefined && !stepOutputs[id].output.trim()))
    if (emptyRef) {
      nothingToPass.add(action.id)
      action_results.push({
        action_id: action.id,
        condition_met: true,
        disabled: false,
        incomplete: false,
        skipped: true,
        status: 'success',
        request_summary: null,
        response_status_code: null,
        response_body_preview: `Skipped: step "${emptyRef}" passed nothing on`,
        error_message: null,
        duration_ms: 0,
      })
      continue
    }

    // F4: a step whose templates name another step's output fails loudly when
    // that step left none on this fire (it was skipped, or failed early).
    const missingRef = firstMissingStepReference(action, ctxFor(), opts.extras?.workspaceId)
    if (missingRef) {
      anyExecuted = true
      anyFailed = true
      action_results.push({
        action_id: action.id,
        condition_met: true,
        disabled: false,
        incomplete: false,
        skipped: false,
        status: 'failed',
        request_summary: null,
        response_status_code: null,
        response_body_preview: null,
        error_message: missingRef,
        duration_ms: 0,
      })
      continue
    }

    // call_tool (F4): one tool on the owner's connected app, through the
    // injected executor (call-tool.ts). It may PARK the run on an approval card.
    if (action.type === 'call_tool') {
      anyExecuted = true
      const execute = opts.executors?.call_tool
      if (!execute) {
        anyFailed = true
        action_results.push({
          action_id: action.id,
          condition_met: true,
          disabled: false,
          incomplete: false,
          skipped: false,
          status: 'failed',
          request_summary: null,
          response_status_code: null,
          response_body_preview: null,
          error_message: 'call_tool executor not available',
          duration_ms: 0,
        })
        continue
      }
      const { step_output, ...result } = await execute(action, ctxFor())
      if (result.status === 'failed') anyFailed = true
      keep(action.id, { step_output, read_outside_text: result.read_outside_text })
      if (result.status === 'pending' && result.parked) {
        parked = { action_id: action.id, ...result.parked }
      }
      action_results.push({
        action_id: action.id,
        condition_met: true,
        disabled: false,
        incomplete: false,
        skipped: false,
        ...result,
      })
      continue
    }

    // run_agent dispatches to the caller-injected executor (byte-for-byte the
    // run_skill branch, run_skill → run_agent). A caller that didn't inject one
    // (old code paths, unit tests) records a failed result rather than silently
    // skipping — the flow author sees WHY it didn't run. NOTE: the injected
    // executor may itself return dispatched:false with status:'success' when the
    // RUN_AGENT_DISPATCH_ENABLED flag is off (v1's inert path) — that is NOT a
    // failure, it's the deliberately-disarmed state.
    if (action.type === 'run_agent') {
      anyExecuted = true
      const execute = opts.executors?.run_agent
      if (!execute) {
        anyFailed = true
        action_results.push({
          action_id: action.id,
          condition_met: true,
          disabled: false,
          incomplete: false,
          skipped: false,
          status: 'failed',
          request_summary: null,
          response_status_code: null,
          response_body_preview: null,
          error_message: 'run_agent executor not available',
          duration_ms: 0,
        })
        continue
      }
      const result = await execute(action, ctxFor())
      if (result.status === 'failed') anyFailed = true
      action_results.push({
        action_id: action.id,
        condition_met: true,
        disabled: false,
        incomplete: false,
        skipped: false,
        ...result,
      })
      continue
    }

    // run_local_agent (L5) starts a job on the owner's Mac through the
    // injected executor (run-local-agent.ts), fire-and-forget like run_agent.
    // A caller that didn't inject one records a failed result, never a skip.
    if (action.type === 'run_local_agent') {
      anyExecuted = true
      const execute = opts.executors?.run_local_agent
      if (!execute) {
        anyFailed = true
        action_results.push({
          action_id: action.id,
          condition_met: true,
          disabled: false,
          incomplete: false,
          skipped: false,
          status: 'failed',
          request_summary: null,
          response_status_code: null,
          response_body_preview: null,
          error_message: 'run_local_agent executor not available',
          duration_ms: 0,
        })
        continue
      }
      const result = await execute(action, ctxFor())
      if (result.status === 'failed') anyFailed = true
      action_results.push({
        action_id: action.id,
        condition_met: true,
        disabled: false,
        incomplete: false,
        skipped: false,
        ...result,
      })
      continue
    }

    // run_skill dispatches to the caller-injected executor. A caller that
    // didn't inject one (old code paths, unit tests) records a failed result
    // rather than silently skipping — the flow author sees WHY it didn't run.
    if (action.type === 'run_skill') {
      anyExecuted = true
      const execute = opts.executors?.run_skill
      if (!execute) {
        anyFailed = true
        action_results.push({
          action_id: action.id,
          condition_met: true,
          disabled: false,
          incomplete: false,
          skipped: false,
          status: 'failed',
          request_summary: null,
          response_status_code: null,
          response_body_preview: null,
          error_message: 'run_skill executor not available',
          duration_ms: 0,
        })
        continue
      }
      const { step_output, ...result } = await execute(action, ctxFor())
      if (result.status === 'failed') anyFailed = true
      keep(action.id, { step_output, read_outside_text: result.read_outside_text })
      action_results.push({
        action_id: action.id,
        condition_met: true,
        disabled: false,
        incomplete: false,
        skipped: false,
        ...result,
      })
      continue
    }

    // archive_capture archives the TRIGGERING capture via the injected
    // executor. Same injection contract as run_skill/run_agent. On a fire with
    // no capture (schedule / entity_status_change), the executor returns a
    // no-op success — nothing to archive is not a failure.
    if (action.type === 'archive_capture') {
      anyExecuted = true
      const execute = opts.executors?.archive_capture
      if (!execute) {
        anyFailed = true
        action_results.push({
          action_id: action.id,
          condition_met: true,
          disabled: false,
          incomplete: false,
          skipped: false,
          status: 'failed',
          request_summary: null,
          response_status_code: null,
          response_body_preview: null,
          error_message: 'archive_capture executor not available',
          duration_ms: 0,
        })
        continue
      }
      const result = await execute(action, ctxFor())
      if (result.status === 'failed') anyFailed = true
      action_results.push({
        action_id: action.id,
        condition_met: true,
        disabled: false,
        incomplete: false,
        skipped: false,
        ...result,
      })
      continue
    }

    if (action.type !== 'http_post') {
      anyExecuted = true
      anyFailed = true
      action_results.push({
        action_id: action.id,
        condition_met: true,
        disabled: false,
        incomplete: false,
        skipped: false,
        status: 'failed',
        request_summary: null,
        response_status_code: null,
        response_body_preview: null,
        error_message: `Unsupported action type: ${action.type}`,
        duration_ms: 0,
      })
      continue
    }

    anyExecuted = true
    const { step_output, ...result } = await executeHttpPostAction(
      action,
      entity,
      trigger,
      appBaseUrl,
      fetchImpl,
      opts.extras,
      stepsContext(stepOutputs),
    )
    if (result.status === 'failed') anyFailed = true
    keep(action.id, { step_output, read_outside_text: result.read_outside_text })
    action_results.push({
      action_id: action.id,
      condition_met: true,
      disabled: false,
      incomplete: false,
      skipped: false,
      ...result,
    })
  }

  return {
    status: parked ? 'pending' : anyExecuted ? (anyFailed ? 'failed' : 'success') : 'success',
    action_results,
    step_outputs: stepOutputs,
    read_outside_text: readOutside,
    parked,
  }
}

/** A step that did not run because the run parked before it (F4). */
export function waitingResult(actionId: string): ActionResult {
  return {
    action_id: actionId,
    condition_met: true,
    disabled: false,
    incomplete: false,
    skipped: true,
    waiting: true,
    status: 'pending',
    request_summary: null,
    response_status_code: null,
    response_body_preview: 'Waiting: the run is parked on an approval card before this step',
    error_message: null,
    duration_ms: 0,
  }
}

/** The first `{{steps.…}}` reference in a step's templates this fire has no output for (its error line), or null. */
function firstMissingStepReference(action: FlowAction, ctx: ExecutorContext, workspaceId: string | undefined): string | null {
  const templateCtx = buildTemplateContext(ctx.entity, ctx.trigger, ctx.appBaseUrl, {
    capture: ctx.capture ?? null,
    workspaceId,
    steps: ctx.steps ?? {},
  })
  // call_tool renders strictly in its own executor (every reference, not only steps).
  if (action.type === 'call_tool') return null
  for (const field of actionTemplateFields(action)) {
    if (typeof field !== 'string') continue
    const miss = missingStepReference(field, templateCtx)
    if (miss) return miss.error
  }
  return null
}

/** Matches the save-time validator's uuid check (queries.ts). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Is this action complete enough to actually run? Per type:
 *   - http_post:  its config has a public http(s) URL (same predicate the
 *     save-time validator uses). No URL, malformed URL, or a private/internal
 *     host = incomplete DRAFT — and a draft can never fire to an internal host
 *     even though its config was stored verbatim without strict validation.
 *   - run_skill:  its skill_id is a uuid (a non-uuid skill_id is the draft
 *     shape sanitizeDraftRunSkillConfig stores). Skill EXISTENCE is the
 *     executor's problem — it re-checks against the workspace and records a
 *     failed result if the skill was deleted after save.
 * A non-runnable action is skipped at fire time rather than erroring the
 * flow — a user can save a half-built action and finish it later.
 */
function isActionRunnable(action: { type?: string; config?: unknown }): boolean {
  if (action.type === 'run_skill') {
    const skillId = (action.config as { skill_id?: unknown } | undefined)?.skill_id
    return typeof skillId === 'string' && UUID_RE.test(skillId)
  }
  if (action.type === 'run_agent') {
    // Runnable iff it has a picked agent (uuid) + a repo, OR it inherits both
    // from the triggering action (use_triggering_action_context). A schedule
    // flow with the flag on but no action is a draft the runner skips — but
    // whether an action exists is only known at fire time, so at this static
    // check the flag alone makes it runnable and the executor validates the
    // rest (no repo / no agent resolvable → clean failed result, never a throw).
    const cfg = action.config as
      | { agent_id?: unknown; repo?: unknown; use_triggering_action_context?: unknown }
      | undefined
    if (cfg?.use_triggering_action_context === true) return true
    const agentOk = typeof cfg?.agent_id === 'string' && UUID_RE.test(cfg.agent_id)
    const repoOk = typeof cfg?.repo === 'string' && cfg.repo.trim().length > 0
    return agentOk && repoOk
  }
  if (action.type === 'archive_capture') {
    // No config to complete — always runnable. Whether there IS a capture to
    // archive is only known at fire time; the executor no-ops cleanly when the
    // fire carries none.
    return true
  }
  if (action.type === 'run_local_agent') {
    // A folder and a request (the save-time shape). Whether the folder is
    // still the owner's and shared is the executor's check (a clean failure).
    const cfg = action.config as { folder_id?: unknown; request?: unknown } | undefined
    return typeof cfg?.folder_id === 'string' && UUID_RE.test(cfg.folder_id) && typeof cfg?.request === 'string' && cfg.request.trim().length > 0
  }
  if (action.type === 'call_tool') {
    // A connection and a tool (the save-time shape). Whether they are still
    // the owner's and visible is the executor's check (a clean failure).
    const cfg = action.config as { connection?: unknown; tool?: unknown } | undefined
    return typeof cfg?.connection === 'string' && UUID_RE.test(cfg.connection) && typeof cfg?.tool === 'string' && cfg.tool.length > 0
  }
  return isPublicHttpUrl((action.config as { url?: unknown } | undefined)?.url)
}

/**
 * Return action ids that should be skipped because they are disabled or have a
 * disabled ancestor. Treats `enabled === false` as disabled (undefined = on).
 * Cycles/dangling parents can't loop here — we resolve each id's chain with a
 * visited guard.
 */
function collectPrunedActionIds(actions: FlowAction[]): Set<string> {
  const byId = new Map(actions.map((a) => [a.id, a]))
  const pruned = new Set<string>()
  for (const a of actions) {
    let cur: FlowAction | undefined = a
    const seen = new Set<string>()
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id)
      if (cur.enabled === false) {
        pruned.add(a.id)
        break
      }
      cur = cur.parent_id ? byId.get(cur.parent_id) : undefined
    }
  }
  return pruned
}

/**
 * Stable parent-before-child ordering of the action tree. A node appears after
 * its parent (roots — parent_id null or dangling — come first, in their
 * original array order). Defensive against cycles: any node not reached from a
 * root is appended at the end so it still runs.
 */
function orderParentsBeforeChildren(actions: FlowAction[]): FlowAction[] {
  const ids = new Set(actions.map((a) => a.id))
  const childrenOf = new Map<string | null, FlowAction[]>()
  for (const a of actions) {
    // A parent_id that doesn't resolve to a known action is treated as a root.
    const key = a.parent_id && ids.has(a.parent_id) ? a.parent_id : null
    const list = childrenOf.get(key) ?? []
    list.push(a)
    childrenOf.set(key, list)
  }
  const ordered: FlowAction[] = []
  const visited = new Set<string>()
  const walk = (parentKey: string | null) => {
    for (const a of childrenOf.get(parentKey) ?? []) {
      if (visited.has(a.id)) continue
      visited.add(a.id)
      ordered.push(a)
      walk(a.id)
    }
  }
  walk(null)
  // Append any node unreachable from a root (cycle) so it isn't silently dropped.
  for (const a of actions) if (!visited.has(a.id)) ordered.push(a)
  return ordered
}

/**
 * Execute a single http_post action against a real fetch implementation.
 * Returns the serializable HTTP outcome (the per-action subset of a
 * flow_run). Decrypts the action's own bearer token.
 */
async function executeHttpPostAction(
  action: FlowAction,
  entity: RunnerEntityData | null,
  trigger: TriggerContext,
  appBaseUrl: string,
  fetchImpl: typeof fetch = fetch,
  extras?: FireExtras,
  steps?: Record<string, { output: string }>,
): Promise<RunResult> {
  const startedAt = Date.now()
  const config = action.config as HttpPostActionConfig

  // Render the body template against the entity data (plus the workspace /
  // capture extras for entity-less fires, and F4's earlier step outputs).
  const ctx = buildTemplateContext(entity, trigger, appBaseUrl, {
    capture: extras?.capture ?? null,
    workspaceId: extras?.workspaceId,
    steps: steps ?? {},
  })
  const body = renderTemplate(config.body_template, ctx, { jsonAware: true })

  // Build headers. Start with user-supplied, layer Authorization on top if
  // a bearer token is configured. Always include Content-Type if the user
  // didn't override.
  const headers: Record<string, string> = { ...(config.headers || {}) }
  const hasContentType = Object.keys(headers).some(
    (k) => k.toLowerCase() === 'content-type',
  )
  if (!hasContentType) {
    headers['Content-Type'] = 'application/json'
  }
  const token = decryptCredentialOrNull(action.bearer_token_encrypted)
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const request_summary: RequestSummary = {
    method: config.method,
    url: config.url,
    header_names: Object.keys(headers),
    body_byte_length: new TextEncoder().encode(body).length,
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetchImpl(config.url, {
      method: config.method,
      headers,
      body,
      signal: controller.signal,
      // Never follow a redirect: the URL guard only vetted this host, and a
      // public host could 302 to an internal one.
      redirect: 'manual',
    })
    clearTimeout(timeout)

    // Read at most RESPONSE_BODY_PREVIEW_BYTES so we don't blow up the DB
    // row on a server that returns megabytes.
    const responseText = await readBoundedText(
      response,
      RESPONSE_BODY_PREVIEW_BYTES,
    )

    const success = response.ok
    return {
      status: success ? 'success' : 'failed',
      request_summary,
      response_status_code: response.status,
      response_body_preview: responseText,
      error_message: success ? null : `HTTP ${response.status}`,
      duration_ms: Date.now() - startedAt,
      // F4: the response is the next step's input, and outside text.
      step_output: responseText,
      ...(responseText ? { read_outside_text: true } : {}),
    }
  } catch (err) {
    clearTimeout(timeout)
    const message = err instanceof Error ? err.message : String(err)
    return {
      status: 'failed',
      request_summary,
      response_status_code: null,
      response_body_preview: null,
      error_message:
        controller.signal.aborted && !message.toLowerCase().includes('abort')
          ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : message,
      duration_ms: Date.now() - startedAt,
    }
  }
}

/**
 * Read a Response body up to `maxBytes`. Stops reading once the cap is
 * reached, which means we don't pay to download a giant payload that we'd
 * just truncate anyway.
 */
async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let collected = ''
  let bytes = 0
  try {
    while (bytes < maxBytes) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      collected += decoder.decode(value, { stream: true })
      if (bytes >= maxBytes) {
        collected = collected.slice(0, maxBytes)
        // Best-effort cancel — don't await; we have what we need.
        reader.cancel().catch(() => {})
        break
      }
    }
    collected += decoder.decode()
  } catch {
    // Stream errored mid-read; return what we have.
  }
  return collected
}
