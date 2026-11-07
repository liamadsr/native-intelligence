import type { SupabaseClient } from '@supabase/supabase-js'
import { emitStatusChange } from '@/lib/flows/emit-status-change'

/**
 * Apply one Asana task's REMOTE completion state to the Dial8 action behind it.
 *
 * This is the shared body of the Asana→Dial8 read-back, called from BOTH
 * arrival paths so they cannot drift:
 *   - src/lib/inngest/asana-apply-remote.ts — the webhook fast path (a delivery
 *     told us this specific task changed).
 *   - src/lib/inngest/asana-reconcile.ts — the 6-hourly safety net (Asana
 *     webhooks are AT-MOST-ONCE with no replay, so a dropped delivery would
 *     otherwise be lost forever).
 * Both resolve the link row and re-GET the task themselves (deliveries are
 * compact — they carry no state); everything after that lives here.
 *
 * ── The echo-loop breaker ────────────────────────────────────────────────────
 * Dial8→Asana (asana-echo-status) and Asana→Dial8 (this) are a closed cycle, so
 * SOMETHING has to terminate it. That something is the compare-and-swap on
 * `action_external_task.completed` below: the link row records the last-known
 * provider state, and this function refuses to do any action work unless the
 * remote state actually DIFFERS from it. Concretely:
 *
 *   1. Asana user completes the task → webhook → CAS flips link.completed
 *      false→true (1 row) → we move the action to a completed workflow state and
 *      emitStatusChange.
 *   2. That status change wakes asana-echo-status, which reads the SAME link row
 *      and finds link.completed === write.completed → `already_synced` fast path
 *      → ZERO Asana writes. The cycle ends here.
 *   3. Any later re-delivery of the same event (Asana retries, an overlapping
 *      reconcile sweep) re-runs the CAS, matches 0 rows, and returns
 *      'unchanged' before touching the action. This is the idempotency guard
 *      and the loop breaker in one.
 *
 * CAVEAT, deliberately accepted: if the workspace mapped the `done` bucket to an
 * Asana section, step 2's echo is not completely silent — the fast path is
 * skipped when a section is mapped, so it issues ONE addTaskToSection call (no
 * completion PUT). That move is idempotent on Asana's side and, crucially,
 * cannot feed back to us: our webhook filter is `fields: ['completed']`, so a
 * section move raises no delivery. The cycle still terminates in one hop.
 *
 * ── Why the action is loaded BEFORE the CAS ──────────────────────────────────
 * The CAS is a commitment: once it flips `link.completed`, the link row claims
 * that state forever and the echo's `already_synced` fast path stops it being
 * re-derived. That is correct everywhere except one case — un-completing the
 * task behind a CANCELED action, with no category to read the un-completion by.
 * We refuse to act on that (Asana cannot express cancellation, so it is
 * ambiguous; see step 5), which means committing `completed:false` there strands
 * the link: it now disagrees with the canceled action's true remote state, and
 * the echo only rewrites `completed:true` on the NEXT status change — which for
 * a canceled action may never come.
 *
 * So the action and its category are read first, and that one case returns
 * `canceled_protected` without touching the link row at all. Every other path
 * still CASes before the status write, because that ordering is what makes the
 * emit safe (the echo it wakes must find the link already in sync).
 *
 * ── The two OPTIONAL, JIRA-ONLY refinements ─────────────────────────────────
 * `remoteCompleted` is a boolean because Asana's lifecycle is one. Jira's isn't,
 * and folding it to a boolean HERE — while the echo compares full statuses over
 * there — is what made the loop breaker structurally unable to fire for two real
 * shapes: a reopen into "In Progress" landed the action in the team's DEFAULT
 * (unstarted) state, and a move to "Won't Do" landed it in the team's COMPLETED
 * state. Both then woke the echo with a bucket the issue genuinely contradicted,
 * so it transitioned the issue back and overwrote the user's own choice.
 *
 * The fix is here rather than in the echo, and it is strictly ADDITIVE: two
 * optional arguments the Jira callers pass and the Asana ones do not.
 *   - `remoteHint.category` — the provider's status category for the state just
 *     read. `indeterminate` reopens into the team's `started` state instead of
 *     its default (and, for a team that HAS no started state, declines rather
 *     than approximating — see reopenStartedStateId). ABSENT (Asana) keeps the
 *     default, and so does Jira's own `new`.
 *   - `remoteCanceled` — this done-category status reads as an ABANDONMENT, not
 *     a completion, so the action lands in the team's `canceled` state instead
 *     of its completed one. Asana never sets it: Asana cannot express
 *     cancellation at all (see asanaWriteForBucket).
 *
 * The CAS, the ordering and the terminal-category rules are identical for both
 * providers. ONE rule is not, and the difference is the presence of the hint
 * rather than the provider's name: `canceled_protected`. Un-completing the task
 * behind a canceled action is ambiguous ONLY when nothing says what the task is
 * now, which is Asana's permanent condition and never Jira's — so a hinted
 * caller reopens a canceled action and a hint-less one still refuses. See
 * step 5, and the `canceled_protected` outcome below.
 */

/** The link-row columns this module needs. */
export interface RemoteTaskLink {
  id: string
  action_id: string
  external_id: string
  completed: boolean
}

export type ApplyRemoteOutcome =
  /** CAS matched 0 rows — already at this state. Idempotency + loop breaker. */
  | 'unchanged'
  /** Link row updated; the action needed no status write. */
  | 'link_only'
  /** Action moved into a completed workflow state. */
  | 'completed'
  /**
   * JIRA ONLY. The remote status is done-category but reads as an ABANDONMENT,
   * so the action moved into the team's `canceled` state rather than its
   * completed one. Only reachable when a caller passes `remoteCanceled`.
   */
  | 'canceled'
  /** Action moved back out of completed, to the team's reopen state. */
  | 'reverted'
  /** The Asana task 404'd; the link carries the terminal marker now. */
  | 'task_deleted'
  /**
   * JIRA ONLY. `GET /issue` 404'd, which in Jira means "deleted OR not
   * browsable by this account" — the link carries the RETRYABLE `task_missing`
   * marker rather than the terminal one. See src/lib/tasks/jira-link-marker.ts.
   */
  | 'task_missing'
  /** The link outlived its action (or crossed a workspace) — link row only. */
  | 'action_missing'
  /**
   * The team has no state in the category we need; link row only.
   *
   * The team has no `started` state and Jira reports the issue `indeterminate`
   * (see reopenStartedStateId), or the action carries no team at all. The
   * action is left exactly where its owner put it and the two systems visibly
   * disagree — which beats approximating, because the approximation would be
   * echoed straight back into the customer's Jira as a real transition.
   */
  | 'no_target_state'
  /**
   * ASANA ONLY in practice. The task behind a CANCELED action was un-completed
   * and the caller passed NO `remoteHint`, so the un-completion is ambiguous —
   * "not done" or "not cancelled"? Nothing is written — not even the link row —
   * because Dial8 stays authoritative here and a committed `completed:false`
   * would strand the link (see module docblock). A Jira caller always names the
   * category, so it reopens instead.
   */
  | 'canceled_protected'

export interface ApplyRemoteResult {
  linkId: string
  outcome: ApplyRemoteOutcome
  fromStatusId?: string | null
  toStatusId?: string | null
}

interface ActionRow {
  id: string
  status_id: string | null
  team_id: string | null
  category: string | null
}

/** Unwrap the embedded workflow_state, which PostgREST may hand back as an array. */
function categoryOf(raw: unknown): string | null {
  const embedded = (raw as Record<string, unknown> | null)?.workflow_state
  const state = (Array.isArray(embedded) ? embedded[0] : embedded) as
    | { category?: string | null }
    | null
    | undefined
  return state?.category ?? null
}

async function loadAction(
  supabase: SupabaseClient,
  actionId: string,
  workspaceId: string,
): Promise<ActionRow | null> {
  const { data, error } = await supabase
    .from('actions')
    .select('id, status_id, team_id, workflow_state:workflow_state!status_id(category)')
    .eq('id', actionId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  // A failed read is not "the action is gone": throw so Inngest retries.
  if (error) throw error
  if (!data) return null
  const raw = data as Record<string, unknown>
  return {
    id: raw.id as string,
    status_id: (raw.status_id as string | null) ?? null,
    team_id: (raw.team_id as string | null) ?? null,
    category: categoryOf(raw),
  }
}

/**
 * The team's state in `category` — lowest sort_order when several exist, which
 * is board order: the leftmost "Done" column, the leftmost "Cancelled" one.
 */
async function stateIdForCategory(
  supabase: SupabaseClient,
  teamId: string,
  category: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('workflow_state')
    .select('id')
    .eq('team_id', teamId)
    .eq('category', category)
    .order('sort_order', { ascending: true })
    .limit(1)
    .maybeSingle()
  if (error) throw error
  return (data?.id as string | undefined) ?? null
}

/**
 * Where an un-completed action lands: the team's designated default state
 * (`is_default`, what a brand-new action gets), falling back to the
 * lowest-sorted `unstarted` state for a team whose default was deleted.
 */
async function reopenStateId(supabase: SupabaseClient, teamId: string): Promise<string | null> {
  const { data: preferred, error } = await supabase
    .from('workflow_state')
    .select('id')
    .eq('team_id', teamId)
    .eq('is_default', true)
    .limit(1)
    .maybeSingle()
  if (error) throw error
  if (preferred?.id) return preferred.id as string

  return stateIdForCategory(supabase, teamId, 'unstarted')
}

/**
 * JIRA ONLY (`remoteHint.category === 'indeterminate'`): the team's `started`
 * state, or NULL for a team that has none — which the caller turns into
 * `no_target_state`, writing nothing to the action.
 *
 * DELIBERATELY NO FALLBACK, and this is the asymmetry with the canceled-less
 * fallback in step 4 (which DOES approximate, onto `completed`). The difference
 * is whether the approximation is true:
 *   - a cancellation that lands on `completed` is a truthful landing. The work
 *     really did stop; Dial8 records it as finished rather than abandoned, which
 *     loses a nuance the team's board cannot express anyway. The echo then reads
 *     bucket=done against a done-CATEGORY Jira status and leaves the issue
 *     alone, so the approximation costs one word, not a write.
 *   - a reopen that lands on `is_default` is a LIE. `is_default` is an UNSTARTED
 *     state, so the echo wakes with bucket=not_started against an issue the
 *     customer just moved to `indeterminate`, finds a genuine disagreement, and
 *     transitions their issue back to "To Do" — the exact finding-17 bounce this
 *     whole hint exists to remove, re-created by the fallback meant to soften it.
 * A team with no in-progress column is reachable (migration 020 seeds all five
 * categories, but a state with no actions referencing it can be deleted), so
 * this is a real board and not a theoretical one. Declining leaves Dial8 and
 * Jira visibly disagreeing, which is the honest outcome: the link row still
 * records the provider's state and its label still shows the real status name.
 */
async function reopenStartedStateId(
  supabase: SupabaseClient,
  teamId: string,
): Promise<string | null> {
  return stateIdForCategory(supabase, teamId, 'started')
}

/**
 * The provider's own view of the status it just reported, for the parts a
 * boolean cannot carry. OPTIONAL and additive — see the module docblock.
 */
export interface RemoteStateHint {
  /**
   * Jira's stable statusCategory enum for the CURRENT status. Only the two
   * not-done values are meaningful here (a done-category status is already
   * described by `remoteCompleted`), and it is only consulted on the reopen
   * branch — where its PRESENCE decides that the un-completion is unambiguous
   * (so a canceled action reopens rather than returning `canceled_protected`)
   * and its VALUE decides between the team's started state and its default.
   */
  category: 'new' | 'indeterminate'
}

export async function applyRemoteTaskState(args: {
  /** Service-role client — this runs from Inngest, outside any user session. */
  supabase: SupabaseClient
  workspaceId: string
  /** auth.users id credited for the status change (the sync state's user). */
  actorUserId: string
  link: RemoteTaskLink
  /** `completed` as the provider reports it RIGHT NOW (always from a fresh GET). */
  remoteCompleted: boolean
  /**
   * JIRA ONLY, optional. The status category behind `remoteCompleted:false`.
   * Omitted by every Asana caller, whose lifecycle has nothing to put here.
   */
  remoteHint?: RemoteStateHint
  /**
   * JIRA ONLY, optional. True when the done-category status the provider
   * reports reads as an ABANDONMENT rather than a completion ("Won't Do"). Never
   * set by Asana, which cannot express cancellation.
   */
  remoteCanceled?: boolean
}): Promise<ApplyRemoteResult> {
  const { supabase, workspaceId, actorUserId, link, remoteCompleted } = args

  /**
   * Is this un-completion an UNAMBIGUOUS "the issue is open again"?
   *
   * Only when the caller told us the status category behind it — i.e. a Jira
   * caller. That single bit is the whole difference between the two providers
   * here, and it is why `canceled_protected` is Asana's carve-out rather than a
   * shared rule (see step 5).
   */
  const hintedReopen =
    !remoteCompleted && args.remoteHint !== undefined && args.remoteCanceled !== true

  // ── Step 3a: read the action FIRST, to know whether we may commit at all ──
  const action = await loadAction(supabase, link.action_id, workspaceId)

  // The one case where the link row must NOT move: un-completing the task
  // behind a canceled action WITHOUT a category to read it by. We decline to
  // act on it (step 5), so recording `completed:false` would leave the link
  // permanently disagreeing with the canceled action's own push state, with
  // nothing scheduled to fix it.
  if (action?.category === 'canceled' && !remoteCompleted && !hintedReopen) {
    return { linkId: link.id, outcome: 'canceled_protected' }
  }

  // ── Step 3b: compare-and-swap the link row ───────────────────────────────
  // The `.neq('completed', …)` is the whole guard: it makes this function a
  // no-op for a state we've already applied, which is simultaneously the
  // idempotency key for redelivered events AND the echo-loop breaker (see the
  // module docblock). It stays BEFORE the status write, so the emitStatusChange
  // below always wakes the echo into an already-in-sync link. A real DB error
  // throws so Inngest retries — a swallowed error here would look identical to
  // "already applied" and silently drop the update.
  const { data: claimed, error } = await supabase
    .from('action_external_task')
    .update({ completed: remoteCompleted, last_synced_at: new Date().toISOString() })
    .eq('id', link.id)
    .neq('completed', remoteCompleted)
    .select('id')
  if (error) throw error
  if ((claimed?.length ?? 0) === 0) {
    return { linkId: link.id, outcome: 'unchanged' }
  }

  // The CAS above already recorded the remote state, so a failure from here on
  // must put the link back first: otherwise every retry and reconcile sweep
  // sees "unchanged" and the action never follows the provider.
  const rollBackClaim = async () => {
    const { error: rollbackError } = await supabase
      .from('action_external_task')
      .update({ completed: !remoteCompleted })
      .eq('id', link.id)
      .eq('completed', remoteCompleted)
    if (rollbackError) {
      console.error(`[tasks] link ${link.id} claim rollback failed:`, rollbackError.message)
    }
  }
  const afterClaim = async <T>(work: Promise<T>): Promise<T> => {
    try {
      return await work
    } catch (err) {
      await rollBackClaim()
      throw err
    }
  }

  if (!action) {
    return { linkId: link.id, outcome: 'action_missing' }
  }

  let targetStatusId: string | null = null
  /** Set when the completion we're applying is really a CANCELLATION. */
  let landedCanceled = false

  if (remoteCompleted) {
    // ── Step 4: the task was completed in Asana ───────────────────────────
    // An action already in a TERMINAL category needs no write. 'canceled'
    // counts as terminal: the echo writes completed:true for canceled actions
    // too (Asana has no cancel), so the completion we just observed is very
    // likely our own echo coming back — moving it to 'completed' would silently
    // resurrect work the user cancelled.
    if (action.category === 'completed' || action.category === 'canceled') {
      return { linkId: link.id, outcome: 'link_only' }
    }
    if (!action.team_id) return { linkId: link.id, outcome: 'no_target_state' }

    // JIRA ONLY: the done CATEGORY covers both "finished" and "abandoned"
    // (Jira has no canceled category), and folding the second onto `completed`
    // is how a user's cancellation used to come back out of Dial8 as a
    // completion.
    //
    // A team with no canceled column still lands on completed, and that
    // fallback is safe for the reason the started-less one (reopenStartedStateId
    // above) is not: `completed` is a TRUTHFUL landing for a cancellation — the
    // work stopped, and the echo then reads bucket=done against a done-category
    // Jira status and leaves the issue alone. `is_default` for an in-progress
    // issue is not truthful, and the echo exports the disagreement straight back
    // to the customer's Jira. Approximate only where the approximation cannot
    // travel outward as a write.
    if (args.remoteCanceled) {
      targetStatusId = await afterClaim(stateIdForCategory(supabase, action.team_id, 'canceled'))
      landedCanceled = targetStatusId !== null
    }
    if (!targetStatusId) {
      targetStatusId = await afterClaim(stateIdForCategory(supabase, action.team_id, 'completed'))
    }
  } else {
    // ── Step 5: the task was RE-OPENED at the provider ────────────────────
    // A 'completed' action always follows it back; a 'canceled' one only when
    // the provider said what the issue is now. Deliberately asymmetric:
    //  - 'canceled' WITHOUT a hint is never touched. That is the Asana shape:
    //    Asana cannot represent cancellation, so a canceled action's task is
    //    completed:true exactly like a done one, and an Asana user un-completing
    //    it is ambiguous — "this isn't done" or "this isn't cancelled"? We refuse
    //    to guess and leave Dial8 authoritative. (Handled at step 3a, before the
    //    CAS, so the link row isn't stranded.)
    //  - 'canceled' WITH a hint follows the issue. Jira states which category the
    //    issue is in now, so there is nothing to guess: the user un-cancelled it.
    //    Refusing that pinned the action in Cancelled forever — the reconcile
    //    sweep would re-refuse it every six hours — while the link's own label
    //    showed "In Progress" beside it.
    //  - backlog / unstarted / started are already "not complete"; re-opening at
    //    the provider must never DOWNGRADE an action someone has since started.
    if (action.category !== 'completed' && !(action.category === 'canceled' && hintedReopen)) {
      return { linkId: link.id, outcome: 'link_only' }
    }
    if (!action.team_id) return { linkId: link.id, outcome: 'no_target_state' }

    // JIRA ONLY: "reopened" and "reopened INTO in-progress" are different
    // events, and treating the second as the first is what sent a Dial8 action
    // to Todo while Jira said In Progress — which the echo then "corrected" by
    // dragging the issue back to To Do. Anything else (Asana, and Jira's `new`
    // statuses) keeps the team default, which is what a fresh action gets.
    targetStatusId = await afterClaim(
      args.remoteHint?.category === 'indeterminate'
        ? reopenStartedStateId(supabase, action.team_id)
        : reopenStateId(supabase, action.team_id),
    )
  }

  if (!targetStatusId || targetStatusId === action.status_id) {
    return {
      linkId: link.id,
      outcome: targetStatusId ? 'link_only' : 'no_target_state',
    }
  }

  const { error: statusError } = await supabase
    .from('actions')
    .update({ status_id: targetStatusId })
    .eq('id', action.id)
    .eq('workspace_id', workspaceId)
  if (statusError) {
    await rollBackClaim()
    throw statusError
  }

  // Fire the shared status-change trigger, exactly like every in-app writer
  // (GEN-112). Fire-and-forget by contract — emitStatusChange never throws and
  // never blocks. This is also what wakes asana-echo-status, which then hits its
  // already_synced fast path because the link row above already matches.
  emitStatusChange({
    entityType: 'action',
    entityId: action.id,
    workspaceId,
    teamId: action.team_id,
    fromStatusId: action.status_id,
    toStatusId: targetStatusId,
    actorUserId,
  })

  return {
    linkId: link.id,
    outcome: remoteCompleted ? (landedCanceled ? 'canceled' : 'completed') : 'reverted',
    fromStatusId: action.status_id,
    toStatusId: targetStatusId,
  }
}

/**
 * Stamp the terminal `task_deleted` marker on a link whose Asana task 404s.
 *
 * Shared with asana-echo-status's marker vocabulary (same column, same shape):
 * once stamped, the echo skips every Asana call for that link forever and the
 * UI can explain why the link stopped syncing. Only an explicit unlink clears
 * it. Best-effort — a failed marker write must not fail the sweep that found it.
 */
export async function markTaskDeleted(
  supabase: SupabaseClient,
  linkId: string,
): Promise<void> {
  const { error } = await supabase
    .from('action_external_task')
    .update({ last_push_error: { code: 'task_deleted', at: new Date().toISOString() } })
    .eq('id', linkId)
  if (error) {
    console.warn(`[asana] failed to mark link ${linkId} task_deleted:`, error.message)
  }
}
