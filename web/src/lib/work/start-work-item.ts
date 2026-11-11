/**
 * Start a unit of agent work: file the tracked action, insert the work run
 * (`agent_run`, kind 'workspace'), open its ledger row, mark the backing
 * proposal applied, and dispatch the durable eve session.
 *
 * This is the body of the rail's Start (`PATCH /api/account/attention-items`,
 * action 'start'), extracted so the auto-attempt gate (Sequence step 3, B PR 3,
 * src/lib/work/auto-attempt.ts) starts work through the SAME code a person's
 * click does — "Attempt = today's Start without the click" (investigation §3.5).
 * The route keeps what is card-specific: the caller's membership, the card's
 * task, the card CAS and its revert. Everything here behaves as it did inside
 * the route, with two additions that only the gate uses:
 *
 *   - `fireKey`: the run row carries `agent_run.fire_key` (unique, migration
 *     196). An existing run with the key is REUSED — no second action, no
 *     second run — and a lost insert race (23505) deletes the action it just
 *     filed and reuses the winner. So a retried verdict step, or a reconciler
 *     re-fire of the same proposal, cannot start the work twice.
 *   - `origin` / `originDepth` / `aiTeamMemberId`: stamped on the run and its
 *     ledger row when set ('attempt' for the gate), so the tool route picks the
 *     drafting ceiling and the breaker can count a role's attempts.
 *   - `trackedAction: false` + `sourceCaptureId` + `flowId`: no board action is
 *     filed; the run records the flow that started it (agent_run_has_origin
 *     requires an action or a flow) and anchors to its source capture (the
 *     ledger row's source, and a `declared` read touch so the capture's
 *     activity shows it from the start).
 *     The backing proposal is left pending: nothing on the board was created
 *     from it. Every run-lifecycle write already tolerates a run with no action;
 *     Stop goes through the run-keyed cancel route.
 *
 * And one the delegate Start uses (decision 9, start-agent):
 *
 *   - `existingActionId`: work an action already on the board. No action is
 *     filed; the run anchors to it and a failed start resets it to idle
 *     rather than deleting it.
 *
 * The dispatch event carries a per-run id (`work-run-requested:<runId>`), so
 * Inngest drops a re-emit for the same run inside its dedup window: a reused
 * run is re-dispatched safely (covering a crash between the insert and the
 * emit), and two dispatches of one run can never race two eve creates.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { ensureWorkForAgentRun, mirrorAgentRunStatus } from './agent-run-mirror'
import { recordWorkTouches } from './touch'
import type { WorkResourceRef } from '@/lib/agent-run/types'
import type { WorkProvenance } from './types'
import { WORK_RESOURCES_MAX, WORK_RESOURCE_LABEL_MAX_CHARS } from '@/lib/agent-run/types'
import { LINKABLE_ENTITY_TYPES, entityInWorkspace } from '@/lib/ai/tools/claims'
import { canonicalEntityType } from '@/lib/knowledge/entity-registry'
import type { WorkExpectation } from './roles'

/** The Inngest event id for a work run's dispatch — one dispatch per run. */
export function workRunDispatchEventId(agentRunId: string): string {
  return `work-run-requested:${agentRunId}`
}

/** What a start needs resolved before anything is written. */
export interface WorkItemPlan {
  teamId: string
  statusId: string
  /** The declared resources, each id re-validated against the workspace. */
  resources: WorkResourceRef[]
}

/**
 * The pure-read half of a start: the workspace's default team and its default
 * workflow state, and the resource snapshot. No writes, so a caller can run it
 * before claiming anything. Null when the workspace has no team or no default
 * state (the tracked action cannot be filed).
 */
export async function planWorkItem(
  supabase: SupabaseClient,
  args: { workspaceId: string; resources: WorkResourceRef[] | undefined },
): Promise<WorkItemPlan | null> {
  const teamId = await defaultTeamId(supabase, args.workspaceId)
  const statusId = teamId ? await defaultStateId(supabase, teamId) : undefined
  if (!teamId || !statusId) return null
  const resources = await snapshotResources(supabase, args.resources, args.workspaceId)
  return { teamId, statusId, resources }
}

export interface LaunchWorkItemInput {
  workspaceId: string
  /** The run-as auth user: `agent_run.triggered_by` and the action's `user_id`. */
  userId: string
  /** The run-as member: the proposal's `applied_by`. */
  memberId: string
  /** The tracked action's title (already resolved by the caller). */
  title: string
  task: string
  plan: WorkItemPlan
  attentionItemId?: string | null
  proposalId?: string | null
  /** The ledger row's title source (the card's title on a Start). */
  ledgerTitle?: string | null
  fireKey?: string | null
  /** 'user' (default, a person pressed Start) or 'attempt' (the gate). */
  origin?: 'user' | 'attempt'
  /** Delegation chain depth (0 for any root run). */
  originDepth?: number
  /** The teammate doing the work, when one was resolved (the gate's). */
  aiTeamMemberId?: string | null
  /** File a tracked board action for the run (default true — a person's Start). */
  trackedAction?: boolean
  /**
   * Work an action that already exists instead of filing one (a delegated
   * action's Start, decision 9: start-agent for a non-developer agent or a
   * project with no repo). Nothing is inserted; the run anchors to it (which
   * satisfies agent_run_has_origin) and its agent_run_status goes to
   * 'starting'. A failed start resets it to 'idle' and never deletes it.
   * Wins over `trackedAction`.
   */
  existingActionId?: string | null
  /** The capture the work came from: the ledger row's anchor and a declared read touch. */
  sourceCaptureId?: string | null
  /**
   * Where the work came from, for the run's brief (B PR 4): the capture and the
   * transcript quote that asked for it. Kept on the ledger row's source
   * (`source.provenance`); the dispatcher turns it into the brief's quote and
   * capture excerpt. It does not anchor the row (sourceCaptureId does).
   */
  provenance?: WorkProvenance | null
  /**
   * The flow that started the work (an attempt: the verdict's flow). Recorded on
   * the run; REQUIRED when no board action is filed, because agent_run_has_origin
   * (mig 158) needs an action or a flow on every run.
   */
  flowId?: string | null
  /** What the work must hand back (the card's `expects`), checked against the
   *  run's deliverables at settle (agent_run.expects, migration 286). */
  expects?: WorkExpectation[] | null
}

export type LaunchWorkItemResult =
  | { ok: true; reused: boolean; agentRunId: string; actionId: string | null; identifier: string | null }
  | { ok: false; stage: 'action' | 'run' | 'dispatch'; error: string }

/**
 * The tracked action a person's Start files (step 1 of launchWorkItem, and a
 * work card started on a Mac, src/lib/environments/start.ts startWorkOnMac):
 * the default workflow state of the default team, confirmed, 'starting'.
 * OMIT source_type: it keeps its default, 'user'. Its CHECK lists user,
 * meeting_extraction, chat_suggestion, stt_extraction and insight_suggestion,
 * and refuses anything else ('chat' and 'capture' are not values it takes).
 */
export async function fileTrackedAction(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; plan: WorkItemPlan; title: string; task: string; attentionItemId?: string | null },
): Promise<{ ok: true; actionId: string; identifier: string } | { ok: false; error: string }> {
  const { data: action, error: actionErr } = await supabase
    .from('actions')
    .insert({
      user_id: args.userId,
      workspace_id: args.workspaceId,
      team_id: args.plan.teamId,
      title: args.title,
      description: args.task,
      status_id: args.plan.statusId,
      confirmation: 'confirmed',
      agent_run_status: 'starting',
      context_data: {
        work_run: true,
        ...(args.attentionItemId ? { attention_item_id: args.attentionItemId } : {}),
      },
    })
    .select('id, identifier')
    .single()
  if (actionErr || !action) return { ok: false, error: actionErr?.message ?? 'Failed to create tracked action' }
  const actionId = action.id as string
  return { ok: true, actionId, identifier: (action.identifier as string | null) ?? actionId }
}

/** Best-effort: the backing proposal became real tracked work (never fails a Start). */
export async function markProposalApplied(
  supabase: SupabaseClient,
  args: { workspaceId: string; proposalId: string; memberId: string; actionId: string },
): Promise<void> {
  await supabase
    .from('proposed_change')
    .update({
      status: 'applied',
      applied_at: new Date().toISOString(),
      applied_by: args.memberId,
      result_entity_id: args.actionId,
      // Clear any stale error_message from a prior failed attempt on this row.
      error_message: null,
    })
    .eq('id', args.proposalId)
    .eq('status', 'pending')
    .eq('workspace_id', args.workspaceId)
}

/** The dispatch sender (inngest.send); injectable for tests. */
export type WorkRunDispatchSend = (payload: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>
type Send = WorkRunDispatchSend

/**
 * Write and dispatch a planned start. `supabase` makes the action, run and
 * proposal writes (the caller's client: the person's session on a Start, the
 * service role for the gate); `service` writes the ledger row and the
 * run-failed compensation (no member policy exists for either). Never throws on
 * a write failure: it compensates its own writes and reports the stage, so the
 * caller can revert what it claimed.
 */
export async function launchWorkItem(
  supabase: SupabaseClient,
  service: SupabaseClient,
  input: LaunchWorkItemInput,
  deps: { send?: Send } = {},
): Promise<LaunchWorkItemResult> {
  const send: Send = deps.send ?? ((p) => inngest.send(p as never))
  const { workspaceId, userId, task, plan } = input
  const origin = input.origin ?? 'user'
  const fireKey = input.fireKey ?? null

  // Idempotency: a run already carrying this fire_key IS this start.
  if (fireKey) {
    const existing = await findRunByFireKey(supabase, fireKey, workspaceId)
    if (existing) return reuse(supabase, service, existing, input, send)
  }

  // 1. The tracked action (a person's Start only; an attempt anchors to its
  //    capture instead). OMIT source_type (it keeps its default, 'user'; its
  //    CHECK refuses a value it does not list, 'chat' among them); the default
  //    workflow state of the default team.
  let actionId: string | null = null
  let identifier: string | null = null
  const existingActionId = input.existingActionId ?? null
  if (!existingActionId && input.trackedAction === false && !input.flowId) {
    return { ok: false, stage: 'run', error: 'a run with no tracked action needs its flow (agent_run_has_origin)' }
  }
  if (existingActionId) {
    // The action is already on the board: mark it starting, fenced to the
    // workspace. No row back means it isn't this workspace's.
    const { data: existing, error: existingErr } = await supabase
      .from('actions')
      .update({ agent_run_status: 'starting' })
      .eq('id', existingActionId)
      .eq('workspace_id', workspaceId)
      .select('id, identifier')
      .maybeSingle()
    if (existingErr || !existing) {
      return { ok: false, stage: 'action', error: existingErr?.message ?? 'Action not found' }
    }
    actionId = existing.id as string
    identifier = (existing.identifier as string | null) ?? actionId
  } else if (input.trackedAction !== false) {
    const filed = await fileTrackedAction(supabase, {
      workspaceId,
      userId,
      plan,
      title: input.title,
      task,
      attentionItemId: input.attentionItemId,
    })
    if (!filed.ok) return { ok: false, stage: 'action', error: filed.error }
    actionId = filed.actionId
    identifier = filed.identifier
  }

  // 2. The run. Before the proposal CAS, so a run-insert failure never leaves the
  //    proposal applied against a rolled-back action. Non-default columns only
  //    when set, so a person's Start writes exactly the row it always did.
  const { data: run, error: runErr } = await supabase
    .from('agent_run')
    .insert({
      workspace_id: workspaceId,
      action_id: actionId,
      kind: 'workspace',
      status: 'queued',
      task_prompt: task,
      resources: plan.resources,
      attention_item_id: input.attentionItemId ?? null,
      proposal_id: input.proposalId ?? null,
      triggered_by: userId,
      ...(fireKey ? { fire_key: fireKey } : {}),
      ...(input.flowId ? { flow_id: input.flowId } : {}),
      ...(origin !== 'user' ? { origin } : {}),
      ...(input.originDepth ? { origin_depth: input.originDepth } : {}),
      ...(input.aiTeamMemberId ? { ai_team_member_id: input.aiTeamMemberId } : {}),
      ...(input.expects && input.expects.length > 0 ? { expects: input.expects } : {}),
    })
    .select('id')
    .single()
  if (runErr || !run) {
    // Leave no orphan 'starting' action on the board: delete the one this
    // start filed; an existing action only goes back to idle.
    if (actionId && existingActionId) {
      await supabase.from('actions').update({ agent_run_status: 'idle' }).eq('id', actionId).eq('workspace_id', workspaceId)
    } else if (actionId) {
      await supabase.from('actions').delete().eq('id', actionId).eq('workspace_id', workspaceId)
    }
    // Lost the fire_key race: the winner's run IS this start.
    if ((runErr as { code?: string } | null)?.code === '23505' && fireKey) {
      const winner = await findRunByFireKey(supabase, fireKey, workspaceId)
      if (winner) return reuse(supabase, service, winner, input, send)
    }
    return { ok: false, stage: 'run', error: runErr?.message ?? 'Failed to create work run' }
  }
  const agentRunId = run.id as string

  // 3. The ledger row exists from this moment (NORTH-STAR invariant 3), queued
  //    until the first beat. Service role: the ledger has no client write policy.
  const work = await ensureWorkForAgentRun(
    service,
    {
      id: agentRunId,
      workspace_id: workspaceId,
      kind: 'workspace',
      status: 'queued',
      triggered_by: userId,
      task_prompt: task,
      action_id: actionId,
      ...(origin !== 'user' ? { origin } : {}),
      ...(input.aiTeamMemberId ? { ai_team_member_id: input.aiTeamMemberId } : {}),
      ...(input.sourceCaptureId ? { source_capture_id: input.sourceCaptureId } : {}),
      ...(input.provenance && (input.provenance.captureId || input.provenance.quote) ? { provenance: input.provenance } : {}),
    },
    { actionTitle: input.ledgerTitle ?? null },
  )
  // The source capture as a declared read, so the run is on the capture's
  // activity from the start (fail-soft; the unique index absorbs a replay).
  if (input.sourceCaptureId && work.id) {
    await recordWorkTouches(service, [
      {
        workspaceId,
        workItemId: work.id,
        agentRunId,
        entityType: 'capture',
        entityId: input.sourceCaptureId,
        verb: 'read',
        toolName: 'declared',
      },
    ])
  }

  // 4. Best-effort: the backing proposal became real tracked work. Only when a
  //    board action was filed from it; without one the proposal stays pending.
  if (input.proposalId && actionId) {
    await markProposalApplied(supabase, { workspaceId, proposalId: input.proposalId, memberId: input.memberId, actionId })
  }

  // 5. The durable dispatch. If the emit throws, no worker will ever pick the run
  //    up: mark it failed, settle its ledger row (else Activity shows it queued,
  //    with a Stop, for good), and reset the action (not stuck 'starting'). The
  //    caller reverts whatever it claimed.
  try {
    await dispatch(send, agentRunId, workspaceId)
  } catch (emitErr) {
    // Service client: migration 200 dropped the member UPDATE policy on agent_run.
    const message = emitErr instanceof Error ? emitErr.message : 'Failed to dispatch work run'
    await service
      .from('agent_run')
      .update({ status: 'failed' })
      .eq('id', agentRunId)
      .eq('workspace_id', workspaceId)
    await mirrorAgentRunStatus(service, { agentRunId, workspaceId }, { status: 'failed', error: `Could not dispatch: ${message}` })
    if (actionId) {
      await supabase
        .from('actions')
        .update({ agent_run_status: 'idle' })
        .eq('id', actionId)
        .eq('workspace_id', workspaceId)
    }
    return { ok: false, stage: 'dispatch', error: message }
  }

  return { ok: true, reused: false, agentRunId, actionId, identifier }
}

function dispatch(send: Send, agentRunId: string, workspaceId: string) {
  return send({
    id: workRunDispatchEventId(agentRunId),
    name: 'work/run.requested',
    data: { agent_run_id: agentRunId, workspace_id: workspaceId },
  })
}

interface ExistingRun {
  id: string
  action_id: string | null
  status: string | null
}

async function findRunByFireKey(
  supabase: SupabaseClient,
  fireKey: string,
  workspaceId: string,
): Promise<ExistingRun | null> {
  const { data } = await supabase
    .from('agent_run')
    .select('id, action_id, status')
    .eq('fire_key', fireKey)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return (data as ExistingRun | null) ?? null
}

/**
 * The start already happened (a retry, or a lost insert race): make sure its
 * ledger row exists and its dispatch was sent (the per-run event id makes a
 * second send a no-op inside Inngest's window; the dispatcher's guard refuses a
 * settled run after it), and report the existing run.
 */
async function reuse(
  supabase: SupabaseClient,
  service: SupabaseClient,
  existing: ExistingRun,
  input: LaunchWorkItemInput,
  send: Send,
): Promise<LaunchWorkItemResult> {
  const origin = input.origin ?? 'user'
  await ensureWorkForAgentRun(
    service,
    {
      id: existing.id,
      workspace_id: input.workspaceId,
      kind: 'workspace',
      status: existing.status ?? 'queued',
      triggered_by: input.userId,
      task_prompt: input.task,
      action_id: existing.action_id,
      ...(origin !== 'user' ? { origin } : {}),
      ...(input.aiTeamMemberId ? { ai_team_member_id: input.aiTeamMemberId } : {}),
      ...(input.sourceCaptureId ? { source_capture_id: input.sourceCaptureId } : {}),
    },
    { actionTitle: input.ledgerTitle ?? null },
  )
  let identifier: string | null = null
  if (existing.action_id) {
    const { data: action } = await supabase
      .from('actions')
      .select('identifier')
      .eq('id', existing.action_id)
      .eq('workspace_id', input.workspaceId)
      .maybeSingle()
    identifier = (action?.identifier as string | null) ?? existing.action_id
  }
  if (existing.status === 'queued') {
    try {
      await dispatch(send, existing.id, input.workspaceId)
    } catch (err) {
      // The run stays queued; the reaper settles a run that never beats.
      console.warn('[work] re-dispatch of a reused run failed', {
        agentRunId: existing.id,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { ok: true, reused: true, agentRunId: existing.id, actionId: existing.action_id, identifier }
}

// ── Pure lookups (moved from the attention-items route) ───────────────────────

/** The workspace's default team (oldest) — mirrors actions.ts. */
async function defaultTeamId(supabase: SupabaseClient, workspaceId: string): Promise<string | undefined> {
  const { data } = await supabase
    .from('team')
    .select('id')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle()
  return (data?.id as string | undefined) ?? undefined
}

/** A team's default workflow state — mirrors actions.ts. */
async function defaultStateId(supabase: SupabaseClient, teamId: string): Promise<string | undefined> {
  const { data } = await supabase
    .from('workflow_state')
    .select('id')
    .eq('team_id', teamId)
    .eq('is_default', true)
    .maybeSingle()
  return (data?.id as string | undefined) ?? undefined
}

/**
 * Snapshot declared resources onto the run, clamped to the limits verdict-apply
 * enforces (≤8 entries, labels ≤80 chars). Malformed entries are dropped.
 *
 * Defense-in-depth (Loops v3 security): every resource id is re-validated
 * against the run's OWN workspace before it lands on the run. A work run executes
 * with a service-role client fenced to the run's workspace; an id naming a row in
 * another workspace would let the executor reach across tenancy. An id that does
 * not resolve here (or has an unmappable type) is DROPPED, its label kept. A bad
 * id never fails the start.
 *
 * `requesterUserId` is who the run is for. A private graph kind's id (a
 * calendar event, a team-chat channel or message, a decision) survives only
 * when that person may read it; with no requester it is dropped.
 */
export async function snapshotResources(
  supabase: SupabaseClient,
  raw: WorkResourceRef[] | undefined,
  workspaceId: string,
  requesterUserId?: string | null,
): Promise<WorkResourceRef[]> {
  if (!Array.isArray(raw)) return []
  const out: WorkResourceRef[] = []
  for (const r of raw) {
    if (out.length >= WORK_RESOURCES_MAX) break
    if (!r || typeof r !== 'object') continue
    // A retired kind name (a proposal's `email`) is snapshotted under its current one.
    const type = typeof r.type === 'string' ? canonicalEntityType(r.type) : ''
    const label = typeof r.label === 'string' ? r.label.trim().slice(0, WORK_RESOURCE_LABEL_MAX_CHARS) : ''
    if (!type || !label) continue
    const ref: WorkResourceRef = { type, label }
    if (typeof r.id === 'string' && r.id) {
      if (await resourceIdInWorkspace(supabase, type, r.id, workspaceId, requesterUserId)) ref.id = r.id
    }
    out.push(ref)
  }
  return out
}

/** True iff a resource id resolves to a row inside the given workspace. `package`
 *  keeps its own knowledge_package fence; `cycle` (team-fenced) and `milestone`
 *  (project-fenced) have no workspace_id of their own and verify through their
 *  parent — STRICTER than entityInWorkspace's can't-verify→allow. Every other
 *  LINKABLE_ENTITY_TYPE delegates to entityInWorkspace, which fences the
 *  private graph kinds (calendar_event, team_chat_*, decision) to
 *  `requesterUserId` and fails them closed without one. Any other type is
 *  unmappable → false (the id is dropped, the label kept). */
export async function resourceIdInWorkspace(
  supabase: SupabaseClient,
  type: string,
  id: string,
  workspaceId: string,
  requesterUserId?: string | null,
): Promise<boolean> {
  if (type === 'package') {
    const { data } = await supabase
      .from('knowledge_package')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return !!data
  }
  if (type === 'cycle') {
    const { data: c } = await supabase.from('cycle').select('team_id').eq('id', id).maybeSingle()
    const teamId = (c?.team_id as string | undefined) ?? undefined
    if (!teamId) return false
    const { data: t } = await supabase
      .from('team')
      .select('id')
      .eq('id', teamId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return !!t
  }
  if (type === 'milestone') {
    const { data: m } = await supabase.from('milestone').select('project_id').eq('id', id).maybeSingle()
    const projectId = (m?.project_id as string | undefined) ?? undefined
    if (!projectId) return false
    const { data: p } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return !!p
  }
  if ((LINKABLE_ENTITY_TYPES as readonly string[]).includes(type)) {
    return entityInWorkspace(supabase, workspaceId, type as (typeof LINKABLE_ENTITY_TYPES)[number], id, requesterUserId)
  }
  return false
}
