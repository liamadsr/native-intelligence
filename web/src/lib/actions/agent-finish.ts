/**
 * When an agent finishes an action, the action goes to REVIEW, not Done; the
 * person marks it Done (Liam, 2026-10-14: decision 9 and A4 slice 7). This is
 * the one path for both halves:
 *
 *   - moveActionToReview: an agent finished the work. Every path that used to
 *     complete an action on an agent's finish comes here: a work run's
 *     finish_work settle (delegated actions and a For you Start alike,
 *     outcome/route.ts settleWorkRun) and a work run completing its own
 *     tracked action through complete_action / update_action (the action
 *     tools' `reviewActionIds`). A coding run already works this way: it ends
 *     at pr_open and the merge closes it.
 *   - completeActionOnReview: the person's Reviewed on the job (the ledger's
 *     review verbs, resolve.ts settleWorkReview) marks the action Done.
 *
 * Workflow states have no "review" category (migration 020: backlog,
 * unstarted, started, completed, canceled), so review is a STATE choice:
 *   1. a STARTED state of the team whose name reads like review ("In Review",
 *      "Needs review"), unless the action already sits in a later started
 *      state (never backwards);
 *   2. otherwise the action stays where it is when that is already a started
 *      state;
 *   3. otherwise (it never left Backlog / Todo) the team's first started state.
 * An action already completed or canceled is left alone: a person closed it.
 * The ledger's needs_review row raises the review card either way.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { emitStatusChange } from '@/lib/flows/emit-status-change'
import type { StatusChangeOrigin } from '@/lib/flows/types'
import { createNotification } from '@/lib/notifications'
import { trackServerEvent } from '@/lib/posthog'

export interface TeamState {
  id: string
  name: string | null
  category: string | null
  sort_order?: number | null
}

const REVIEW_NAME = /\breview/i
const CLOSED = new Set(['completed', 'canceled'])

function byOrder(a: TeamState, b: TeamState): number {
  return (a.sort_order ?? 0) - (b.sort_order ?? 0)
}

/**
 * The state an agent-finished action moves to, or null to leave it where it
 * is. Pure (the rules above).
 */
export function reviewStateFor(states: readonly TeamState[], currentStatusId: string | null): string | null {
  const ordered = [...states].sort(byOrder)
  const current = ordered.find((s) => s.id === currentStatusId) ?? null
  if (current && CLOSED.has(current.category ?? '')) return null
  // Only a started state reads as review: "Reviewed" in the completed
  // category is Done by another name, and a backlog state named so isn't one.
  const review = ordered.find((s) => REVIEW_NAME.test(s.name ?? '') && s.category === 'started')
  if (review) {
    if (review.id === currentStatusId) return null
    // Never backwards: an action already in a later started state (say
    // "QA" after "In Review") stays where a person put it.
    if (current?.category === 'started' && (current.sort_order ?? 0) > (review.sort_order ?? 0)) return null
    return review.id
  }
  if (current?.category === 'started') return null
  const started = ordered.find((s) => s.category === 'started')
  return started && started.id !== currentStatusId ? started.id : null
}

/** The team's first completed state, or null. Pure. */
export function doneStateFor(states: readonly TeamState[]): string | null {
  return [...states].sort(byOrder).find((s) => s.category === 'completed')?.id ?? null
}

interface ActionRow {
  id: string
  team_id: string | null
  status_id: string | null
  identifier?: string | null
  title?: string | null
}

async function loadAction(supabase: SupabaseClient, actionId: string, workspaceId: string): Promise<ActionRow | null> {
  const { data } = await supabase
    .from('actions')
    .select('id, team_id, status_id, identifier, title')
    .eq('id', actionId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return (data as ActionRow | null) ?? null
}

async function loadTeamStates(supabase: SupabaseClient, teamId: string | null): Promise<TeamState[]> {
  if (!teamId) return []
  const { data } = await supabase
    .from('workflow_state')
    .select('id, name, category, sort_order')
    .eq('team_id', teamId)
    .order('sort_order', { ascending: true })
  return (data ?? []) as TeamState[]
}

export interface ReviewMoveResult {
  /** The action was found in the workspace. */
  found: boolean
  /** The state it moved to, or null when it stayed where it was. */
  movedTo: string | null
}

/**
 * An agent finished the action: move it to review (reviewStateFor). Never to
 * a completed state. `resetRunStatus` also sets its agent_run_status back to
 * idle: only the run's terminal settle (settleWorkRun) passes it; an in-run
 * complete_action / update_action only moves the state, since the run is
 * still going. `actor` is who the status write is for the flow dispatcher's
 * loop guard (the run's person and the agent origin). Never throws.
 */
export async function moveActionToReview(
  supabase: SupabaseClient,
  args: {
    actionId: string
    workspaceId: string
    actor?: { userId: string; origin: StatusChangeOrigin } | null
    resetRunStatus?: boolean
  },
): Promise<ReviewMoveResult> {
  try {
    const action = await loadAction(supabase, args.actionId, args.workspaceId)
    if (!action) return { found: false, movedTo: null }
    const states = await loadTeamStates(supabase, action.team_id)
    const movedTo = reviewStateFor(states, action.status_id)
    const patch: Record<string, unknown> = {}
    if (args.resetRunStatus) patch.agent_run_status = 'idle'
    if (movedTo) patch.status_id = movedTo
    if (Object.keys(patch).length > 0) {
      await supabase.from('actions').update(patch).eq('id', action.id).eq('workspace_id', args.workspaceId)
    }
    if (movedTo && args.actor) {
      emitStatusChange({
        entityType: 'action',
        entityId: action.id,
        workspaceId: args.workspaceId,
        teamId: action.team_id,
        fromStatusId: action.status_id,
        toStatusId: movedTo,
        actorUserId: args.actor.userId,
        origin: args.actor.origin,
      })
    }
    return { found: true, movedTo }
  } catch (err) {
    console.error('[agent-finish] review move failed', err instanceof Error ? err.message : err)
    return { found: false, movedTo: null }
  }
}

/**
 * A coding agent's PR merged: the action its run worked is Done, as the
 * person's merge (the GitHub webhook). Covers the job the person already
 * marked Reviewed before the merge, which no longer waits on the PR, so
 * resolveWorkForDeliverable doesn't reach it. An action already closed is
 * left alone (completeActionOnReview). Never throws; returns how many it
 * completed.
 */
export async function completeActionsForMergedPr(supabase: SupabaseClient, prUrl: string): Promise<number> {
  if (!prUrl) return 0
  try {
    const { data } = await supabase
      .from('agent_run')
      .select('action_id, workspace_id, triggered_by')
      .eq('pr_url', prUrl)
      .eq('kind', 'coding')
      .not('action_id', 'is', null)
      .limit(10)
    let done = 0
    for (const run of (data ?? []) as Array<{ action_id: string | null; workspace_id: string; triggered_by: string | null }>) {
      if (!run.action_id || !run.triggered_by) continue
      if (await completeActionOnReview(supabase, { actionId: run.action_id, workspaceId: run.workspace_id, actorUserId: run.triggered_by })) done++
    }
    return done
  } catch (err) {
    console.error('[agent-finish] merged-PR completion failed', err instanceof Error ? err.message : err)
    return 0
  }
}

/**
 * What the action PATCH route does on a move into Done, for a completion the
 * person made by reviewing: the `action_completed` analytics event, and an
 * `action_status_changed` notice to every assignee but the person. Fail-soft.
 */
async function announceCompletion(
  supabase: SupabaseClient,
  args: { action: ActionRow; workspaceId: string; actorUserId: string; doneState: TeamState | null },
): Promise<void> {
  try {
    trackServerEvent('action_completed', { userId: args.actorUserId, workspaceId: args.workspaceId }, { action_id: args.action.id })
    const [{ data: actor }, { data: seats }] = await Promise.all([
      supabase
        .from('member')
        .select('id, display_name')
        .eq('user_id', args.actorUserId)
        .eq('workspace_id', args.workspaceId)
        .maybeSingle(),
      supabase.from('action_assignee').select('member_id').eq('action_id', args.action.id),
    ])
    const actorRow = actor as { id?: string; display_name?: string | null } | null
    const identifier = args.action.identifier ?? ''
    const title = args.action.title ?? ''
    for (const seat of (seats ?? []) as Array<{ member_id: string }>) {
      if (!seat.member_id || seat.member_id === actorRow?.id) continue
      await createNotification({
        workspaceId: args.workspaceId,
        recipientId: seat.member_id,
        type: 'action_status_changed',
        title: `${actorRow?.display_name || 'Someone'} completed ${identifier}`,
        body: title,
        actorId: actorRow?.id,
        targetType: 'action',
        targetId: args.action.id,
        metadata: {
          action_identifier: identifier,
          new_status: args.doneState?.name ?? null,
          new_category: 'completed',
        },
      })
    }
  } catch (err) {
    console.error('[agent-finish] completion notices failed', err instanceof Error ? err.message : err)
  }
}

/**
 * The person reviewed the agent's work: mark the action Done (the team's
 * first completed state). An action already completed or canceled is left
 * alone. A person's write, so the status change fires flows as one. Never
 * throws; returns the state it moved to, or null.
 */
export async function completeActionOnReview(
  supabase: SupabaseClient,
  args: { actionId: string; workspaceId: string; actorUserId: string },
): Promise<string | null> {
  try {
    const action = await loadAction(supabase, args.actionId, args.workspaceId)
    if (!action) return null
    const states = await loadTeamStates(supabase, action.team_id)
    const current = states.find((s) => s.id === action.status_id)
    if (current && CLOSED.has(current.category ?? '')) return null
    const done = doneStateFor(states)
    if (!done) return null
    await supabase
      .from('actions')
      .update({ status_id: done })
      .eq('id', action.id)
      .eq('workspace_id', args.workspaceId)
    emitStatusChange({
      entityType: 'action',
      entityId: action.id,
      workspaceId: args.workspaceId,
      teamId: action.team_id,
      fromStatusId: action.status_id,
      toStatusId: done,
      actorUserId: args.actorUserId,
    })
    await announceCompletion(supabase, {
      action,
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      doneState: states.find((s) => s.id === done) ?? null,
    })
    return done
  } catch (err) {
    console.error('[agent-finish] review completion failed', err instanceof Error ? err.message : err)
    return null
  }
}
