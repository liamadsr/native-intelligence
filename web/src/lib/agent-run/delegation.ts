/**
 * `delegate_work` — one work run hands a piece of its work to a teammate
 * (docs/plans/agent-orchestration-product.md, Part 3; Part 5 row 13).
 *
 * The tool (agents/work-agent/tools/delegate_work.ts) is gated `approval:
 * always()`, so eve pauses the parent's turn at `input.requested` BEFORE the
 * tool runs, exactly like `request_user_input`. Everything happens here, on the
 * server, under the parent's identity, never in the tool:
 *
 *   1. the watcher reads the calls off the turn (`extractDelegations`);
 *   2. `planDelegations` runs the checks of §3.2 for each call, creates a child
 *      work run for each one that passes (queued, not yet dispatched) and a
 *      `skipped` ledger row for each one refused;
 *   3. the parent parks (`agent_run.pending_input = DelegationPark`, status
 *      `needs_input`; its ledger row `waiting_on_child`), and only then are the
 *      children dispatched, so a child can never settle before its parent is
 *      parked on it;
 *   4. each child's settle emits `work/run.child_settled`; once every child is
 *      terminal, the parent's approvals are answered (approve) and each
 *      `delegate_work` execute fetches its own child's result by call id
 *      (`buildDelegationResult`, served by /api/internal/work-run/delegation)
 *      and returns it as its TOOL RESULT. The reaper re-sends a lost
 *      child-settled event (`sweepSettledDelegationParks`).
 *
 * Deviation from Part 3.1, on purpose: the plan delivered the result in a
 * second eve turn (approve, then `send` the result as a message). The result
 * as the tool's own output is durable in eve's history (clientContext and
 * approval text are not), needs one turn instead of two, and cannot be
 * overtaken by the model finishing between the two turns (eve's recorded
 * fixture shows a resumed turn carrying on past its acknowledgement). A
 * refused handoff is answered the same way, so its reason is durable too.
 *
 * No human approves a handoff: "approval" is eve's pause mechanic. The child's
 * OUTPUT is reviewed like any other work (needs_review, expects).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HandleMessageStreamEvent } from 'eve/client'
import { inngest } from '@/lib/inngest/client'
import { ensureWorkForAgentRun, resolveMemberId } from '@/lib/work/agent-run-mirror'
import { findWork, startWork } from '@/lib/work/recorder'
import { WORK_KINDS } from '@/lib/work/types'
import { resolveAgentAutonomyPolicyFromSettings, type AgentAutonomyPolicy } from '@/lib/work/agent-autonomy-policy'
import { resolveRoleTeammate } from '@/lib/work/role-routing'
import {
  DEFAULT_EXPECTS_BY_ROLE,
  DELEGABLE_WORK_ROLES,
  WORK_ROLE_LABELS,
  evaluateExpects,
  isWorkRole,
  normalizeWorkExpects,
  type WorkExpectation,
  type WorkRole,
} from '@/lib/work/roles'
import { snapshotResources, workRunDispatchEventId } from '@/lib/work/start-work-item'
import { chatCeilingForChild } from './chat-bound'
import {
  WORK_RESOURCES_MAX,
  type DelegationPark,
  type DelegationParkEntry,
  type DelegationRefusalCode,
  type WorkDeliverable,
  type WorkResourceRef,
} from './types'

/** The work-agent tool's name (agents/work-agent/tools/delegate_work.ts). */
export const DELEGATE_WORK_TOOL = 'delegate_work'

/** Emitted when a delegated child reaches a terminal status. `agent_run_id` is
 *  the PARENT, so the parent's `cancelOn` match stops a release in flight. */
export const CHILD_SETTLED_EVENT = 'work/run.child_settled'

/** The child's `fire_key` and its refusal row's `run_key`: one per tool call,
 *  so a replayed watch reuses what the first pass created. */
export function delegationKey(parentRunId: string, callId: string): string {
  return `delegate:${parentRunId}:${callId}`
}

const TASK_MAX_CHARS = 4000
const CONTEXT_MAX_CHARS = 4000
const HAND_BACK_MAX_CHARS = 1000
const TERMINAL = ['pr_open', 'completed', 'failed', 'canceled']

/** A `delegate_work` call as the model made it, normalised. */
export interface DelegationInput {
  role: WorkRole
  task: string
  context: string | null
  handBack: string | null
  expects: WorkExpectation[] | null
  resources: WorkResourceRef[]
}

/** One `delegate_work` pause read off a drained turn. */
export interface DelegationRequest {
  requestId: string
  callId: string
  approveOptionId: string
  denyOptionId: string
  /** Null when the call's input could not be read (refused INVALID_BRIEF). */
  input: DelegationInput | null
  /** The role the model named, even when invalid (for the refusal row). */
  rawRole: string
}

function clip(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

/** Normalise a `delegate_work` input. Null when it has no valid role or task. */
export function normalizeDelegationInput(raw: unknown): DelegationInput | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!isWorkRole(r.role)) return null
  const brief = (r.brief && typeof r.brief === 'object' ? r.brief : {}) as Record<string, unknown>
  const task = clip(brief.task, TASK_MAX_CHARS)
  if (!task) return null
  const resources: WorkResourceRef[] = []
  if (Array.isArray(r.resources)) {
    for (const item of r.resources) {
      if (resources.length >= WORK_RESOURCES_MAX) break
      if (!item || typeof item !== 'object') continue
      const ref = item as Record<string, unknown>
      if (typeof ref.type !== 'string' || !ref.type || typeof ref.id !== 'string' || !ref.id) continue
      resources.push({
        type: ref.type,
        id: ref.id,
        label: typeof ref.label === 'string' && ref.label.trim() ? ref.label.trim() : ref.type,
      })
    }
  }
  return {
    role: r.role,
    task,
    context: clip(brief.context, CONTEXT_MAX_CHARS),
    handBack: clip(brief.hand_back, HAND_BACK_MAX_CHARS),
    expects: normalizeWorkExpects(r.expects),
    resources,
  }
}

/**
 * Every `delegate_work` pause in a drained turn's events (a step can call it
 * more than once; eve resolves the batch only when every request in it is
 * answered). The option ids come off each request, never a literal.
 */
export function extractDelegations(events: readonly HandleMessageStreamEvent[]): DelegationRequest[] {
  const out: DelegationRequest[] = []
  const seen = new Set<string>()
  for (const ev of events) {
    if (ev.type !== 'input.requested') continue
    for (const req of ev.data.requests) {
      if (req.action?.toolName !== DELEGATE_WORK_TOOL) continue
      if (seen.has(req.requestId)) continue
      seen.add(req.requestId)
      const opts = req.options
      const input = req.action?.input
      out.push({
        requestId: req.requestId,
        callId: (req.action as { callId?: string } | undefined)?.callId ?? req.requestId,
        approveOptionId: opts?.find((o) => o?.id === 'approve')?.id ?? opts?.[0]?.id ?? 'approve',
        denyOptionId: opts?.find((o) => o?.id === 'cancel' || o?.id === 'deny')?.id ?? opts?.[1]?.id ?? 'cancel',
        input: normalizeDelegationInput(input),
        rawRole:
          input && typeof input === 'object' && typeof (input as { role?: unknown }).role === 'string'
            ? ((input as { role: string }).role)
            : '',
      })
    }
  }
  return out
}

/** The child's task prompt: the brief, with who handed it over. */
export function renderDelegationTask(input: DelegationInput, from: { name: string | null; role: string | null }): string {
  const who = from.name ? `${from.name}${from.role ? ` (${roleLabel(from.role)})` : ''}` : 'A teammate'
  const expects = input.expects ?? DEFAULT_EXPECTS_BY_ROLE[input.role]
  const lines = [input.task, '', `${who} handed this to you as part of their own work.`]
  if (input.context) lines.push('', '### Context from them', input.context)
  if (input.handBack) lines.push('', '### What to hand back', input.handBack)
  if (expects.length > 0) {
    lines.push(
      '',
      `Deliverables expected: ${expects
        .map((e) => `${e.min ?? 1} × ${e.type === 'entity' && e.entity_type ? e.entity_type : e.type}`)
        .join(', ')}.`,
    )
  }
  return lines.join('\n')
}

function roleLabel(role: string): string {
  return isWorkRole(role) ? WORK_ROLE_LABELS[role] : role
}

const REFUSAL_TEXT: Record<DelegationRefusalCode, string> = {
  DELEGATION_DEPTH: 'this run is already as deep in a handoff chain as the workspace allows',
  DELEGATION_FAN_OUT: 'this run has already handed off as many pieces of work as the workspace allows',
  ROOT_BUDGET: 'this piece of work has used up its budget of handoffs',
  DELEGATION_NOT_ALLOWED: 'you are not allowed to hand work to that role',
  DELEGATION_ROLE_UNSUPPORTED: 'that role cannot take a handoff yet (a Developer needs a coding run)',
  NO_TEAMMATE_FOR_ROLE: 'the workspace has no teammate for that role who is switched on',
  TEAMMATE_CANNOT_DRAFT: 'no teammate for that role who is switched on may write drafts',
  USAGE_LIMIT: 'the workspace is at its plan limit',
  AUTONOMY_OFF: 'the workspace has switched agent autonomy off',
  POLICY_UNAVAILABLE: 'the workspace policy could not be read',
  ASK_FIRST: 'you asked the user a question in the same step; ask first, then hand off in a later step',
  INVALID_BRIEF: 'the handoff had no valid role or no task',
  CHILD_START_FAILED: 'the teammate could not be started',
}

interface ParentRow {
  id: string
  workspace_id: string
  origin: string | null
  origin_depth: number | null
  root_run_id: string | null
  triggered_by: string | null
  ai_team_member_id: string | null
  /** The delegating chat's bound (migration 299); the child inherits it. */
  chat_ceiling: string[] | null
}

interface ParentTeammate {
  id: string
  name: string | null
  role: string | null
  can_delegate_to: string[]
}

/** The workspace's policy, or null when it cannot be read (fail closed). */
async function readPolicyStrict(supabase: SupabaseClient, workspaceId: string): Promise<AgentAutonomyPolicy | null> {
  try {
    const { data, error } = await supabase.from('workspace').select('settings').eq('id', workspaceId).maybeSingle()
    if (error || !data) return null
    return resolveAgentAutonomyPolicyFromSettings((data as { settings?: unknown }).settings ?? null)
  } catch {
    return null
  }
}

async function countRuns(
  supabase: SupabaseClient,
  column: 'parent_run_id' | 'root_run_id',
  value: string,
  workspaceId: string,
): Promise<number | null> {
  const { count, error } = await supabase
    .from('agent_run')
    .select('id', { count: 'exact', head: true })
    .eq(column, value)
    .eq('workspace_id', workspaceId)
  return error ? null : (count ?? 0)
}

async function findChildByKey(
  supabase: SupabaseClient,
  key: string,
  workspaceId: string,
): Promise<{ id: string } | null> {
  const { data } = await supabase
    .from('agent_run')
    .select('id')
    .eq('fire_key', key)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return (data as { id: string } | null) ?? null
}

/** What `planDelegations` decided for one turn's handoffs. */
export interface PlannedDelegations {
  park: DelegationPark
  /** The children to dispatch once the parent is parked (new AND reused ones:
   *  a replay after a crash between the park and the dispatch re-sends them,
   *  and the per-run event id drops the duplicate). */
  childRunIds: string[]
}

/**
 * Decide every handoff in a turn: reuse what a previous pass of the same watch
 * created (by call id), refuse what the policy forbids, create a queued child
 * for the rest. Never dispatches (see the header: the parent parks first).
 * Never throws for a policy refusal; an unexpected error on one call refuses
 * that call (CHILD_START_FAILED), never the whole batch.
 */
export async function planDelegations(
  supabase: SupabaseClient,
  args: {
    parentRunId: string
    workspaceId: string
    requests: DelegationRequest[]
    /** A request_user_input is pending in the same eve batch: every handoff is
     *  refused ASK_FIRST (the question is answered first). */
    alongsideQuestion?: boolean
  },
): Promise<PlannedDelegations> {
  const { parentRunId, workspaceId, requests } = args
  const entries: DelegationParkEntry[] = []
  const childRunIds: string[] = []

  const { data: parentData } = await supabase
    .from('agent_run')
    .select('id, workspace_id, origin, origin_depth, root_run_id, triggered_by, ai_team_member_id, chat_ceiling')
    .eq('id', parentRunId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const parent = parentData as ParentRow | null

  let teammate: ParentTeammate | null = null
  if (parent?.ai_team_member_id) {
    const { data } = await supabase
      .from('ai_team_member')
      .select('id, name, role, can_delegate_to')
      .eq('id', parent.ai_team_member_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (data) {
      const t = data as Record<string, unknown>
      teammate = {
        id: t.id as string,
        name: (t.name as string | null) ?? null,
        role: (t.role as string | null) ?? null,
        can_delegate_to: Array.isArray(t.can_delegate_to) ? (t.can_delegate_to as string[]) : [],
      }
    }
  }

  const rootRunId = parent?.root_run_id ?? parentRunId
  const policy = parent ? await readPolicyStrict(supabase, workspaceId) : null
  let childCount = parent ? await countRuns(supabase, 'parent_run_id', parentRunId, workspaceId) : null
  let rootCount = parent ? await countRuns(supabase, 'root_run_id', rootRunId, workspaceId) : null
  let usageChecked: boolean | null = null

  const refuse = async (req: DelegationRequest, code: DelegationRefusalCode, targetId: string | null = null) => {
    const reason = REFUSAL_TEXT[code]
    entries.push({
      requestId: req.requestId,
      callId: req.callId,
      approveOptionId: req.approveOptionId,
      role: req.input?.role ?? req.rawRole,
      childRunId: null,
      refused: { code, reason },
    })
    if (parent) await recordRefusal(supabase, { parent, req, code, reason, targetId })
  }

  for (const req of requests) {
    const key = delegationKey(parentRunId, req.callId)

    // A previous pass of this watch already created this call's child.
    const existing = await findChildByKey(supabase, key, workspaceId)
    if (existing) {
      entries.push({
        requestId: req.requestId,
        callId: req.callId,
        approveOptionId: req.approveOptionId,
        role: req.input?.role ?? req.rawRole,
        childRunId: existing.id,
      })
      childRunIds.push(existing.id)
      continue
    }
    // …or already refused it (its skipped ledger row carries the code).
    const refusedBefore = await findWork(supabase, { kind: WORK_KINDS.workRun, runKey: key })
    const priorRefusal = (refusedBefore?.progress as { delegation_refusal?: { code?: DelegationRefusalCode; reason?: string } } | undefined)
      ?.delegation_refusal
    if (refusedBefore && priorRefusal?.code) {
      entries.push({
        requestId: req.requestId,
        callId: req.callId,
        approveOptionId: req.approveOptionId,
        role: req.input?.role ?? req.rawRole,
        childRunId: null,
        refused: { code: priorRefusal.code, reason: priorRefusal.reason ?? REFUSAL_TEXT[priorRefusal.code] },
      })
      continue
    }

    if (!parent) {
      await refuse(req, 'CHILD_START_FAILED')
      continue
    }
    const input = req.input
    if (!input) {
      await refuse(req, 'INVALID_BRIEF')
      continue
    }
    if (args.alongsideQuestion) {
      await refuse(req, 'ASK_FIRST')
      continue
    }
    if (!policy) {
      await refuse(req, 'POLICY_UNAVAILABLE')
      continue
    }
    if (policy.mode === 'off') {
      await refuse(req, 'AUTONOMY_OFF')
      continue
    }
    if (!DELEGABLE_WORK_ROLES.includes(input.role)) {
      await refuse(req, 'DELEGATION_ROLE_UNSUPPORTED')
      continue
    }
    const childDepth = (parent.origin_depth ?? 0) + 1
    if (childDepth > policy.max_delegation_depth) {
      await refuse(req, 'DELEGATION_DEPTH')
      continue
    }
    if (childCount === null || rootCount === null) {
      await refuse(req, 'POLICY_UNAVAILABLE')
      continue
    }
    if (childCount >= policy.max_fan_out) {
      await refuse(req, 'DELEGATION_FAN_OUT')
      continue
    }
    if (rootCount >= policy.max_attempts_per_root) {
      await refuse(req, 'ROOT_BUDGET')
      continue
    }
    if (!teammate || !teammate.can_delegate_to.includes(input.role)) {
      await refuse(req, 'DELEGATION_NOT_ALLOWED')
      continue
    }
    // A handoff runs on the drafting ceiling narrowed to its teammate, so it
    // goes to a holder that may draft (the same routing as chat's admission).
    const routed = await resolveRoleTeammate(supabase, { workspaceId, role: input.role, purpose: 'delegate', requestingUserId: parent.triggered_by })
    if ('error' in routed) {
      await refuse(req, 'POLICY_UNAVAILABLE')
      continue
    }
    if (!routed.teammate) {
      await refuse(req, routed.reason === 'teammate_cannot_draft' ? 'TEAMMATE_CANNOT_DRAFT' : 'NO_TEAMMATE_FOR_ROLE')
      continue
    }
    if (usageChecked === null) usageChecked = await usageAllows(supabase, parent.triggered_by)
    if (!usageChecked) {
      await refuse(req, 'USAGE_LIMIT', routed.teammate.id)
      continue
    }

    const child = await createChild(supabase, {
      parent,
      rootRunId,
      key,
      input,
      targetId: routed.teammate.id,
      from: { name: teammate.name, role: teammate.role },
    })
    if (!child) {
      await refuse(req, 'CHILD_START_FAILED', routed.teammate.id)
      continue
    }
    childCount += 1
    rootCount += 1
    entries.push({
      requestId: req.requestId,
      callId: req.callId,
      approveOptionId: req.approveOptionId,
      role: input.role,
      childRunId: child,
    })
    childRunIds.push(child)
  }

  return { park: { kind: 'delegation', children: entries, askedAt: new Date().toISOString() }, childRunIds }
}

/**
 * The plan meter for the run-as user. FAIL CLOSED, like the attempt gate.
 * Opted in to the ChatGPT free tier: a child is a work run, and a work run
 * for a person on their own ChatGPT plan runs on it (run-work-spec-rebuild.ts).
 */
async function usageAllows(supabase: SupabaseClient, userId: string | null): Promise<boolean> {
  if (!userId) return false
  try {
    const { data, error } = await supabase.rpc('check_ai_usage_limit', { p_user_id: userId, p_chatgpt_plan: true })
    if (error) return false
    const row = Array.isArray(data) ? (data[0] as { allowed?: boolean } | undefined) : undefined
    return row?.allowed === true
  } catch {
    return false
  }
}

/** Insert the queued child run and its ledger row. The child's id, or null. */
async function createChild(
  supabase: SupabaseClient,
  args: {
    parent: ParentRow
    rootRunId: string
    key: string
    input: DelegationInput
    targetId: string
    from: { name: string | null; role: string | null }
  },
): Promise<string | null> {
  const { parent, input } = args
  const taskPrompt = renderDelegationTask(input, args.from)
  const resources = await snapshotResources(supabase, input.resources, parent.workspace_id, parent.triggered_by)
  const expects = input.expects ?? [...DEFAULT_EXPECTS_BY_ROLE[input.role]]
  // Work under a chat-delegated root stays inside what that chat could call.
  const chatCeiling = chatCeilingForChild(parent)
  const row = {
    workspace_id: parent.workspace_id,
    kind: 'workspace',
    status: 'queued',
    task_prompt: taskPrompt,
    resources,
    triggered_by: parent.triggered_by,
    origin: 'delegation',
    origin_depth: (parent.origin_depth ?? 0) + 1,
    parent_run_id: parent.id,
    root_run_id: args.rootRunId,
    ai_team_member_id: args.targetId,
    fire_key: args.key,
    expects,
    ...(chatCeiling ? { chat_ceiling: chatCeiling } : {}),
  }
  let childId: string | null = null
  try {
    const { data, error } = await supabase.from('agent_run').insert(row).select('id').single()
    if (!error && data) childId = (data as { id: string }).id
    else if ((error as { code?: string } | null)?.code === '23505') {
      childId = (await findChildByKey(supabase, args.key, parent.workspace_id))?.id ?? null
    } else {
      console.error('[delegation] child insert failed:', error?.message)
    }
  } catch (err) {
    console.error('[delegation] child insert threw:', err instanceof Error ? err.message : err)
  }
  if (!childId) return null
  await ensureWorkForAgentRun(supabase, {
    id: childId,
    workspace_id: parent.workspace_id,
    kind: 'workspace',
    status: 'queued',
    triggered_by: parent.triggered_by,
    task_prompt: taskPrompt,
    origin: 'delegation',
    ai_team_member_id: args.targetId,
    parent_run_id: parent.id,
  })
  return childId
}

/** A refused handoff as a `skipped` ledger row under the parent's row, so the
 *  surface shows it and a replayed watch finds the refusal by call id. */
async function recordRefusal(
  supabase: SupabaseClient,
  args: { parent: ParentRow; req: DelegationRequest; code: DelegationRefusalCode; reason: string; targetId: string | null },
): Promise<void> {
  const { parent, req } = args
  const memberId = await resolveMemberId(supabase, parent.workspace_id, parent.triggered_by)
  if (!memberId) return
  const parentWork = await findWork(supabase, { agentRunId: parent.id })
  const role = req.input?.role ?? req.rawRole
  const task = req.input?.task.split('\n')[0]?.trim() ?? ''
  await startWork(supabase, {
    workspaceId: parent.workspace_id,
    memberId,
    kind: WORK_KINDS.workRun,
    title: task ? task.slice(0, 120) : `Handoff to ${roleLabel(role) || 'a teammate'}`,
    actor: 'agent',
    status: 'skipped',
    skipReason: `Handoff refused: ${args.reason}`,
    runKey: delegationKey(parent.id, req.callId),
    origin: 'delegation',
    progress: { delegation_refusal: { code: args.code, reason: args.reason }, role },
    ...(args.targetId ? { aiTeamMemberId: args.targetId } : {}),
    ...(parentWork
      ? { parentId: parentWork.id, rootId: parentWork.root_id ?? parentWork.id, depth: (parentWork.depth ?? 0) + 1 }
      : {}),
    source: { agent_run_id: parent.id },
    quiet: true,
  })
}

/** The dispatch sender (inngest.send); injectable for tests. */
export type DelegationSend = (payload: { id: string; name: string; data: Record<string, unknown> }) => Promise<unknown>

/**
 * Dispatch the parked parent's children (after the park took). A child whose
 * dispatch fails is failed, and its settle tells the parent, so the parent is
 * never left waiting on a child nobody runs.
 */
export async function dispatchDelegatedChildren(
  supabase: SupabaseClient,
  args: { workspaceId: string; childRunIds: string[] },
  deps: { send?: DelegationSend } = {},
): Promise<void> {
  const send: DelegationSend = deps.send ?? ((p) => inngest.send(p as never))
  for (const id of args.childRunIds) {
    try {
      await send({
        id: workRunDispatchEventId(id),
        name: 'work/run.requested',
        data: { agent_run_id: id, workspace_id: args.workspaceId },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const { data } = await supabase
        .from('agent_run')
        .update({ status: 'failed', error_message: `could not dispatch the handoff: ${message}`, finished_at: new Date().toISOString() })
        .eq('id', id)
        .eq('workspace_id', args.workspaceId)
        .eq('status', 'queued')
        .select('id')
      if (data && data.length > 0) await emitChildSettled(supabase, { childRunId: id, workspaceId: args.workspaceId }, deps)
    }
  }
}

/**
 * Tell a delegated child's parent that the child settled. Called at every
 * terminal write of a work run; a no-op for a run with no parent. Best-effort:
 * never throws (the child's own settle already stands).
 */
export async function emitChildSettled(
  supabase: SupabaseClient,
  ref: { childRunId: string; workspaceId: string },
  deps: { send?: DelegationSend } = {},
): Promise<void> {
  try {
    const { data } = await supabase
      .from('agent_run')
      .select('parent_run_id')
      .eq('id', ref.childRunId)
      .eq('workspace_id', ref.workspaceId)
      .maybeSingle()
    const parentRunId = (data as { parent_run_id?: string | null } | null)?.parent_run_id ?? null
    if (!parentRunId) return
    const send: DelegationSend = deps.send ?? ((p) => inngest.send(p as never))
    await send({
      id: `child-settled:${ref.childRunId}`,
      name: CHILD_SETTLED_EVENT,
      data: { agent_run_id: parentRunId, child_run_id: ref.childRunId, workspace_id: ref.workspaceId },
    })
  } catch (err) {
    console.error('[delegation] child_settled emit failed:', ref.childRunId, err instanceof Error ? err.message : err)
  }
}

/** How long a park whose children have all settled may wait for its
 *  child-settled event before the sweep re-sends it. */
export const DELEGATION_SWEEP_GRACE_MS = 10 * 60_000

/**
 * The backstop for a lost child-settled event. `emitChildSettled` is
 * best-effort (a child's own settle must never fail on it), so a failed send
 * would leave the parent parked on children that have all finished, and the
 * stale-run reaper never selects a parked run. Every reaper tick, a parent
 * still parked on children that ALL settled more than the grace period ago
 * gets the event again. The release is a CAS from needs_input, so a duplicate
 * is a no-op; the event id is bucketed per tick so a re-send is not dropped as
 * the original's duplicate. Returns how many parents it nudged.
 */
export async function sweepSettledDelegationParks(
  supabase: SupabaseClient,
  now = Date.now(),
  deps: { send?: DelegationSend } = {},
): Promise<number> {
  const { data, error } = await supabase
    .from('agent_run')
    .select('id, workspace_id, pending_input')
    .eq('kind', 'workspace')
    .eq('status', 'needs_input')
    .eq('pending_input->>kind', 'delegation')
    .limit(50)
  if (error || !data) return 0
  const send: DelegationSend = deps.send ?? ((p) => inngest.send(p as never))
  const bucket = Math.floor(now / (15 * 60_000))
  let nudged = 0
  for (const row of data as Array<{ id: string; workspace_id: string; pending_input: unknown }>) {
    const park = row.pending_input as DelegationPark
    const ids = park.children.map((c) => c.childRunId).filter((id): id is string => !!id)
    if (ids.length === 0) continue
    const { data: kids, error: kidsError } = await supabase
      .from('agent_run')
      .select('id, status, finished_at')
      .in('id', ids)
      .eq('workspace_id', row.workspace_id)
    if (kidsError || !kids || kids.length < ids.length) continue
    const rows = kids as Array<{ id: string; status: string; finished_at: string | null }>
    if (!rows.every((k) => TERMINAL.includes(k.status))) continue
    const lastSettled = Math.max(...rows.map((k) => (k.finished_at ? Date.parse(k.finished_at) : 0)))
    if (Number.isFinite(lastSettled) && now - lastSettled < DELEGATION_SWEEP_GRACE_MS) continue
    try {
      await send({
        id: `child-settled-sweep:${row.id}:${bucket}`,
        name: CHILD_SETTLED_EVENT,
        data: { agent_run_id: row.id, child_run_id: ids[ids.length - 1], workspace_id: row.workspace_id },
      })
      nudged += 1
    } catch (err) {
      console.error('[delegation] sweep send failed:', row.id, err instanceof Error ? err.message : err)
    }
  }
  return nudged
}

/** Are all of a park's children terminal? Null when they cannot be read. */
export async function delegationChildrenSettled(
  supabase: SupabaseClient,
  park: DelegationPark,
  workspaceId: string,
): Promise<boolean | null> {
  const ids = park.children.map((c) => c.childRunId).filter((id): id is string => !!id)
  if (ids.length === 0) return true
  const { data, error } = await supabase.from('agent_run').select('id, status').in('id', ids).eq('workspace_id', workspaceId)
  if (error || !data) return null
  const rows = data as Array<{ id: string; status: string }>
  if (rows.length < ids.length) return false
  return rows.every((r) => TERMINAL.includes(r.status))
}

/** What a `delegate_work` call returns to the model once its handoff settled. */
export interface DelegationResult {
  type: 'delegation_result'
  status: 'completed' | 'failed' | 'canceled' | 'refused' | 'running' | 'unknown'
  role: string
  /** "Researcher finished: 1 document". */
  header: string
  child_run_id?: string
  teammate?: string | null
  summary?: string | null
  deliverables?: WorkDeliverable[]
  expects_met?: boolean
  unmet?: string[]
  refusal?: { code: DelegationRefusalCode; reason: string }
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function deliverableCounts(list: WorkDeliverable[]): string {
  const counts = new Map<string, number>()
  for (const d of list) {
    const key = d.type === 'entity' && d.entity_type ? d.entity_type : d.type
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const nouns: Record<string, [string, string]> = {
    document: ['document', 'documents'],
    email_draft: ['email draft', 'email drafts'],
    action: ['action', 'actions'],
  }
  return [...counts.entries()]
    .map(([k, n]) => plural(n, nouns[k]?.[0] ?? k, nouns[k]?.[1] ?? k))
    .join(', ')
}

/**
 * The result of one `delegate_work` call, looked up by its call id: the child's
 * settled outcome (with its deliverables checked against what it was asked to
 * hand back), or the refusal recorded for it.
 */
export async function buildDelegationResult(
  supabase: SupabaseClient,
  args: { parentRunId: string; workspaceId: string; callId: string },
): Promise<DelegationResult> {
  const key = delegationKey(args.parentRunId, args.callId)
  const { data: childData } = await supabase
    .from('agent_run')
    .select('id, status, result_summary, error_message, deliverables, expects, ai_team_member_id, teammate:ai_team_member_id(name, role)')
    .eq('fire_key', key)
    .eq('workspace_id', args.workspaceId)
    .eq('parent_run_id', args.parentRunId)
    .maybeSingle()
  if (childData) {
    const child = childData as Record<string, unknown>
    const mate = (Array.isArray(child.teammate) ? child.teammate[0] : child.teammate) as { name?: string; role?: string } | null
    const role = mate?.role ?? ''
    const who = mate?.name || (role ? roleLabel(role) : 'The teammate')
    const status = child.status as string
    if (!TERMINAL.includes(status)) {
      return { type: 'delegation_result', status: 'running', role, header: `${who} is still working on it`, child_run_id: child.id as string, teammate: mate?.name ?? null }
    }
    const deliverables = (Array.isArray(child.deliverables) ? child.deliverables : []) as WorkDeliverable[]
    if (status === 'completed' || status === 'pr_open') {
      const expects = normalizeWorkExpects(child.expects)
      const { met, unmet } = evaluateExpects(expects, deliverables)
      return {
        type: 'delegation_result',
        status: 'completed',
        role,
        header: `${who} finished${deliverables.length > 0 ? `: ${deliverableCounts(deliverables)}` : ' with a summary only'}`,
        child_run_id: child.id as string,
        teammate: mate?.name ?? null,
        summary: (child.result_summary as string | null) ?? null,
        deliverables,
        expects_met: met,
        unmet,
      }
    }
    return {
      type: 'delegation_result',
      status: status === 'canceled' ? 'canceled' : 'failed',
      role,
      header: `${who} ${status === 'canceled' ? 'was stopped' : 'could not finish'}`,
      child_run_id: child.id as string,
      teammate: mate?.name ?? null,
      summary: (child.error_message as string | null) ?? null,
      deliverables,
      expects_met: false,
      unmet: [],
    }
  }
  const refused = await findWork(supabase, { kind: WORK_KINDS.workRun, runKey: key })
  const progress = (refused?.progress ?? {}) as { delegation_refusal?: { code?: DelegationRefusalCode; reason?: string }; role?: string }
  const refusal = progress.delegation_refusal
  if (refused && refusal?.code) {
    const role = typeof progress.role === 'string' ? progress.role : ''
    return {
      type: 'delegation_result',
      status: 'refused',
      role,
      header: `Handoff to ${roleLabel(role) || 'that teammate'} refused`,
      refusal: { code: refusal.code, reason: refusal.reason ?? REFUSAL_TEXT[refusal.code] },
    }
  }
  return { type: 'delegation_result', status: 'unknown', role: '', header: 'No record of this handoff' }
}
