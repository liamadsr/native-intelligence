/**
 * Inngest function for dispatching flows when an entity's status changes.
 *
 * The PATCH route for each supported entity emits `flow/entity.status_changed`
 * (v1: actions only; v1.1: + projects/initiatives/milestones). This
 * function picks it up, finds matching flows for that entity type, runs
 * each flow's outbound action, and writes a flow_run row per attempt.
 *
 * Why Inngest (not setImmediate / fire-and-forget in the route): we want
 * each flow run to be observable, retryable in v2, and not block the API
 * response. Inngest gives us a durable queue without standing up a worker.
 */
import type { GetStepTools } from 'inngest'
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import {
  findMatchingFlowsForCaptureProcessed,
  findMatchingFlowsForChatMessage,
  findMatchingFlowsForDocumentCreated,
  findMatchingFlowsForEmailReceived,
  findMatchingFlowsForPrStatusChange,
  findMatchingFlowsForQuoteReceived,
  isEmailAddress,
  findMatchingFlowsForStatusChange,
  loadFlowForDispatch,
  loadRunnerEntityData,
} from '@/lib/flows/queries'
import { runFlow } from '@/lib/flows/runner'
import { createRunSkillExecutor, flowRunDeadlineMs } from '@/lib/flows/run-skill'
import { createRunAgentExecutor } from '@/lib/flows/run-agent'
import { createRunLocalAgentExecutor } from '@/lib/flows/run-local-agent'
import { createArchiveCaptureExecutor } from '@/lib/flows/archive-capture'
import { createCallToolExecutor } from '@/lib/flows/call-tool'
import { FLOW_STEP_SETTLED_EVENT, keepRunState, resumeParkedRun, type FlowStepOutcome } from '@/lib/flows/flow-step-resume'
import { fireRunId, legacySnapshotFromResults } from '@/lib/flows/run-record'
import { EMPTY_LENS_PLAN, mayHaveLensFlows, planLensRides } from '@/lib/flows/lens-plan'
import { lensResultsFrom, recordLensRides, recordLensSkip } from '@/lib/flows/lens-runs'
import { runLensChildren } from '@/lib/flows/lens-children'
import type { LensRideResult } from '@/lib/flows/types'
import { resolveRunAsMemberId } from '@/lib/flows/run-as-member'
import { inertWork, startWork, type WorkHandle } from '@/lib/work/recorder'
import { settleFlowWork } from '@/lib/work/flow-results'
import { WORK_KINDS, type WorkSource, type WorkStatus } from '@/lib/work/types'
import { flowAttribution } from '@/lib/work/system-teammates'
import type {
  ActionResult,
  EntityStatusChangeTriggerConfig,
  FlowAction,
  FlowEntityType,
  FlowWithSecrets,
  StatusChangeOrigin,
  TriggerContext,
} from '@/lib/flows/types'
import {
  EVENT_CAP_SKIP_REASON,
  chatFlowsToFire,
  chatMessageSkipReason,
  documentFlowsToFire,
  documentSkipReason,
  eventFireCapState,
  loadChatMessageFacts,
  loadDocumentFacts,
} from '@/lib/flows/event-triggers'
import { USER_STATUS_CHANGE_ORIGIN } from '@/lib/flows/emit-status-change'
import { decideReconcileSkip } from '@/lib/flows/reconcile-decision'
import { AGENT_PAUSED_REASON, checkAgentPaused } from '@/lib/work/agent-paused'
import { DEFAULT_APP_URL } from '@/lib/app-url'
import { isOnceFire } from '@/lib/flows/schedule'

const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.VERCEL_URL ??
  DEFAULT_APP_URL

/**
 * Cost posture (NORTH-STAR §"loops are free until there's something to do"): a
 * scheduled loop enabled in a workspace that then goes dormant would otherwise
 * burn one LLM run per fire forever. Before running a schedule/calendar fire we
 * gate on recent workspace ACTIVITY — a capture created (captures.created_at) OR
 * an action edited (actions.updated_at) — inside this window. Dormant → the fire
 * is ledgered as a skip and spends nothing; the first new capture re-activates
 * the loop naturally on the next fire (the gate is evaluated fresh each time —
 * no cached dormancy state, no table, no column).
 *
 * Capture-triggered and status-change dispatchers are activity-driven BY
 * CONSTRUCTION (no capture / no status change → no fire), so they never get this
 * gate — only flowDispatchOnSchedule does.
 */
export const DORMANCY_WINDOW_DAYS = 14

/**
 * The skip's preview line — surfaced on both the flow_run's legacy snapshot and
 * each skipped action row so the ledgered fire reads as an intentional, zero-cost
 * skip in flow-run-history's expanded view (NORTH-STAR invariant 4: absence is
 * always visible).
 */
const DORMANT_SKIP_PREVIEW = `workspace inactive for ${DORMANCY_WINDOW_DAYS}d — skipped (no cost)`

/**
 * True iff nobody has done anything in the workspace in the last
 * DORMANCY_WINDOW_DAYS: NO capture created, NO action edited, NO chat message
 * typed (a `user` row in chat_messages: the person's own turns, in any chat),
 * and NO draft the person reviewed or sent (an email_draft that left
 * pending_review: approved, edited, sending, sent or dismissed, touched in the
 * window). The last two are the person's own activity, so a mail-only
 * workspace (no meetings, no actions) that someone works in is not dormant,
 * and its arrival drafts keep coming. Sign-in itself is not a signal here: it
 * lives in auth.users, behind the admin API, and a person who signs in and
 * does anything chats or reviews a draft.
 *
 * Four cheap head-count existence probes (limit 1, no rows returned)
 * short-circuit on the first hit, cheapest and likeliest first: a live
 * workspace usually satisfies the capture check and never runs the rest.
 * Fail-OPEN on a query error — a transient read failure must never silently
 * starve a real loop of its fire (we'd rather spend one run than drop a
 * scheduled deliverable).
 */
export async function workspaceIsDormant(
  supabase: ReturnType<typeof getServiceClient>,
  workspaceId: string,
): Promise<boolean> {
  const sinceIso = new Date(Date.now() - DORMANCY_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const { count: captureCount, error: captureErr } = await supabase
    .from('captures')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('created_at', sinceIso)
    .limit(1)
  if (captureErr) return false // fail-open: never skip a fire on a read error
  if ((captureCount ?? 0) > 0) return false

  const { count: actionCount, error: actionErr } = await supabase
    .from('actions')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('updated_at', sinceIso)
    .limit(1)
  if (actionErr) return false // fail-open
  if ((actionCount ?? 0) > 0) return false

  // The person's own chat turns (a bot relay's 'user' row is the main agent
  // writing to a bot, never the person: left out).
  const { count: chatCount, error: chatErr } = await supabase
    .from('chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('role', 'user')
    .is('ui_message->metadata->relay', null)
    .gte('created_at', sinceIso)
    .limit(1)
  if (chatErr) return false // fail-open
  if ((chatCount ?? 0) > 0) return false

  // A draft the person reviewed or sent.
  const { count: draftCount, error: draftErr } = await supabase
    .from('email_draft')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .in('status', ['approved', 'edited', 'sending', 'sent', 'dismissed'])
    .gte('updated_at', sinceIso)
    .limit(1)
  if (draftErr) return false // fail-open
  if ((draftCount ?? 0) > 0) return false

  // A draft the person sent or dismissed: those rows are deleted now (the
  // holding pattern, src/lib/email/hold.ts), so a service-only row keeps when
  // (mail_review_activity, migration 343).
  const { count: reviewCount, error: reviewErr } = await supabase
    .from('mail_review_activity')
    .select('user_id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .gte('last_review_at', sinceIso)
    .limit(1)
  if (reviewErr) return false // fail-open (before 343 the table is missing)
  return (reviewCount ?? 0) === 0
}

/**
 * Ledger a dormancy-gated fire as a SKIP: one flow_run row, every one of the
 * flow's actions marked skipped:true (status 'success' — the flow_run_status
 * enum has no 'skipped' value; this is the WS-4e shape, where a no-op reads as a
 * skip, never a green success run). The dormancy reason rides each action's
 * response_body_preview AND the top-level snapshot, so flow-run-history renders a
 * CircleSlash row that expands to the "no cost" reason. No LLM call, no executor,
 * no notification — the ledger row is the whole cost.
 */
export function dormantSkipActionResults(actions: FlowAction[]): ActionResult[] {
  return skippedActionResults(actions, DORMANT_SKIP_PREVIEW)
}

/** Every action of a fire marked skipped:true with `preview` as its reason —
 *  the WS-4e shape a no-op fire is ledgered in (never a green success run). */
export function skippedActionResults(actions: FlowAction[], preview: string): ActionResult[] {
  return actions.map((action) => ({
    action_id: action.id,
    condition_met: false,
    disabled: false,
    incomplete: false,
    skipped: true,
    status: 'success',
    request_summary: null,
    response_status_code: null,
    response_body_preview: preview,
    error_message: null,
    duration_ms: 0,
  }))
}

// ── Loop guard on status-change fires (precondition A3) ──────────────────────
//
// Any agent that can call update_action (an act-mode skill run, a work run)
// emits `flow/entity.status_changed`, which can start more flows, which can run
// more agents. Nothing stopped that chain. Two structural guards, both read
// from the ORIGIN the emitter stamps on the event (flows/types.ts
// StatusChangeOrigin):
//   1. actor gate — a change made by an AGENT's tool call does not fire a flow
//      unless that flow opted in (`trigger_config.fire_on_agent_changes`);
//   2. depth cap — no fire at automation depth ≥ FLOW_TRIGGER_MAX_DEPTH,
//      whatever the actor. A fire at depth n dispatches its runs at depth n+1.
// A skipped fire is still a ledger row (invariant 4: absence is visible).

function readDepthCap(raw: string | undefined, fallback: number): number {
  const n = raw === undefined || raw.trim() === '' ? NaN : Number(raw)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

/**
 * Automation depth at which a status-change fire is refused. A person's write is
 * depth 0; the runs a depth-0 fire dispatches write at depth 1; a flow they
 * trigger (if it opted in) runs at depth 2, which the default cap refuses.
 * Configurable (FLOW_TRIGGER_MAX_DEPTH) so the chain can be lengthened later
 * without a code change; never below 0.
 */
export const FLOW_TRIGGER_MAX_DEPTH = readDepthCap(process.env.FLOW_TRIGGER_MAX_DEPTH, 2)

const STATUS_CHANGE_ACTORS = new Set<string>(['user', 'agent', 'loop', 'sync'])

/** Read the event's origin defensively: an event emitted before the guard
 *  shipped (no origin), or a malformed one, is a person at depth 0. */
export function normalizeStatusChangeOrigin(raw: unknown): StatusChangeOrigin {
  if (!raw || typeof raw !== 'object') return USER_STATUS_CHANGE_ORIGIN
  const r = raw as Record<string, unknown>
  const actor = typeof r.actor === 'string' && STATUS_CHANGE_ACTORS.has(r.actor) ? r.actor : 'user'
  const depth = typeof r.depth === 'number' && Number.isInteger(r.depth) && r.depth >= 0 ? r.depth : 0
  const run_id = typeof r.run_id === 'string' ? r.run_id : null
  return { actor: actor as StatusChangeOrigin['actor'], depth, run_id }
}

/**
 * Why a status-change fire must NOT run this flow, or null to run it. Pure —
 * the dispatcher ledgers the reason as a skipped fire.
 */
export function statusChangeSkipReason(
  flow: { trigger_config?: unknown },
  origin: StatusChangeOrigin,
  maxDepth: number = FLOW_TRIGGER_MAX_DEPTH,
): string | null {
  if (origin.depth >= maxDepth) {
    return `automation depth ${origin.depth} reached the cap (${maxDepth}) — skipped (loop guard)`
  }
  if (origin.actor === 'agent') {
    const cfg = (flow.trigger_config ?? null) as EntityStatusChangeTriggerConfig | null
    if (cfg?.fire_on_agent_changes !== true) {
      return 'changed by an agent — this flow does not fire on agent changes (loop guard)'
    }
  }
  return null
}

/**
 * Ledger a loop-guarded fire as a SKIP: one flow_run row with every action
 * skipped (the dormancy shape), plus the fire's work-ledger row as skipped. Best
 * effort — a skip that cannot be ledgered is still a skip here (unlike the
 * dormancy gate, running is the unsafe choice).
 */
async function ledgerSkippedStatusFire(
  supabase: ReturnType<typeof getServiceClient>,
  args: {
    workspaceId: string
    flow: { id: string; name: string; created_by: string | null; actions: FlowAction[] }
    fireId: string | null
    entityType: FlowEntityType
    entityId: string
    reason: string
  },
): Promise<void> {
  const action_results = skippedActionResults(args.flow.actions, args.reason)
  const skippedRunId = crypto.randomUUID()
  try {
    await supabase.from('flow_run').insert({
      id: skippedRunId,
      flow_id: args.flow.id,
      triggered_by_action_id: args.entityType === 'action' ? args.entityId : null,
      status: 'success',
      action_results,
      ...legacySnapshotFromResults(action_results),
      response_body_preview: args.reason,
    })
  } catch {
    /* best-effort ledger */
  }
  await startFlowWork(supabase, {
    workspaceId: args.workspaceId,
    flow: args.flow,
    fireId: args.fireId,
    source: { entity_type: args.entityType, entity_id: args.entityId },
    status: 'skipped',
    skipReason: args.reason,
    flowRunId: skippedRunId,
  })
}

/** While paused, at most one skip row per flow per this window (status-change bursts). */
export const PAUSED_SKIP_LEDGER_WINDOW_MS = 60 * 60 * 1000

/**
 * Whether this flow already has a paused skip in the window. Fails open
 * (ledger again) on a failed read: one extra row beats an invisible skip.
 */
async function pausedSkipRecentlyLedgered(
  supabase: ReturnType<typeof getServiceClient>,
  flowId: string,
  now: number,
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('flow_run')
      .select('id')
      .eq('flow_id', flowId)
      .eq('response_body_preview', AGENT_PAUSED_REASON)
      .gte('fired_at', new Date(now - PAUSED_SKIP_LEDGER_WINDOW_MS).toISOString())
      .limit(1)
    return !error && Array.isArray(data) && data.length > 0
  } catch {
    return false
  }
}

/**
 * The kill switch's skip (A5 slice 5, src/lib/work/agent-paused.ts): with the
 * workspace's autonomy off, a fire runs nothing and is ledgered as a skip with
 * the reason (invariant 4: absence is visible). Every paused fire lands here,
 * scheduled ones included (the scheduler emits them as usual). To keep a burst
 * of status changes from flooding the activity feed, a flow gets at most one
 * skip row (flow_run + work ledger) per PAUSED_SKIP_LEDGER_WINDOW_MS while
 * paused; the fires in between are skipped quietly, the visible row already
 * says why. The flow_run insert is best-effort, like the status-change skip's.
 */
export async function ledgerPausedFires(
  supabase: ReturnType<typeof getServiceClient>,
  args: {
    workspaceId: string
    flows: Array<{ id: string; name: string; created_by: string | null; actions: FlowAction[] }>
    fireId: string | null
    source: WorkSource
    triggeredByActionId?: string | null
  },
): Promise<void> {
  const now = Date.now()
  for (const flow of args.flows) {
    if (await pausedSkipRecentlyLedgered(supabase, flow.id, now)) continue
    const action_results = skippedActionResults(flow.actions, AGENT_PAUSED_REASON)
    const flowRunId = crypto.randomUUID()
    try {
      await insertFlowRunOnce(supabase, {
        id: flowRunId,
        flow_id: flow.id,
        triggered_by_action_id: args.triggeredByActionId ?? null,
        status: 'success',
        action_results,
        ...legacySnapshotFromResults(action_results),
        response_body_preview: AGENT_PAUSED_REASON,
      })
    } catch {
      /* best-effort ledger */
    }
    await startFlowWork(supabase, {
      workspaceId: args.workspaceId,
      flow,
      fireId: args.fireId,
      source: args.source,
      status: 'skipped',
      skipReason: AGENT_PAUSED_REASON,
      flowRunId,
    })
  }
}

/**
 * The fire's ledger row (ACTIVITY-AND-REVIEW-DESIGN §5): created BEFORE the run
 * so the loop is visible from the moment it starts (NORTH-STAR invariant 3),
 * owned by the run-as member, keyed on the stable per-fire id so an Inngest
 * retry continues the same row. No owner resolvable → an inert handle: the run
 * still happens, it just leaves no ledger row (never the other way round).
 */
async function startFlowWork(
  supabase: ReturnType<typeof getServiceClient>,
  args: {
    workspaceId: string
    flow: {
      id: string
      name: string
      created_by: string | null
      seed_key?: string | null
      ai_team_member_id?: string | null
      actions?: FlowAction[]
    }
    fireId: string | null
    source: WorkSource
    /** Defaults to 'running'; the dormancy gate records a 'skipped' row in one write. */
    status?: WorkStatus
    skipReason?: string | null
    flowRunId?: string | null
  },
): Promise<WorkHandle> {
  const memberId = await resolveRunAsMemberId(supabase, args.workspaceId, args.flow.created_by)
  if (!memberId) {
    return inertWork({ kind: WORK_KINDS.flowRun, workspaceId: args.workspaceId, memberId: '' })
  }
  // Who fronts the run, and its area (bots-v3 Phase 3, one-agent S3;
  // system-teammates.ts flowAttribution): a seeded loop's system teammate
  // (Captures), else the loop's own bot (flow.ai_team_member_id) while the
  // run-as member can reach it, else Captures for a verdict-class skill, else
  // the work with no teammate's order. The area is the seeded loop's, or its
  // skills' when they agree. The handle carries both to the cards and the
  // digest the run leaves, so they come through its bot. Fail-soft:
  // attribution never blocks a run.
  const { teammateId: aiTeamMemberId, area } = await flowAttribution(supabase, args.workspaceId, args.flow, memberId)
  return startWork(supabase, {
    workspaceId: args.workspaceId,
    memberId,
    aiTeamMemberId,
    area,
    kind: WORK_KINDS.flowRun,
    title: args.flow.name,
    actor: 'loop',
    status: args.status ?? 'running',
    skipReason: args.skipReason ?? null,
    runKey: args.fireId ? `${args.fireId}:${args.flow.id}` : null,
    flowRunId: args.flowRunId ?? null,
    source: { flow_id: args.flow.id, ...args.source },
  })
}

/**
 * Insert a fire's flow_run row ONCE (F4 review S3): its id derives from the
 * fire (fireRunId), so a retried step lands on the row its first attempt
 * wrote and does nothing (on conflict do nothing), then carries on. Any other
 * failure is logged.
 */
async function insertFlowRunOnce(supabase: ReturnType<typeof getServiceClient>, row: Record<string, unknown>): Promise<void> {
  const { error } = await supabase.from('flow_run').insert(row)
  // 23505: the row is already there (a retried step's first attempt wrote it): nothing to do.
  if (error && (error as { code?: string }).code !== '23505') console.warn('[flows] could not record the run:', error.message)
}

/**
 * Back-fill attention_item.source_flow_run_id (the card→run audit back-link)
 * AFTER the flow_run row exists. Cards are inserted with a null back-link during
 * the run (the flow_run row is written last — it's a real FK, so it can't be
 * referenced earlier), then patched here, keyed on the stable per-fire run_key
 * (Inngest event.id). Only fills rows still null so a retry never clobbers. No-op
 * when there's no fireId (nothing to key on). Best-effort — a failure just leaves
 * the card without its link; the card itself is unaffected.
 */
async function backfillCardRunLink(
  supabase: ReturnType<typeof getServiceClient>,
  fireId: string | null,
  flowRunId: string,
): Promise<void> {
  if (!fireId) return
  try {
    await supabase
      .from('attention_item')
      .update({ source_flow_run_id: flowRunId })
      .eq('run_key', fireId)
      .is('source_flow_run_id', null)
  } catch {
    /* best-effort — the card works without the back-link */
  }
}

export const flowDispatchOnStatusChange = inngest.createFunction(
  {
    id: 'flow-dispatch-on-entity-status-change',
    // No retries: v1 fails fast and records the failure in flow_run. v2
    // can add a retry queue with backoff.
    retries: 0,
    // Cap concurrency per-workspace so a noisy workspace can't starve
    // others. (Per-team would skip non-team-scoped entities like projects.)
    // NOTE: limit must stay <= Inngest plan's max concurrency or the
    // function fails to register at /api/inngest PUT-sync time. Free/
    // starter tiers cap at 5; raise this if/when we move to a paid tier.
    concurrency: [{ limit: 5, key: 'event.data.workspace_id' }],
    triggers: [{ event: 'flow/entity.status_changed' }],
  },
  async ({ event, step }) => {
    // This request's platform budget: every run_skill wall must fire before it
    // (flowRunDeadlineMs). Measured per request: the handler re-runs on each
    // one, replaying memoized steps, so this is when THIS request started.
    const deadlineMs = flowRunDeadlineMs(Date.now())
    const {
      entity_type,
      entity_id,
      workspace_id,
      team_id,
      from_status_id,
      to_status_id,
      fired_at,
      origin: rawOrigin,
    } = event.data as {
      entity_type: FlowEntityType
      entity_id: string
      workspace_id: string
      team_id: string | null
      from_status_id: string | null
      to_status_id: string
      actor_user_id: string
      fired_at: string
      origin?: unknown
    }
    // Who made the change (loop guard). Absent on pre-guard events → a person.
    const origin = normalizeStatusChangeOrigin(rawOrigin)

    // Service-role client: this code path runs server-side, off the
    // request, so we don't have a user session. The trigger was already
    // authorized at the API route layer.
    const supabase = getServiceClient()

    const flows = await step.run('find-matching-flows', async () =>
      findMatchingFlowsForStatusChange(supabase, {
        entityType: entity_type,
        workspaceId: workspace_id,
        teamId: team_id,
        fromStatusId: from_status_id,
        toStatusId: to_status_id,
      }),
    )

    if (flows.length === 0) return { dispatched: 0 }

    // The kill switch (A5): autonomy off runs no loop. Ledgered per flow.
    const paused = await step.run('kill-switch', () => checkAgentPaused(supabase, workspace_id, 'flow_dispatch'))
    if (paused) {
      await step.run('ledger-paused-fires', () =>
        ledgerPausedFires(supabase, {
          workspaceId: workspace_id,
          flows,
          fireId: event.id ?? null,
          source: { entity_type, entity_id },
          triggeredByActionId: entity_type === 'action' ? entity_id : null,
        }),
      )
      return { dispatched: 0, skipped: 'agent_paused' }
    }

    const entity = await step.run('load-entity', async () =>
      loadRunnerEntityData(supabase, entity_type, entity_id),
    )

    if (!entity) {
      // Entity was deleted between the trigger event and dispatch — log
      // for each flow so the user sees why their automation didn't fire.
      for (const flow of flows) {
        await supabase.from('flow_run').insert({
          flow_id: flow.id,
          // triggered_by_action_id is action-specific; non-action entities
          // don't populate it. We keep the column for back-compat with the
          // 107_flows schema but accept that project/initiative/milestone
          // runs won't have a join key here. The trigger metadata in the
          // event payload is still recorded via request_summary at run time.
          triggered_by_action_id: entity_type === 'action' ? entity_id : null,
          status: 'failed',
          action_results: [],
          error_message: 'Entity not found at dispatch time',
        })
      }
      return { dispatched: 0, error: 'entity_not_found' }
    }

    const trigger: TriggerContext = {
      type: 'entity_status_change',
      entity_type,
      from_status_id,
      to_status_id,
      fired_at,
    }

    let dispatched = 0
    let skipped = 0
    for (const flow of flows) {
      // Run each flow as its own step so Inngest tracks it independently
      // — partial successes show up cleanly in the timeline.
      const outcome = await step.run(`run-flow-${flow.id}`, async () => {
        // Loop guard (see statusChangeSkipReason): an agent's change, or a fire
        // too deep in an automation chain, is ledgered as a skip and spends
        // nothing. Inside the step so the check + ledger memoize together.
        const skipReason = statusChangeSkipReason(flow, origin)
        if (skipReason) {
          await ledgerSkippedStatusFire(supabase, {
            workspaceId: workspace_id,
            flow,
            fireId: event.id ?? null,
            entityType: entity_type,
            entityId: entity_id,
            reason: skipReason,
          })
          return 'skipped' as const
        }
        // Pre-generate the flow_run id; cards carry it (null at insert),
        // back-filled after the terminal insert — see the capture_processed
        // dispatcher.
        const flowRunId = fireRunId(event.id ?? null, flow.id)
        const work = await startFlowWork(supabase, {
          workspaceId: workspace_id,
          flow,
          fireId: event.id ?? null,
          source: { entity_type, entity_id },
        })
        const ran = await runFlow(
          { actions: flow.actions },
          entity,
          trigger,
          APP_BASE_URL,
          {
            executors: {
              run_skill: createRunSkillExecutor({
                deadlineMs,
                workspaceId: workspace_id,
                // Dispatch fires run as created_by — the PATCH route re-stamps
                // it to whoever last changed the flow's actions/trigger.
                runAsUserId: flow.created_by ?? null,
                // Provenance + a stable-per-fire id: event.id is assigned by
                // Inngest, preserved across step retries of this invocation but
                // distinct between fires (delivery dedups on it).
                flowId: flow.id,
                fireId: event.id ?? null,
                flowRunId,
                work,
                // The runs this fire dispatches write one hop deeper (loop guard).
                originDepth: origin.depth + 1,
              }),
              run_agent: createRunAgentExecutor({
                workspaceId: workspace_id,
                flowId: flow.id,
                runAsUserId: flow.created_by ?? null,
                // Stable-per-fire id for the dispatch idempotency guard (retries:1).
                fireId: event.id ?? null,
              }),
              archive_capture: createArchiveCaptureExecutor({ workspaceId: workspace_id }),
              // L5: a job on the owner's Mac (run-local-agent.ts); one per fire, keyed on its run.
              run_local_agent: createRunLocalAgentExecutor({ workspaceId: workspace_id, flowId: flow.id, runAsUserId: flow.created_by ?? null, fireKey: flowRunId }),
              // F4: a connected app's tool, as the loop's owner; may park the run on a card.
              call_tool: createCallToolExecutor({
                workspaceId: workspace_id,
                runAsUserId: flow.created_by ?? null,
                flowId: flow.id,
                flowName: flow.name,
                flowRunId,
              }),
            },
          },
        )
        const { status, action_results } = ran
        const snapshot = legacySnapshotFromResults(action_results)
        await insertFlowRunOnce(supabase, {
          id: flowRunId,
          flow_id: flow.id,
          triggered_by_action_id: entity_type === 'action' ? entity_id : null,
          status,
          action_results,
          ...snapshot,
        })
        await backfillCardRunLink(supabase, event.id ?? null, flowRunId)
        // F4: the run's step outputs, and a parked run's way back (flow-step-resume.ts).
        await keepRunState(supabase, {
          flowRunId,
          flowId: flow.id,
          workspaceId: workspace_id,
          actions: flow.actions,
          createdBy: flow.created_by ?? null,
          outcome: ran,
          context: { trigger, entity, extras: {}, fire_id: event.id ?? null, origin_depth: origin.depth + 1, run_as_user_id: flow.created_by ?? null },
        })
        // The ledger row learns its flow_run once the row exists (a real FK), then
        // settles from the same results the flow_run carries.
        await work.link({ flowRunId })
        await settleFlowWork(work, { status, actionResults: action_results, flowRunId, supabase })
        return 'dispatched' as const
      })
      if (outcome === 'skipped') skipped += 1
      else dispatched += 1
    }

    return { dispatched, skipped }
  },
)

/**
 * Dispatch one schedule-trigger flow fire. The 5-minute Vercel cron tick
 * (/api/cron/flow-schedule) owns the clock: it scans flow.next_run_at,
 * compare-and-sets it forward (the double-fire guard), and emits
 * `flow/schedule.due` per winning row. This function just runs the flow.
 *
 * retries: 1 — a schedule fire is user-visible work product (a skill report),
 * so one retry beats fail-fast; step memoization keeps the retry from
 * double-inserting flow_run rows for steps that already completed.
 *
 * Concurrency 2/workspace: run_skill executions hold an LLM call for up to
 * 120s each — same per-workspace cap as agent runs so a loop-heavy workspace
 * can't starve others (and can't blow the Inngest plan's concurrency limit).
 *
 * Time budget: the whole flow executes inside ONE step.run, and /api/inngest
 * has maxDuration = 600. A step that dies mid-flow is NOT memoized, so a
 * retry re-runs every LLM call (double billing + duplicate deliveries —
 * delivery happens inside the executor). validateActions caps enabled
 * run_skill actions at MAX_ENABLED_RUN_SKILL_ACTIONS, but a verdict wall is
 * 480s, so two runs can still need more than the budget. So every run_skill
 * wall is capped at the request's deadline (flowRunDeadlineMs), and a run that
 * cannot fit its minimum wall fails before it starts, instead of the function
 * being killed mid-run with its durable eve session still calling tools.
 */
export const flowDispatchOnSchedule = inngest.createFunction(
  {
    id: 'flow-dispatch-on-schedule',
    retries: 1,
    concurrency: [{ limit: 2, key: 'event.data.workspace_id' }],
    triggers: [{ event: 'flow/schedule.due' }],
  },
  async ({ event, step }) => {
    // This request's platform budget: every run_skill wall must fire before it
    // (flowRunDeadlineMs). Measured per request: the handler re-runs on each
    // one, replaying memoized steps, so this is when THIS request started.
    const deadlineMs = flowRunDeadlineMs(Date.now())
    const { flow_id, workspace_id, scheduled_for } = event.data as {
      flow_id: string
      workspace_id: string
      scheduled_for: string
    }

    const supabase = getServiceClient()

    const flow = await step.run('load-flow', async () =>
      loadFlowForDispatch(supabase, flow_id, workspace_id),
    )

    // Re-verify at dispatch time: the flow may have been deleted, disabled,
    // or re-pointed at a different trigger between the tick's CAS and now. Both
    // schedule and calendar_event flows are driven by the same cron clock /
    // next_run_at queue and emit `flow/schedule.due` — accept either here.
    // A once-schedule is switched off by the tick as it claims its one fire
    // (it reads as finished): that fire still runs (isOnceFire).
    if (
      !flow ||
      (flow.trigger_type !== 'schedule' && flow.trigger_type !== 'calendar_event') ||
      (!flow.enabled && !(flow.trigger_type === 'schedule' && isOnceFire(flow.trigger_config, scheduled_for)))
    ) {
      return { dispatched: 0, skipped: 'flow_not_schedulable' }
    }

    // The kill switch (A5): the scheduler already holds back a paused
    // workspace's fires; this covers one queued before the switch flipped.
    const paused = await step.run('kill-switch', () => checkAgentPaused(supabase, workspace_id, 'flow_dispatch'))
    if (paused) {
      await step.run('ledger-paused-fires', () =>
        ledgerPausedFires(supabase, {
          workspaceId: workspace_id,
          flows: [flow],
          fireId: event.id ?? null,
          source: { trigger: flow.trigger_type },
        }),
      )
      return { dispatched: 0, skipped: 'agent_paused' }
    }

    // Dormancy gate (pure-'schedule' fires ONLY). calendar_event fires are
    // activity-driven by construction — computeNextCalendarRun only queues one
    // when the desktop's calendar cache is fresh AND a real occurrence exists —
    // so gating them would starve a live calendar user's meeting-prep loop just
    // because they haven't captured/edited in 14d. A cadence loop in an inactive
    // workspace, though, must not burn an LLM run per fire forever: no capture
    // created and no action edited in DORMANCY_WINDOW_DAYS → ledger the fire as
    // a SKIP and spend nothing. First new capture re-activates the loop on the
    // next fire — evaluated fresh each time, no cached state. Its own step so
    // the check + the ledger insert are memoized together across a retry (no
    // double record).
    const dormant = await step.run('dormancy-gate', async () => {
      if (flow.trigger_type !== 'schedule') return false
      // A one-time run is something the person set for that moment: never gated.
      if ((flow.trigger_config as { cadence?: unknown } | null)?.cadence === 'once') return false
      if (!(await workspaceIsDormant(supabase, workspace_id))) return false
      const action_results = dormantSkipActionResults(flow.actions)
      const dormantRunId = crypto.randomUUID()
      const { error: ledgerErr } = await supabase.from('flow_run').insert({
        id: dormantRunId,
        flow_id: flow.id,
        // Workspace-scoped fire: no triggering action.
        triggered_by_action_id: null,
        // enum has no 'skipped'; the skip lives in action_results (WS-4e shape).
        status: 'success',
        action_results,
        ...legacySnapshotFromResults(action_results),
        // legacySnapshotFromResults nulls the preview for an all-skipped run — set
        // it explicitly so the ledgered fire reads as "inactive — no cost".
        response_body_preview: DORMANT_SKIP_PREVIEW,
      })
      // Fail-OPEN like the probes: a skip that can't be ledgered must not happen
      // (invariant 4 — absence is only allowed when it's recorded). Run instead.
      if (ledgerErr) return false
      // The skip is a ledger row too — quiet, but present (invariant 4).
      await startFlowWork(supabase, {
        workspaceId: workspace_id,
        flow,
        fireId: event.id ?? null,
        source: {},
        status: 'skipped',
        skipReason: DORMANT_SKIP_PREVIEW,
        flowRunId: dormantRunId,
      })
      return true
    })
    if (dormant) return { dispatched: 0, skipped: 'workspace_dormant' }

    const reconcileSkipped = await step.run('reconcile-decision', async () => {
      const skip = await decideReconcileSkip(supabase, flow, event.id)
      if (!skip) return false
      const action_results = skippedActionResults(flow.actions, skip.reason)
      const flowRunId = crypto.randomUUID()
      const { error } = await supabase.from('flow_run').insert({
        id: flowRunId, flow_id: flow.id, triggered_by_action_id: null,
        status: 'success', action_results, ...legacySnapshotFromResults(action_results),
        response_body_preview: skip.reason,
      })
      // No durable skip record means the ordinary run must still happen.
      if (error) return false
      await startFlowWork(supabase, {
        workspaceId: workspace_id, flow, fireId: event.id ?? null,
        source: { trigger: flow.trigger_type }, status: 'skipped',
        skipReason: skip.reason, flowRunId,
      })
      return true
    })
    if (reconcileSkipped) return { dispatched: 0, skipped: 'no_commitments_to_reconcile' }

    // Synthetic no-entity context: a clock fire (schedule or calendar) has no
    // triggering entity. Carry the flow's own trigger type through so templates
    // / logging see the true source.
    const trigger: TriggerContext = {
      type: flow.trigger_type,
      entity_type: null,
      from_status_id: null,
      to_status_id: null,
      fired_at: scheduled_for ?? new Date().toISOString(),
    }

    await step.run(`run-flow-${flow.id}`, async () => {
      // Pre-generate the flow_run id; cards carry it (null at insert), back-filled
      // after the terminal flow_run insert — see the capture_processed dispatcher.
      const flowRunId = fireRunId(event.id ?? null, flow.id)
      const work = await startFlowWork(supabase, {
        workspaceId: workspace_id,
        flow,
        fireId: event.id ?? null,
        source: { trigger: flow.trigger_type },
      })
      const ran = await runFlow(
        { actions: flow.actions },
        null,
        trigger,
        APP_BASE_URL,
        {
          executors: {
            run_skill: createRunSkillExecutor({
              deadlineMs,
              workspaceId: workspace_id,
              // Dispatch fires run as created_by — the PATCH route re-stamps
              // it to whoever last changed the flow's actions/trigger.
              runAsUserId: flow.created_by ?? null,
              // Provenance + a stable-per-fire id (event.id is preserved
              // across step retries, distinct per fire).
              flowId: flow.id,
              fireId: event.id ?? null,
              flowRunId,
              work,
            }),
            run_agent: createRunAgentExecutor({
              workspaceId: workspace_id,
              flowId: flow.id,
              runAsUserId: flow.created_by ?? null,
              // Stable-per-fire id for the dispatch idempotency guard (retries:1).
              fireId: event.id ?? null,
            }),
            archive_capture: createArchiveCaptureExecutor({ workspaceId: workspace_id }),
            // L5: a job on the owner's Mac (run-local-agent.ts); one per fire, keyed on its run.
            run_local_agent: createRunLocalAgentExecutor({ workspaceId: workspace_id, flowId: flow.id, runAsUserId: flow.created_by ?? null, fireKey: flowRunId }),
              // F4: a connected app's tool, as the loop's owner; may park the run on a card.
              call_tool: createCallToolExecutor({
                workspaceId: workspace_id,
                runAsUserId: flow.created_by ?? null,
                flowId: flow.id,
                flowName: flow.name,
                flowRunId,
              }),
          },
          extras: { workspaceId: workspace_id },
        },
      )
      const { status, action_results } = ran
      const snapshot = legacySnapshotFromResults(action_results)
      await insertFlowRunOnce(supabase, {
        id: flowRunId,
        flow_id: flow.id,
        // Workspace-scoped fire: no triggering action.
        triggered_by_action_id: null,
        status,
        action_results,
        ...snapshot,
      })
      await backfillCardRunLink(supabase, event.id ?? null, flowRunId)
        // F4: the run's step outputs, and a parked run's way back (flow-step-resume.ts).
        await keepRunState(supabase, {
          flowRunId,
          flowId: flow.id,
          workspaceId: workspace_id,
          actions: flow.actions,
          createdBy: flow.created_by ?? null,
          outcome: ran,
          context: { trigger, entity: null, extras: { workspaceId: workspace_id }, fire_id: event.id ?? null, origin_depth: 1, run_as_user_id: flow.created_by ?? null },
        })
      await work.link({ flowRunId })
      await settleFlowWork(work, { status, actionResults: action_results, flowRunId, supabase })
    })

    return { dispatched: 1 }
  },
)

/**
 * Dispatch flows when a capture's batch extraction completes. The live-agent
 * route's finalize() emits `flow/capture.processed` (via
 * emit-capture-processed.ts) after reconciling the summary, skipping demo
 * captures. Same shape as the status-change dispatcher: match flows, run
 * each as its own step, record a flow_run per attempt. Same 600s budget note
 * as flowDispatchOnSchedule: each flow runs whole inside one step.run, kept
 * inside the budget by the MAX_ENABLED_RUN_SKILL_ACTIONS cap.
 */
export const flowDispatchOnCaptureProcessed = inngest.createFunction(
  {
    id: 'flow-dispatch-on-capture-processed',
    retries: 1,
    concurrency: [{ limit: 2, key: 'event.data.workspace_id' }],
    triggers: [{ event: 'flow/capture.processed' }],
  },
  async ({ event, step }) => {
    // This request's platform budget: every run_skill wall must fire before it
    // (flowRunDeadlineMs). Measured per request: the handler re-runs on each
    // one, replaying memoized steps, so this is when THIS request started.
    const deadlineMs = flowRunDeadlineMs(Date.now())
    const { workspace_id, capture_id, processed_at, flow_eligible } = event.data as {
      workspace_id: string
      capture_id: string
      processed_at: string
      flow_eligible?: boolean
    }

    // A private capture must not fire workspace automations: the run's output
    // lands in workspace-readable tables and its capture tools would refuse to
    // read the capture anyway (docs/design-capture-visibility.md). The emitter
    // already stamps flow_eligible; re-checking the row here covers emitters
    // that predate the flag (the triage reconciler's re-fire) and a capture
    // flipped to private between emit and dispatch. Fails closed on a missing
    // row — unlike the title read below, absence here is not benign.
    if (flow_eligible === false) {
      return { dispatched: 0, skipped: 'private_capture' }
    }

    const supabase = getServiceClient()

    const visible = await step.run('check-capture-visibility', async () => {
      const { data } = await supabase
        .from('captures')
        .select('visibility')
        .eq('id', capture_id)
        .eq('workspace_id', workspace_id)
        .maybeSingle()
      return !!data && (data.visibility as string | null) !== 'private'
    })

    if (!visible) {
      console.warn(
        `[flows] capture_processed skipped for ${capture_id}: capture is private or missing`,
      )
      return { dispatched: 0, skipped: 'private_capture' }
    }

    const flows = await step.run('find-matching-flows', async () =>
      findMatchingFlowsForCaptureProcessed(supabase, workspace_id),
    )

    if (flows.length === 0) return { dispatched: 0 }

    // The kill switch (A5): autonomy off runs no loop. (The capture pass and
    // knowledge extraction are not loops and keep running.)
    const paused = await step.run('kill-switch', () => checkAgentPaused(supabase, workspace_id, 'flow_dispatch'))
    if (paused) {
      await step.run('ledger-paused-fires', () =>
        ledgerPausedFires(supabase, {
          workspaceId: workspace_id,
          flows,
          fireId: event.id ?? null,
          source: { capture_id },
        }),
      )
      return { dispatched: 0, skipped: 'agent_paused' }
    }

    // Template garnish only ({{capture.id}} / {{capture.title}}): a capture
    // deleted between the emit and dispatch doesn't stop the fire — the
    // trigger is the PROCESSING event, not the row. Title just renders empty.
    const capture = await step.run('load-capture', async () => {
      const { data } = await supabase
        .from('captures')
        .select('id, title')
        .eq('id', capture_id)
        .eq('workspace_id', workspace_id)
        .maybeSingle()
      return { id: capture_id, title: (data?.title as string | null) ?? null }
    })

    const trigger: TriggerContext = {
      type: 'capture_processed',
      entity_type: null,
      from_status_id: null,
      to_status_id: null,
      fired_at: processed_at ?? new Date().toISOString(),
    }

    // Lens flows (F3, lens-plan.ts): ONE read per call. A lens flow whose
    // condition holds rides the Triage run (its section and schema are added
    // to that one run, and its outcome is recorded on its own flow's run
    // afterwards); one whose condition doesn't hold is a skipped run; with
    // Triage off, a lens flow runs on its own. Fails soft to "no lenses".
    // With only Triage on (the default) no plan step runs at all (N1).
    const lensPlan = mayHaveLensFlows(flows)
      ? await step.run('plan-lenses', () => planLensRides(supabase, { workspaceId: workspace_id, captureId: capture_id, flows }))
      : EMPTY_LENS_PLAN
    const riding = new Set(lensPlan.rides.map((r) => r.flowId))
    const skippedLens = new Map(lensPlan.skipped.map((s) => [s.flowId, s]))
    const fallbackRide = new Map(lensPlan.fallback.map((r) => [r.flowId, r]))
    // The lens flows whose condition fails on this call: their skipped rows, in one step (N1).
    if (lensPlan.skipped.length) {
      const skips = lensPlan.skipped.map((s) => ({ ...s, actions: flows.find((f) => f.id === s.flowId)?.actions ?? [] }))
      await step.run('skip-lenses', async () => {
        for (const s of skips) await recordLensSkip(supabase, { flowId: s.flowId, actionId: s.actionId, reason: s.reason, actions: s.actions })
      })
    }
    let hostOutcome: { flowRunId: string; status: string; lenses: LensRideResult[] | null; readOutsideText?: boolean } | null = null

    let dispatched = 0
    for (const flow of flows) {
      // A riding lens flow runs no skill of its own (recorded after its host);
      // a skipped one was recorded above.
      if (riding.has(flow.id) || skippedLens.has(flow.id)) continue
      const isHost = flow.id === lensPlan.hostFlowId
      // Run each flow as its own step so Inngest tracks it independently.
      const outcome = await step.run(`run-flow-${flow.id}`, async () => {
        // Pre-generate the flow_run id so verdict cards can carry it. The card is
        // inserted with source_flow_run_id NULL inside runFlow (the flow_run row
        // doesn't exist yet — it's a real FK), then back-filled AFTER the row is
        // written, keyed on the stable fireId (run_key). This keeps the single
        // terminal flow_run insert (no double-record).
        const flowRunId = fireRunId(event.id ?? null, flow.id)
        const work = await startFlowWork(supabase, {
          workspaceId: workspace_id,
          flow,
          fireId: event.id ?? null,
          source: { capture_id },
        })
        const ran = await runFlow(
          { actions: flow.actions },
          null,
          trigger,
          APP_BASE_URL,
          {
            executors: {
              run_skill: createRunSkillExecutor({
                deadlineMs,
                workspaceId: workspace_id,
                // Dispatch fires run as created_by — the PATCH route re-stamps
                // it to whoever last changed the flow's actions/trigger.
                runAsUserId: flow.created_by ?? null,
                // Provenance + a stable-per-fire id: event.id is assigned by
                // Inngest, preserved across step retries of this invocation but
                // distinct between fires (delivery dedups on it).
                flowId: flow.id,
                fireId: event.id ?? null,
                flowRunId,
                work,
                // F3: the lenses riding this one read (the host), or this lens
                // flow's own ride when there is no host.
                ...(isHost && lensPlan.rides.length ? { lenses: lensPlan.rides, lensFacts: lensPlan.facts } : {}),
                ...(fallbackRide.has(flow.id) ? { lensRide: fallbackRide.get(flow.id), lensFacts: lensPlan.facts } : {}),
              }),
              run_agent: createRunAgentExecutor({
                workspaceId: workspace_id,
                flowId: flow.id,
                runAsUserId: flow.created_by ?? null,
                // Stable-per-fire id for the dispatch idempotency guard (retries:1).
                fireId: event.id ?? null,
              }),
              archive_capture: createArchiveCaptureExecutor({ workspaceId: workspace_id }),
              // L5: a job on the owner's Mac (run-local-agent.ts); one per fire, keyed on its run.
              run_local_agent: createRunLocalAgentExecutor({ workspaceId: workspace_id, flowId: flow.id, runAsUserId: flow.created_by ?? null, fireKey: flowRunId }),
              // F4: a connected app's tool, as the loop's owner; may park the run on a card.
              call_tool: createCallToolExecutor({
                workspaceId: workspace_id,
                runAsUserId: flow.created_by ?? null,
                flowId: flow.id,
                flowName: flow.name,
                flowRunId,
              }),
            },
            extras: { workspaceId: workspace_id, capture },
          },
        )
        const { status, action_results } = ran
        const snapshot = legacySnapshotFromResults(action_results)
        await insertFlowRunOnce(supabase, {
          id: flowRunId,
          flow_id: flow.id,
          // Workspace-scoped fire: no triggering action.
          triggered_by_action_id: null,
          status,
          action_results,
          ...snapshot,
        })
        // Back-fill the run back-link on any cards this run surfaced (keyed on the
        // stable fireId → run_key). Best-effort: the card works without it.
        await backfillCardRunLink(supabase, event.id ?? null, flowRunId)
        // F4: the run's step outputs, and a parked run's way back (flow-step-resume.ts).
        await keepRunState(supabase, {
          flowRunId,
          flowId: flow.id,
          workspaceId: workspace_id,
          actions: flow.actions,
          createdBy: flow.created_by ?? null,
          outcome: ran,
          context: { trigger, entity: null, extras: { workspaceId: workspace_id, capture }, fire_id: event.id ?? null, origin_depth: 1, run_as_user_id: flow.created_by ?? null },
        })
        await work.link({ flowRunId })
        await settleFlowWork(work, { status, actionResults: action_results, flowRunId, supabase })
        return { flowRunId, status, lenses: lensResultsFrom(action_results), readOutsideText: ran.read_outside_text }
      })
      if (isHost) hostOutcome = outcome
      dispatched += 1
    }

    // The riding lens flows' own runs: what their sections delivered on the host's read.
    if (lensPlan.rides.length) {
      const rideRuns = await step.run('record-lens-rides', () => recordLensRides(supabase, { rides: lensPlan.rides, host: hostOutcome, fireId: event.id ?? null }))
      // F4: a riding lens flow's other steps (a call_tool logging what it kept,
      // say) run once, after its row, with the lens step's output (lens-children.ts).
      for (const ride of rideRuns) {
        const flow = flows.find((f) => f.id === ride.flowId)
        if (!flow || flow.actions.length <= 1) continue
        await step.run(`lens-steps-${flow.id}`, () =>
          runLensChildren(supabase, {
            flow,
            flowRunId: ride.flowRunId,
            lensRow: ride.row,
            readOutsideText: ride.readOutsideText,
            captureId: capture_id,
            workspaceId: workspace_id,
            trigger,
            extras: { workspaceId: workspace_id, capture },
            fireId: event.id ?? null,
            appBaseUrl: APP_BASE_URL,
            executors: {
              run_skill: createRunSkillExecutor({ deadlineMs, workspaceId: workspace_id, runAsUserId: flow.created_by ?? null, flowId: flow.id, fireId: event.id ?? null, flowRunId: ride.flowRunId }),
              archive_capture: createArchiveCaptureExecutor({ workspaceId: workspace_id }),
              call_tool: createCallToolExecutor({ workspaceId: workspace_id, runAsUserId: flow.created_by ?? null, flowId: flow.id, flowName: flow.name, flowRunId: ride.flowRunId }),
              // L5: a job on the owner's Mac after the lens step, one per ride.
              run_local_agent: createRunLocalAgentExecutor({ workspaceId: workspace_id, flowId: flow.id, runAsUserId: flow.created_by ?? null, fireKey: ride.flowRunId }),
            },
          }),
        )
      }
    }

    return { dispatched, ...(lensPlan.rides.length ? { lenses_rode: lensPlan.rides.length } : {}) }
  },
)

/**
 * Dispatch pr_status_changed loops (F1, docs/plans/flows-connectors.md §2.5):
 * the GitHub webhook emits `flow/pr.status_changed` once per action a pull
 * request is linked to (emit-pr-status-change.ts) when it opens, closes,
 * merges or reopens. The workspace's enabled loops that watch that repo and
 * state fire with the linked action as their entity (so per-action conditions
 * gate them), running as their owner like every other dispatch.
 *
 * retries: 0 like the status-change dispatcher: a PR event is an event, not a
 * clock, and a failure is recorded in flow_run. Concurrency per workspace.
 */
export const flowDispatchOnPrStatusChange = inngest.createFunction(
  {
    id: 'flow-dispatch-on-pr-status-change',
    retries: 0,
    concurrency: [{ limit: 2, key: 'event.data.workspace_id' }],
    triggers: [{ event: 'flow/pr.status_changed' }],
  },
  async ({ event, step }) => {
    const deadlineMs = flowRunDeadlineMs(Date.now())
    const { workspace_id, action_id, repo_full_name, pr_number, pr_state, fired_at } = event.data as {
      workspace_id: string
      action_id: string
      repo_full_name: string
      pr_number: number
      pr_state: 'open' | 'closed' | 'merged'
      fired_at?: string
    }
    const supabase = getServiceClient()

    const flows = await step.run('find-matching-flows', async () =>
      findMatchingFlowsForPrStatusChange(supabase, {
        workspaceId: workspace_id,
        repoFullName: repo_full_name,
        prState: pr_state,
      }),
    )
    if (flows.length === 0) return { dispatched: 0 }

    // The kill switch (A5): autonomy off runs no loop. Ledgered per flow.
    const paused = await step.run('kill-switch', () => checkAgentPaused(supabase, workspace_id, 'flow_dispatch'))
    if (paused) {
      await step.run('ledger-paused-fires', () =>
        ledgerPausedFires(supabase, {
          workspaceId: workspace_id,
          flows,
          fireId: event.id ?? null,
          source: { entity_type: 'action', entity_id: action_id },
          triggeredByActionId: action_id,
        }),
      )
      return { dispatched: 0, skipped: 'agent_paused' }
    }

    // The linked action, in THIS workspace (the link row named it; a moved or
    // deleted action fires nothing).
    const entity = await step.run('load-entity', async () => {
      const data = await loadRunnerEntityData(supabase, 'action', action_id)
      return data && data.workspace_id === workspace_id ? data : null
    })
    if (!entity) return { dispatched: 0, error: 'entity_not_found' }

    const trigger: TriggerContext = {
      type: 'pr_status_changed',
      entity_type: 'action',
      from_status_id: null,
      // The PR's new state: {{trigger.to_status_id}} in a body or instructions.
      to_status_id: pr_state,
      fired_at: fired_at ?? new Date().toISOString(),
    }

    let dispatched = 0
    for (const flow of flows) {
      await step.run(`run-flow-${flow.id}`, async () => {
        const flowRunId = fireRunId(event.id ?? null, flow.id)
        const work = await startFlowWork(supabase, {
          workspaceId: workspace_id,
          flow,
          fireId: event.id ?? null,
          source: { entity_type: 'action', entity_id: action_id },
        })
        const ran = await runFlow(
          { actions: flow.actions },
          entity,
          trigger,
          APP_BASE_URL,
          {
            executors: {
              run_skill: createRunSkillExecutor({
                deadlineMs,
                workspaceId: workspace_id,
                // Dispatch fires run as the loop's owner (created_by).
                runAsUserId: flow.created_by ?? null,
                flowId: flow.id,
                fireId: event.id ?? null,
                flowRunId,
                work,
              }),
              run_agent: createRunAgentExecutor({
                workspaceId: workspace_id,
                flowId: flow.id,
                runAsUserId: flow.created_by ?? null,
                fireId: event.id ?? null,
              }),
              archive_capture: createArchiveCaptureExecutor({ workspaceId: workspace_id }),
              // L5: a job on the owner's Mac (run-local-agent.ts); one per fire, keyed on its run.
              run_local_agent: createRunLocalAgentExecutor({ workspaceId: workspace_id, flowId: flow.id, runAsUserId: flow.created_by ?? null, fireKey: flowRunId }),
              // F4: a connected app's tool, as the loop's owner; may park the run on a card.
              call_tool: createCallToolExecutor({
                workspaceId: workspace_id,
                runAsUserId: flow.created_by ?? null,
                flowId: flow.id,
                flowName: flow.name,
                flowRunId,
              }),
            },
            extras: { workspaceId: workspace_id },
          },
        )
        const { status, action_results } = ran
        const snapshot = legacySnapshotFromResults(action_results)
        await insertFlowRunOnce(supabase, {
          id: flowRunId,
          flow_id: flow.id,
          triggered_by_action_id: action_id,
          status,
          action_results,
          ...snapshot,
        })
        await backfillCardRunLink(supabase, event.id ?? null, flowRunId)
        // F4: the run's step outputs, and a parked run's way back (flow-step-resume.ts).
        await keepRunState(supabase, {
          flowRunId,
          flowId: flow.id,
          workspaceId: workspace_id,
          actions: flow.actions,
          createdBy: flow.created_by ?? null,
          outcome: ran,
          context: { trigger, entity, extras: { workspaceId: workspace_id }, fire_id: event.id ?? null, origin_depth: 1, run_as_user_id: flow.created_by ?? null },
        })
        await work.link({ flowRunId })
        await settleFlowWork(work, { status, actionResults: action_results, flowRunId, supabase })
      })
      dispatched += 1
    }
    return { dispatched, repo_full_name, pr_number }
  },
)

/**
 * The run of an ENTITY-LESS fire (no triggering entity: a quote, a mail, a
 * chat message, a document), shared by every event dispatcher below. Under
 * the kill switch (A5: autonomy off runs nothing, ledgered per flow), then per
 * flow: the event cap when asked (`cap`, the owner-scoped event triggers:
 * event-triggers.ts eventFireCapState, the skip ledgered), the fire's work
 * ledger row, the run as the loop's owner (created_by) with every executor,
 * its flow_run row once, the cards' back-link, its kept state, and the
 * ledger's settle.
 */
type FlowStep = Pick<GetStepTools<typeof inngest>, 'run'>

export async function runEntitylessFires(
  supabase: ReturnType<typeof getServiceClient>,
  step: FlowStep,
  args: {
    fireId: string | null
    workspaceId: string
    flows: FlowWithSecrets[]
    trigger: TriggerContext
    source: WorkSource
    deadlineMs: number
    /** Hold each flow to EVENT_FIRE_CAP_PER_DAY fires a day (the owner-scoped event triggers). */
    cap?: boolean
  },
): Promise<{ dispatched: number; skipped?: 'agent_paused'; capped?: number }> {
  const { fireId, workspaceId, flows, trigger, source, deadlineMs } = args
  if (flows.length === 0) return { dispatched: 0 }

  // The kill switch (A5): autonomy off runs no loop. Ledgered per flow.
  const paused = await step.run('kill-switch', () => checkAgentPaused(supabase, workspaceId, 'flow_dispatch'))
  if (paused) {
    await step.run('ledger-paused-fires', () => ledgerPausedFires(supabase, { workspaceId, flows, fireId, source }))
    return { dispatched: 0, skipped: 'agent_paused' }
  }

  let dispatched = 0
  let capped = 0
  for (const flow of flows) {
    if (args.cap) {
      const state = await step.run(`cap-${flow.id}`, async () => {
        const s = await eventFireCapState(supabase, flow.id)
        if (s === 'capped') await ledgerSkippedFire(supabase, { workspaceId, flow, fireId, source, reason: EVENT_CAP_SKIP_REASON })
        return s
      })
      if (state !== 'ok') {
        capped += 1
        continue
      }
    }
    await step.run(`run-flow-${flow.id}`, async () => {
      const flowRunId = fireRunId(fireId, flow.id)
      const work = await startFlowWork(supabase, { workspaceId, flow, fireId, source })
      const ran = await runFlow(
        { actions: flow.actions },
        null,
        trigger,
        APP_BASE_URL,
        {
          executors: {
            run_skill: createRunSkillExecutor({ deadlineMs, workspaceId, runAsUserId: flow.created_by ?? null, flowId: flow.id, fireId, flowRunId, work }),
            run_agent: createRunAgentExecutor({ workspaceId, flowId: flow.id, runAsUserId: flow.created_by ?? null, fireId }),
            archive_capture: createArchiveCaptureExecutor({ workspaceId }),
            run_local_agent: createRunLocalAgentExecutor({ workspaceId, flowId: flow.id, runAsUserId: flow.created_by ?? null, fireKey: flowRunId }),
            call_tool: createCallToolExecutor({ workspaceId, runAsUserId: flow.created_by ?? null, flowId: flow.id, flowName: flow.name, flowRunId }),
          },
          extras: { workspaceId },
        },
      )
      const { status, action_results } = ran
      await insertFlowRunOnce(supabase, { id: flowRunId, flow_id: flow.id, triggered_by_action_id: null, status, action_results, ...legacySnapshotFromResults(action_results) })
      await backfillCardRunLink(supabase, fireId, flowRunId)
      await keepRunState(supabase, {
        flowRunId,
        flowId: flow.id,
        workspaceId,
        actions: flow.actions,
        createdBy: flow.created_by ?? null,
        outcome: ran,
        context: { trigger, entity: null, extras: { workspaceId }, fire_id: fireId, origin_depth: 1, run_as_user_id: flow.created_by ?? null },
      })
      await work.link({ flowRunId })
      await settleFlowWork(work, { status, actionResults: action_results, flowRunId, supabase })
    })
    dispatched += 1
  }
  return { dispatched, ...(capped ? { capped } : {}) }
}

/**
 * Ledger an entity-less fire as a SKIP with its reason: one flow_run row with
 * every action skipped (the dormancy shape: the run history shows the reason),
 * plus the fire's work-ledger row as skipped. Best effort.
 */
async function ledgerSkippedFire(
  supabase: ReturnType<typeof getServiceClient>,
  args: {
    workspaceId: string
    flow: { id: string; name: string; created_by: string | null; actions: FlowAction[] }
    fireId: string | null
    source: WorkSource
    reason: string
  },
): Promise<void> {
  const action_results = skippedActionResults(args.flow.actions, args.reason)
  const flowRunId = crypto.randomUUID()
  try {
    await insertFlowRunOnce(supabase, {
      id: flowRunId,
      flow_id: args.flow.id,
      triggered_by_action_id: null,
      status: 'success',
      action_results,
      ...legacySnapshotFromResults(action_results),
      response_body_preview: args.reason,
    })
  } catch {
    /* best-effort ledger */
  }
  await startFlowWork(supabase, {
    workspaceId: args.workspaceId,
    flow: args.flow,
    fireId: args.fireId,
    source: args.source,
    status: 'skipped',
    skipReason: args.reason,
    flowRunId,
  })
}

/**
 * Dispatch quote_received loops (roadmap B1): the website quote intake emits
 * `flow/quote.received` once per new quote (src/lib/flows/emit-quote-received.ts).
 * Every enabled quote_received loop of the workspace fires, entity-less
 * (`{{trigger.quote_id}}` names the quote), running as its owner, under the
 * kill switch. retries: 0 like the PR dispatcher: an event, recorded in
 * flow_run either way. Concurrency per workspace.
 */
export const flowDispatchOnQuoteReceived = inngest.createFunction(
  {
    id: 'flow-dispatch-on-quote-received',
    retries: 0,
    concurrency: [{ limit: 2, key: 'event.data.workspace_id' }],
    triggers: [{ event: 'flow/quote.received' }],
  },
  async ({ event, step }) => {
    const deadlineMs = flowRunDeadlineMs(Date.now())
    const { workspace_id, quote_id, fired_at } = event.data as { workspace_id: string; quote_id: string; fired_at?: string }
    const supabase = getServiceClient()

    const flows = await step.run('find-matching-flows', async () => findMatchingFlowsForQuoteReceived(supabase, workspace_id))
    if (flows.length === 0) return { dispatched: 0 }

    const trigger: TriggerContext = {
      type: 'quote_received',
      entity_type: null,
      from_status_id: null,
      to_status_id: null,
      fired_at: fired_at ?? new Date().toISOString(),
      quote_id,
    }
    const out = await runEntitylessFires(supabase, step, { fireId: event.id ?? null, workspaceId: workspace_id, flows, trigger, source: { quote_id }, deadlineMs })
    return out.skipped ? out : { dispatched: out.dispatched, quote_id }
  },
)

/**
 * Dispatch email_received loops: the incremental mail sync emits
 * `flow/email.received` once per message that ARRIVED in a person's connected
 * mailbox (src/lib/flows/emit-email-received.ts: mail from someone else, not
 * spam, trash or a draft, never the first import). Only that person's own
 * loops fire (the matcher filters on created_by), with their sender filter;
 * `{{trigger.email_thread_id}}` / `{{trigger.email_account_id}}` name the
 * thread, which a step reads live with read_email. Capped per flow
 * (event-triggers.ts). retries: 0, concurrency per workspace.
 */
export const flowDispatchOnEmailReceived = inngest.createFunction(
  {
    id: 'flow-dispatch-on-email-received',
    retries: 0,
    concurrency: [{ limit: 2, key: 'event.data.workspace_id' }],
    triggers: [{ event: 'flow/email.received' }],
  },
  async ({ event, step }) => {
    const deadlineMs = flowRunDeadlineMs(Date.now())
    const { workspace_id, user_id, account_id, thread_id, message_id, from_email, fired_at } = event.data as {
      workspace_id: string
      user_id: string
      account_id?: string | null
      thread_id: string
      message_id: string
      from_email?: string | null
      fired_at?: string
    }
    const supabase = getServiceClient()

    const flows = await step.run('find-matching-flows', async () =>
      findMatchingFlowsForEmailReceived(supabase, { workspaceId: workspace_id, ownerUserId: user_id, fromEmail: from_email ?? null }),
    )
    if (flows.length === 0) return { dispatched: 0 }

    const trigger: TriggerContext = {
      type: 'email_received',
      entity_type: null,
      from_status_id: null,
      to_status_id: null,
      fired_at: fired_at ?? new Date().toISOString(),
      email_thread_id: thread_id,
      email_account_id: account_id ?? null,
      // Only a well-formed address rides the template; never a display name.
      email_from: isEmailAddress(from_email) ? from_email : null,
    }
    const out = await runEntitylessFires(supabase, step, {
      fireId: event.id ?? null,
      workspaceId: workspace_id,
      flows,
      trigger,
      source: { thread_ids: [thread_id] },
      deadlineMs,
      cap: true,
    })
    return { ...out, message_id }
  },
)

/**
 * Dispatch chat_message loops: the team chat post route emits
 * `flow/chat.message` once per message a PERSON writes
 * (src/lib/flows/emit-chat-message.ts). Re-checked here: a person's message
 * (the loop guard: never an agent's, a call's row, or a deleted one), the
 * loop takes it (its channel, or any channel with mentions-only, and then
 * only a message that @mentions the owner), and the owner can read the
 * channel now (event-triggers.ts chatFlowsToFire). Ids only in the template
 * (`{{trigger.chat_message_id}}` …); a step reads it with
 * read_team_chat_message. Capped per flow. retries: 0, concurrency per
 * workspace.
 */
export const flowDispatchOnChatMessage = inngest.createFunction(
  {
    id: 'flow-dispatch-on-chat-message',
    retries: 0,
    concurrency: [{ limit: 2, key: 'event.data.workspace_id' }],
    triggers: [{ event: 'flow/chat.message' }],
  },
  async ({ event, step }) => {
    const deadlineMs = flowRunDeadlineMs(Date.now())
    const { workspace_id, message_id, channel_id, fired_at } = event.data as { workspace_id: string; message_id: string; channel_id: string; fired_at?: string }
    const supabase = getServiceClient()

    const found = await step.run('find-matching-flows', async () => {
      const msg = await loadChatMessageFacts(supabase, message_id)
      if (!msg || msg.workspace_id !== workspace_id || msg.channel_id !== channel_id) return { flows: [] as FlowWithSecrets[], threadRoot: null }
      if (chatMessageSkipReason(msg)) return { flows: [] as FlowWithSecrets[], threadRoot: null }
      const candidates = await findMatchingFlowsForChatMessage(supabase, { workspaceId: workspace_id, channelId: channel_id })
      return { flows: await chatFlowsToFire(supabase, candidates, msg), threadRoot: msg.thread_root_id }
    })
    if (found.flows.length === 0) return { dispatched: 0 }

    const trigger: TriggerContext = {
      type: 'chat_message',
      entity_type: null,
      from_status_id: null,
      to_status_id: null,
      fired_at: fired_at ?? new Date().toISOString(),
      chat_message_id: message_id,
      chat_channel_id: channel_id,
      chat_thread_root_id: found.threadRoot,
    }
    return runEntitylessFires(supabase, step, {
      fireId: event.id ?? null,
      workspaceId: workspace_id,
      flows: found.flows as FlowWithSecrets[],
      trigger,
      source: { chat_message_id: message_id },
      deadlineMs,
      cap: true,
    })
  },
)

/**
 * Dispatch document_created loops: the documents route emits
 * `flow/document.created` for a document a PERSON created, delivered about
 * five minutes later (src/lib/flows/emit-document-created.ts) so the run reads
 * what they wrote. Skipped when the document was deleted or archived by then;
 * fires the loops whose owner can see it now (event-triggers.ts
 * documentFlowsToFire: not a private one). `{{trigger.document_id}}` names it.
 * Capped per flow. retries: 0, concurrency per workspace.
 */
export const flowDispatchOnDocumentCreated = inngest.createFunction(
  {
    id: 'flow-dispatch-on-document-created',
    retries: 0,
    concurrency: [{ limit: 2, key: 'event.data.workspace_id' }],
    triggers: [{ event: 'flow/document.created' }],
  },
  async ({ event, step }) => {
    const deadlineMs = flowRunDeadlineMs(Date.now())
    const { workspace_id, document_id } = event.data as { workspace_id: string; document_id: string }
    const supabase = getServiceClient()

    const found = await step.run('find-matching-flows', async () => {
      const doc = await loadDocumentFacts(supabase, document_id)
      const skip = documentSkipReason(doc, workspace_id)
      if (skip || !doc) return { skip: skip ?? 'deleted', flows: [] as FlowWithSecrets[] }
      const candidates = await findMatchingFlowsForDocumentCreated(supabase, workspace_id)
      return { skip: null, flows: await documentFlowsToFire(supabase, candidates, doc) }
    })
    if (found.skip) return { dispatched: 0, skipped: found.skip }
    if (found.flows.length === 0) return { dispatched: 0 }

    const trigger: TriggerContext = {
      type: 'document_created',
      entity_type: null,
      from_status_id: null,
      to_status_id: null,
      fired_at: new Date().toISOString(),
      document_id,
    }
    return runEntitylessFires(supabase, step, {
      fireId: event.id ?? null,
      workspaceId: workspace_id,
      flows: found.flows as FlowWithSecrets[],
      trigger,
      source: { document_id },
      deadlineMs,
      cap: true,
    })
  },
)

/**
 * A parked run's card was answered (F4, flow-step-resume.ts): carry the run
 * on from the step with its output, or end it with a note. Sent by
 * approvals.ts (Accept, Skip, a refused re-check), the expiry sweep and the
 * kill switch. retries: 3, because the dispatcher may still be writing the
 * run when a fast Accept lands (not_found_yet throws, and Inngest retries).
 * One at a time per run.
 */
export const flowResumeOnStepSettled = inngest.createFunction(
  {
    id: 'flow-resume-on-step-settled',
    retries: 3,
    concurrency: [{ limit: 1, key: 'event.data.flow_run_id' }],
    triggers: [{ event: FLOW_STEP_SETTLED_EVENT }],
  },
  async ({ event, step }) => {
    const deadlineMs = flowRunDeadlineMs(Date.now())
    const { approval_id, flow_run_id, outcome } = event.data as { approval_id: string; flow_run_id: string; outcome: FlowStepOutcome }
    const supabase = getServiceClient()
    return step.run(`resume-${flow_run_id}-${approval_id}`, async () => {
      const result = await resumeParkedRun(
        {
          supabase,
          appBaseUrl: APP_BASE_URL,
          executorsFor: ({ flow, context }) => ({
            run_skill: createRunSkillExecutor({
              deadlineMs,
              workspaceId: flow.workspace_id,
              runAsUserId: context.run_as_user_id ?? flow.created_by ?? null,
              flowId: flow.id,
              fireId: context.fire_id,
              flowRunId: flow_run_id,
              originDepth: context.origin_depth,
              ...(context.manual ? { manual: true } : {}),
            }),
            run_agent: createRunAgentExecutor({
              workspaceId: flow.workspace_id,
              flowId: flow.id,
              runAsUserId: flow.created_by ?? null,
              fireId: context.fire_id,
            }),
            archive_capture: createArchiveCaptureExecutor({ workspaceId: flow.workspace_id }),
            // L5: a job on the owner's Mac (run-local-agent.ts); one per fire, keyed on its run.
            run_local_agent: createRunLocalAgentExecutor({ workspaceId: flow.workspace_id, flowId: flow.id, runAsUserId: context.run_as_user_id ?? flow.created_by ?? null, fireKey: flow_run_id }),
            call_tool: createCallToolExecutor({
              workspaceId: flow.workspace_id,
              // Who the parked run ran as (its owner; a Test, its caller).
              runAsUserId: context.run_as_user_id ?? flow.created_by ?? null,
              flowId: flow.id,
              flowName: flow.name,
              flowRunId: flow_run_id,
              ...(context.manual && context.run_as_user_id ? { manual: { firedBy: context.run_as_user_id } } : {}),
            }),
          }),
          ledger: {
            start: async ({ flow, context, approvalId }) => {
              const work = await startFlowWork(supabase, {
                workspaceId: flow.workspace_id,
                flow,
                // Its own row: what ran after the person's yes.
                fireId: `${context.fire_id ?? flow_run_id}:after:${approvalId}`,
                source: { flow_run_id },
                flowRunId: flow_run_id,
              })
              return {
                settle: (status, results) => settleFlowWork(work, { status, actionResults: results, flowRunId: flow_run_id, supabase }),
              }
            },
          },
        },
        { approvalId: approval_id, flowRunId: flow_run_id, outcome },
      )
      // The dispatcher may still be writing the run: let Inngest retry.
      if (!result.ok && result.reason === 'not_found_yet') throw new Error('parked run not written yet')
      return result
    })
  },
)
