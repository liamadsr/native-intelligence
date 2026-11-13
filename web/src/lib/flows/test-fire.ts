/**
 * Test-firing a loop: the manual Run now (POST /api/account/flows/[id]/fire)
 * and chat's test_flow (F1, docs/plans/flows-connectors.md §2.5) share the
 * synthetic entity a fire with no real one runs against.
 *
 * test_flow is a DRY run (runDryTestFire): the loop's steps run against a
 * sample (a real entity or capture of the workspace, or a synthetic one) with
 * every output kept to the caller, delivered to nobody:
 *   - run_skill runs for real (it is the thing being tested, and its usage
 *     counts like any run), as the CALLER, in report mode, with no document,
 *     no notification and no cards (trust: no auto-apply, zero cards); its run
 *     token carries `dryRun`, so even report mode's own writes
 *     (create_document, add_comment, suggest_changes) only echo what they
 *     would have written (dry-run-tools.ts); its output comes back in the result;
 *   - http_post renders its request but never sends it;
 *   - run_agent, run_local_agent and archive_capture say what they would do
 *     and do nothing (a test never starts a job on anyone's Mac).
 * No flow_run row is written: a test is not part of the loop's history.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadRunnerEntityData } from './queries'
import { runFlow, type ArchiveCaptureExecutionResult, type FireExtras, type RunAgentExecutionResult, type RunLocalAgentExecutionResult, type RunnerEntityData } from './runner'
import { createRunSkillExecutor, flowRunDeadlineMs } from './run-skill'
import { createCallToolExecutor } from './call-tool'
import type {
  ActionResult,
  FlowAction,
  FlowEntityType,
  FlowRunStatus,
  PrStatusChangedTriggerConfig,
  RunAgentActionConfig,
  RunLocalAgentActionConfig,
  RunSkillActionConfig,
  TriggerContext,
} from './types'

export const SYNTH_ID = '00000000-0000-0000-0000-000000000000'

/**
 * A synthetic entity for a test-fire with no entity_id: just enough fields to
 * render the body template; the person is verifying the shape, not the data.
 */
export function makeSyntheticEntity(
  entityType: FlowEntityType,
  workspaceId: string,
  triggerConfig: { to_status_id?: string } | null,
): RunnerEntityData {
  const statusValue = triggerConfig?.to_status_id ?? ''
  const synthId = SYNTH_ID
  switch (entityType) {
    case 'action':
      return {
        kind: 'action',
        id: synthId,
        identifier: 'TEST-0',
        title: 'Test fire from Native Intelligence',
        status_id: statusValue,
        status_name: 'Test',
        status_category: 'started',
        priority: 2,
        assignees: [],
        assignee_ids: [],
        label_ids: [],
        labels: [],
        project_id: null,
        team_id: null,
        workspace_id: workspaceId,
      }
    case 'project':
      return {
        kind: 'project',
        id: synthId,
        name: 'Test fire project',
        description: 'Synthetic project for test fire',
        status_value: statusValue || 'active',
        workspace_id: workspaceId,
      }
    case 'initiative':
      return {
        kind: 'initiative',
        id: synthId,
        name: 'Test fire initiative',
        description: 'Synthetic initiative for test fire',
        status_value: statusValue || 'planned',
        workspace_id: workspaceId,
      }
    case 'milestone':
      return {
        kind: 'milestone',
        id: synthId,
        name: 'Test fire milestone',
        description: 'Synthetic milestone for test fire',
        status_value: statusValue || 'pending',
        project_id: synthId,
        workspace_id: workspaceId,
      }
  }
}

/** The PR state a test of a pr_status_changed loop fires with: the one it waits for ('any' tests a merge). */
export function prSampleState(config: Record<string, unknown> | null | undefined): string {
  const state = (config as Partial<PrStatusChangedTriggerConfig> | null | undefined)?.to_state
  return !state || state === 'any' ? 'merged' : String(state)
}

/**
 * A test-fire's trigger context for a pr_status_changed loop: the linked
 * action as the entity, the PR state it waits for as to_status_id. Shared by
 * Run now and test_flow.
 */
export function prTestTrigger(config: Record<string, unknown> | null | undefined, firedAt: string): TriggerContext {
  return { type: 'pr_status_changed', entity_type: 'action', from_status_id: null, to_status_id: prSampleState(config), fired_at: firedAt }
}

/**
 * A test's trigger for a loop with no triggering entity (schedule, capture,
 * calendar, quote, and the owner's mail, chat and document loops): its own
 * type, with the ids its template reads naming items that aren't there (the
 * read tools say so). Shared by chat's test_flow (runDryTestFire) and the
 * editor's Test (the fire route), so both build the same fire.
 */
export function entitylessTestTrigger(triggerType: string, config: Record<string, unknown> | null | undefined, firedAt: string): TriggerContext {
  return {
    type: triggerType as TriggerContext['type'],
    entity_type: null,
    from_status_id: null,
    to_status_id: null,
    fired_at: firedAt,
    // A quote loop's test names a quote that isn't there: get_quote says so.
    ...(triggerType === 'quote_received' ? { quote_id: SYNTH_ID } : {}),
    // The event loops' tests name items that aren't there: the read tools say so.
    ...(triggerType === 'email_received' ? { email_thread_id: SYNTH_ID, email_account_id: null } : {}),
    ...(triggerType === 'chat_message'
      ? {
          chat_message_id: SYNTH_ID,
          chat_channel_id: ((config ?? {}) as { channel_id?: string | null }).channel_id ?? SYNTH_ID,
          chat_thread_root_id: null,
        }
      : {}),
    ...(triggerType === 'document_created' ? { document_id: SYNTH_ID } : {}),
  }
}

/** What to test against: a real entity (status / PR loops) or capture (capture loops) of the workspace. */
export interface TestFireSample {
  entity_id?: string
  capture_id?: string
}

/** The loop row a test reads. */
export interface TestFireFlow {
  id: string
  workspace_id: string
  trigger_type: string
  trigger_config: Record<string, unknown> | null
  actions: FlowAction[]
}

/**
 * A run_skill step as a test runs it: report mode (it changes no records),
 * nothing delivered (no document, no notification), no cards (no auto-apply,
 * zero cards). The output comes back in the result only.
 */
export function dryRunSkillAction(action: FlowAction): FlowAction {
  const c = action.config as RunSkillActionConfig
  return {
    ...action,
    config: {
      ...c,
      mode: 'report',
      deliver: { ...(c.deliver ?? {}), document: false, notification: false },
      trust: { auto_apply: false, min_confidence: 1, allow_external: false, max_cards_per_run: 0, outreach_draft_cards: false },
    } satisfies RunSkillActionConfig,
  }
}

/** An http_post step's request, rendered and returned instead of sent. */
export const dryRunFetch: typeof fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const body = typeof init?.body === 'string' ? init.body : ''
  // The body only, never the headers (a bearer token rides there).
  return new Response(`Test: not sent. It would ${init?.method ?? 'POST'} ${url} with this body:\n${body}`, { status: 200 })
}

const NOTHING = { header_names: [] as string[], body_byte_length: 0 }

export type DryTestFireResult =
  | { ok: true; status: FlowRunStatus; action_results: ActionResult[]; trigger: TriggerContext; sample: 'real' | 'synthetic' }
  | { ok: false; error: string; field?: string }

/**
 * Dry-run a loop as `userId` (see the header). `supabase` is the service
 * client the tools run on; every read is scoped to the loop's workspace.
 */
export async function runDryTestFire(args: {
  supabase: SupabaseClient
  flow: TestFireFlow
  userId: string
  sample?: TestFireSample
  appBaseUrl: string
  /** The enclosing request's budget (the chat tool route's maxDuration). */
  budgetMs?: number
  /** When the enclosing request (or, at the latest, the tool call) started. */
  startedAt?: number
}): Promise<DryTestFireResult> {
  const { supabase, flow, userId, sample } = args
  const ws = flow.workspace_id
  const cfg = flow.trigger_config ?? {}
  const firedAt = new Date().toISOString()
  const extras: FireExtras = { workspaceId: ws }
  let entity: RunnerEntityData | null = null
  let trigger: TriggerContext
  let real = false

  if (flow.trigger_type === 'entity_status_change' || flow.trigger_type === 'pr_status_changed') {
    const pr = flow.trigger_type === 'pr_status_changed'
    const entityType = (pr ? 'action' : ((cfg.entity_type as FlowEntityType | undefined) ?? 'action')) as FlowEntityType
    const toStatus = pr ? prSampleState(cfg) : String(cfg.to_status_id ?? '')
    if (sample?.entity_id) {
      entity = await loadRunnerEntityData(supabase, entityType, sample.entity_id)
      if (!entity || entity.workspace_id !== ws) {
        return { ok: false, field: 'sample.entity_id', error: `sample.entity_id: no ${entityType} with that id in this loop's workspace` }
      }
      real = true
    } else {
      entity = makeSyntheticEntity(entityType, ws, { to_status_id: toStatus })
    }
    trigger = {
      type: pr ? 'pr_status_changed' : 'entity_status_change',
      entity_type: entityType,
      from_status_id: pr ? null : ((cfg.from_status_id as string | null | undefined) ?? null),
      to_status_id: toStatus,
      fired_at: firedAt,
    }
  } else {
    trigger = entitylessTestTrigger(flow.trigger_type, flow.trigger_config, firedAt)
    if (flow.trigger_type === 'capture_processed') {
      if (sample?.capture_id) {
        const { data } = await supabase
          .from('captures')
          .select('id, title, visibility')
          .eq('id', sample.capture_id)
          .eq('workspace_id', ws)
          .maybeSingle()
        const capture = data as { id: string; title: string | null; visibility: string | null } | null
        // A private capture never fires a loop (emit-capture-processed.ts), so it can't be a sample either.
        if (!capture || capture.visibility === 'private') {
          return { ok: false, field: 'sample.capture_id', error: "sample.capture_id: no workspace-visible capture with that id in this loop's workspace" }
        }
        extras.capture = { id: capture.id, title: capture.title }
        real = true
      } else {
        extras.capture = { id: SYNTH_ID, title: 'Test fire from Native Intelligence' }
      }
    }
  }

  // The wall counts from when the request started (not from here), so the
  // skill runs finish inside the enclosing route's maxDuration.
  const deadlineMs = flowRunDeadlineMs(args.startedAt ?? Date.now(), args.budgetMs ?? 300_000)
  const runSkill = createRunSkillExecutor({
    workspaceId: ws,
    deadlineMs,
    // A test runs as the CALLER, never the loop's owner (the Run now rule).
    runAsUserId: userId,
    flowId: flow.id,
    fireId: crypto.randomUUID(),
    flowRunId: null,
    // The token's dryRun claim: the skill-run tool route runs no write at all
    // (report mode's documents, comments and suggestions included).
    dryRun: true,
  })
  // F4: a test calls no connected app and holds no card: it says what the step would do.
  const callTool = createCallToolExecutor({ workspaceId: ws, runAsUserId: userId, flowId: flow.id, flowRunId: null, dryRun: true })
  const { status, action_results } = await runFlow({ actions: flow.actions }, entity, trigger, args.appBaseUrl, {
    fetch: dryRunFetch,
    extras,
    executors: {
      run_skill: (action, ctx) => runSkill(dryRunSkillAction(action), ctx),
      call_tool: callTool,
      run_agent: async (action): Promise<RunAgentExecutionResult> => {
        const c = action.config as RunAgentActionConfig
        return {
          status: 'success',
          request_summary: { method: 'AGENT', url: `agent://${c.agent_id || 'from-action'}`, ...NOTHING },
          response_status_code: null,
          response_body_preview: `Test: not started. A coding agent would start on ${c.repo || "the triggering action's repo"}.`,
          error_message: null,
          duration_ms: 0,
          dispatched: false,
          agent_run_id: null,
        }
      },
      run_local_agent: async (action): Promise<RunLocalAgentExecutionResult> => {
        const c = action.config as RunLocalAgentActionConfig
        return {
          status: 'success',
          request_summary: { method: 'LOCAL_AGENT', url: `local-agent://${c.folder_id || 'no-folder'}`, ...NOTHING },
          response_status_code: null,
          response_body_preview: `Test: not started. A ${c.mode === 'edit' ? 'job that may edit (in a git worktree)' : 'read-only job'} would start on the owner's Mac in their shared folder.`,
          error_message: null,
          duration_ms: 0,
          dispatched: false,
          local_agent_session_id: null,
        }
      },
      archive_capture: async (): Promise<ArchiveCaptureExecutionResult> => ({
        status: 'success',
        request_summary: { method: 'ARCHIVE', url: 'capture://triggering', ...NOTHING },
        response_status_code: null,
        response_body_preview: 'Test: nothing archived. The triggering capture would be archived.',
        error_message: null,
        duration_ms: 0,
        archived_capture_id: null,
      }),
    },
  })
  return { ok: true, status, action_results, trigger, sample: real ? 'real' : 'synthetic' }
}
