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
 *
 * A job a person started from a card on their Mac (our own agent's or their
 * own coding agent's) moves its card itself, through moveCardForRun: it
 * begins → out of Backlog / Todo (by category) to the first started state;
 * its pull request opens → review; it merged and no other linked pull
 * request holds the card (linkedPullRequestsHold) → the first done state (completeActionsForMergedPr, the one merge
 * path cloud runs share). Each as the person's agent, never over a move they
 * made by hand since the job began.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { emitStatusChange } from '@/lib/flows/emit-status-change'
import type { StatusChangeOrigin } from '@/lib/flows/types'
import { createNotification } from '@/lib/notifications'
import { trackServerEvent } from '@/lib/posthog'
import { agentWriterFor } from './agent-writer'
import { readPrState } from '@/lib/github/pr-metadata'

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

/** The workflow categories of a card nobody has started: Backlog and Todo (migration 020). */
const NOT_STARTED = new Set(['backlog', 'unstarted'])

/**
 * A job began on the card: the team's first started state when the card sits
 * in a not-started state (by CATEGORY, never by name), else null (it is
 * already started, closed, or the team has no started state). Pure.
 */
export function beginStateFor(states: readonly TeamState[], currentStatusId: string | null): string | null {
  const ordered = [...states].sort(byOrder)
  const current = ordered.find((s) => s.id === currentStatusId) ?? null
  // A card with no state counts as not started; one in a state the team doesn't have is left alone.
  if (currentStatusId && !current) return null
  if (current && !NOT_STARTED.has(current.category ?? '')) return null
  return ordered.find((s) => s.category === 'started')?.id ?? null
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

// ── A person's own agent run moves its card ──────────────────────────────────

/**
 * What a run did to its card: it `begin`s (the job started), it opened a pull
 * request (`review`), or every pull request linked to the card merged
 * (`done`).
 */
export type CardMove = 'begin' | 'review' | 'done'

/** The run that moves the card: whose it is, its id, and when it began (the Start). */
export interface CardRun {
  userId: string
  /** The run's id, for the flow ledger (a Mac job's session id). */
  id: string
  /** When the run began: a move by hand at or after it stops the run's own moves. */
  beganAt: string
  /**
   * The automated hops before the run began (the flow loop guard's depth):
   * the move is one more. A card's Mac job is started only by a person (their
   * Start, or settle_card in their own chat, which no unattended run holds),
   * so it is 0 today and nothing stores another; a start that comes from a
   * loop must pass its own.
   */
  startDepth?: number
}

/**
 * A person moved the card by hand since `since`: a member's status change in
 * the activity log (entity_activity, migration 488; a run's own moves are an
 * agent's, a webhook's the system's). A log it can't read counts as moved:
 * the card stays where the person may have put it.
 */
export async function movedByHandSince(supabase: SupabaseClient, actionId: string, since: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('entity_activity')
      .select('id')
      .eq('entity_type', 'action')
      .eq('entity_id', actionId)
      .eq('action', 'status_changed')
      .eq('actor_kind', 'member')
      .gte('created_at', since)
      .limit(1)
    if (error) return true
    return ((data ?? []) as unknown[]).length > 0
  } catch {
    return true
  }
}

/** Where a move takes the card from where it is, or null to leave it. Pure. */
export function cardMoveTarget(move: CardMove, states: readonly TeamState[], currentStatusId: string | null): string | null {
  if (move === 'begin') return beginStateFor(states, currentStatusId)
  if (move === 'review') return reviewStateFor(states, currentStatusId)
  const current = states.find((s) => s.id === currentStatusId)
  if (current && CLOSED.has(current.category ?? '')) return null
  const done = doneStateFor(states)
  return done && done !== currentStatusId ? done : null
}

export interface CardMoveDeps {
  /** The client the move is written through (default: the person's agent, agent-writer.ts). */
  writer?: SupabaseClient
}

/**
 * Move a card as the person's own agent run (a job they started from the
 * card on their Mac): to the team's first started state when it begins, to
 * review when its pull request opens, to the first done state when every
 * linked pull request merged. Recorded as their agent's move (the activity
 * log's actor, agent-writer.ts; the flow dispatcher's agent origin, so a
 * loop doesn't fire on it unless it opted in). Skipped when the person moved
 * the card by hand since the run began, and written only while the card is
 * still where it was read (a hand move in between wins). An ordinary status
 * change, so a person moves it back the way they move any card. Never
 * throws; returns the state it moved to, or null.
 */
export async function moveCardForRun(
  supabase: SupabaseClient,
  args: { actionId: string; workspaceId: string; move: CardMove; run: CardRun },
  deps: CardMoveDeps = {},
): Promise<string | null> {
  try {
    const action = await loadAction(supabase, args.actionId, args.workspaceId)
    if (!action) return null
    const states = await loadTeamStates(supabase, action.team_id)
    const target = cardMoveTarget(args.move, states, action.status_id)
    if (!target) return null
    if (await movedByHandSince(supabase, action.id, args.run.beganAt)) return null
    const writer = deps.writer ?? agentWriterFor(args.run.userId)
    let write = writer.from('actions').update({ status_id: target }).eq('id', action.id).eq('workspace_id', args.workspaceId)
    write = action.status_id ? write.eq('status_id', action.status_id) : write.is('status_id', null)
    const { data, error } = await write.select('id')
    if (error) {
      console.warn('[agent-finish] the run’s card move failed:', error.message)
      return null
    }
    if (((data ?? []) as unknown[]).length === 0) return null
    emitStatusChange({
      entityType: 'action',
      entityId: action.id,
      workspaceId: args.workspaceId,
      teamId: action.team_id,
      fromStatusId: action.status_id,
      toStatusId: target,
      actorUserId: args.run.userId,
      // One hop past the start (a person's Start: 1).
      origin: { actor: 'agent', depth: (args.run.startDepth ?? 0) + 1, run_id: args.run.id },
    })
    if (args.move === 'done') {
      await announceCompletion(supabase, {
        action,
        workspaceId: args.workspaceId,
        actorUserId: args.run.userId,
        doneState: states.find((s) => s.id === target) ?? null,
      })
    }
    return target
  } catch (err) {
    console.error('[agent-finish] the run’s card move failed', err instanceof Error ? err.message : err)
    return null
  }
}

/** At most this many other linked pull requests are read from GitHub when a merge would close a card, each within this. */
export const HOLD_READS_MAX = 5
export const HOLD_READ_TIMEOUT_MS = 4_000

/**
 * Whether another pull request linked to the card still holds it back, when
 * a merge would close it. Decided from the PRESENT state, not from what the
 * row remembers (a link made by hand may have been synced once at link time
 * in a repository that sends us no events, or never):
 *   - our table says merged or closed: it doesn't hold (a closed one that
 *     never merged was abandoned);
 *   - one of OUR runs or Mac jobs opened it (agent_run.pr_url,
 *     local_agent_session.pr_url): it holds until its own webhook says it
 *     merged or closed;
 *   - any other our table still shows open (a teammate's that names the card,
 *     a link made by hand): its state is read again from GitHub with the
 *     person's sign-in, at most HOLD_READS_MAX of them, in parallel,
 *     HOLD_READ_TIMEOUT_MS each:
 *       truly open (or a draft): it holds;
 *       merged or closed: the row is updated, and it doesn't hold;
 *       never knowable (no GitHub connection, no access, not found): it
 *         doesn't hold, as before links held cards at all;
 *       a passing failure (a rate limit, GitHub's own error, a timeout): it
 *         holds, and the next merge or the webhook decides;
 *     past HOLD_READS_MAX such links, the rest hold.
 * Which pull requests a card is linked to (a teammate's that names it holds
 * it, as in other trackers) is the linking rule's business, not this one's.
 * A table it can't read holds the card.
 */
async function linkedPullRequestsHold(supabase: SupabaseClient, actionId: string, workspaceId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('action_github_pr')
    .select('id, pr_url, repo_full_name, pr_number, pr_state')
    .eq('action_id', actionId)
    .eq('workspace_id', workspaceId)
  if (error) return true
  type Link = { id: string; pr_url?: string | null; repo_full_name?: string | null; pr_number?: number | null; pr_state?: string | null }
  const pending = ((data ?? []) as Link[]).filter((r) => r.pr_state !== 'merged' && r.pr_state !== 'closed')
  if (pending.length === 0) return false
  const urls = pending.map((r) => r.pr_url).filter((u): u is string => typeof u === 'string' && !!u)
  const ours = new Set<string>()
  if (urls.length > 0) {
    const [runs, jobs] = await Promise.all([
      supabase.from('agent_run').select('pr_url').eq('workspace_id', workspaceId).in('pr_url', urls),
      supabase.from('local_agent_session').select('pr_url').eq('workspace_id', workspaceId).in('pr_url', urls),
    ])
    if (runs.error || jobs.error) return true
    for (const r of [...((runs.data ?? []) as Array<{ pr_url?: string | null }>), ...((jobs.data ?? []) as Array<{ pr_url?: string | null }>)]) {
      if (r.pr_url) ours.add(r.pr_url)
    }
  }
  if (pending.some((r) => r.pr_url && ours.has(r.pr_url))) return true
  // Everything left is someone else's (a teammate's, or linked by hand): read its present state.
  const others = pending
  const read = others.slice(0, HOLD_READS_MAX)
  const states = await Promise.all(
    read.map(async (link) => {
      if (!link.repo_full_name || typeof link.pr_number !== 'number') return { link, read: { ok: false as const, why: 'unknowable' as const } }
      return {
        link,
        read: await readPrState(supabase, link.repo_full_name, link.pr_number, userId, { requireToken: true, timeoutMs: HOLD_READ_TIMEOUT_MS }),
      }
    }),
  )
  let holds = others.length > HOLD_READS_MAX
  for (const { link, read: r } of states) {
    if (!r.ok) {
      if (r.why === 'passing') holds = true
      continue
    }
    if (r.meta.state === 'merged' || r.meta.state === 'closed') {
      if (!link.id) continue
      const { error: updateError } = await supabase
        .from('action_github_pr')
        .update({ pr_state: r.meta.state, pr_draft: r.meta.draft === true, last_synced_at: new Date().toISOString() })
        .eq('id', link.id)
      if (updateError) console.warn('[agent-finish] storing a linked pull request’s state failed:', updateError.message)
      continue
    }
    holds = true
  }
  return holds
}

/** A card's Mac job key (store.ts actionIdOfJobKey; repeated so this module stays light). */
const MAC_CARD_JOB_RE = /^local-agent-action:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):start:/i

/**
 * A pull request merged (the GitHub webhook, or a Mac job's pull request
 * found merged when it was recorded): the card a person's agent run worked is
 * Done, once no other linked pull request holds it (linkedPullRequestsHold).
 * The one path for both runs:
 *   - a cloud coding run (agent_run.pr_url): Done as the person's merge
 *     (completeActionOnReview), including when they marked the job Reviewed
 *     before the merge, which no longer waits on the PR, so
 *     resolveWorkForDeliverable doesn't reach it;
 *   - a job started from the card on the person's Mac (local_agent_session
 *     .pr_url, a card's key): Done as their agent's move (moveCardForRun),
 *     unless they moved the card by hand since the job began.
 * An action already closed is left alone. Never throws; returns how many it
 * completed.
 */
export async function completeActionsForMergedPr(supabase: SupabaseClient, prUrl: string, deps: CardMoveDeps = {}): Promise<number> {
  if (!prUrl) return 0
  try {
    const [cloud, mac] = await Promise.all([
      supabase
        .from('agent_run')
        .select('action_id, workspace_id, triggered_by')
        .eq('pr_url', prUrl)
        .eq('kind', 'coding')
        .not('action_id', 'is', null)
        .limit(10),
      supabase
        .from('local_agent_session')
        .select('id, user_id, workspace_id, idempotency_key, created_at')
        .eq('pr_url', prUrl)
        .like('idempotency_key', 'local-agent-action:%')
        .order('created_at', { ascending: false })
        .limit(10),
    ])
    let done = 0
    const seen = new Set<string>()
    for (const run of (cloud.data ?? []) as Array<{ action_id: string | null; workspace_id: string; triggered_by: string | null }>) {
      if (!run.action_id || !run.triggered_by || seen.has(run.action_id)) continue
      seen.add(run.action_id)
      if (await linkedPullRequestsHold(supabase, run.action_id, run.workspace_id, run.triggered_by)) continue
      if (await completeActionOnReview(supabase, { actionId: run.action_id, workspaceId: run.workspace_id, actorUserId: run.triggered_by })) done++
    }
    for (const job of (mac.data ?? []) as Array<{ id: string; user_id: string; workspace_id: string; idempotency_key: string | null; created_at: string }>) {
      const actionId = MAC_CARD_JOB_RE.exec(job.idempotency_key ?? '')?.[1]?.toLowerCase()
      if (!actionId || seen.has(actionId)) continue
      seen.add(actionId)
      if (await linkedPullRequestsHold(supabase, actionId, job.workspace_id, job.user_id)) continue
      const moved = await moveCardForRun(
        supabase,
        { actionId, workspaceId: job.workspace_id, move: 'done', run: { userId: job.user_id, id: job.id, beganAt: job.created_at } },
        deps,
      )
      if (moved) done++
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
