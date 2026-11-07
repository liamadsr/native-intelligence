import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  getIssue,
  listTeamStates,
  updateIssueState,
  issueStateName,
  issueStateType,
  LinearApiError,
  LinearUnauthorizedError,
} from '@/lib/integrations/linear-api'
import { LINEAR_PROVIDER, loadLinearSyncState } from '@/lib/tasks/linear-config'
import {
  stampLinearLinkMarker,
  type LinearLinkMarkerCode,
} from '@/lib/tasks/linear-link-marker'
import {
  bucketForCategory,
  deriveLinearStateMap,
  linearBucketForStateType,
  linearTargetForBucket,
  type LifecycleBucket,
  type LinearStateMap,
} from '@/lib/tasks/lifecycle'

// =====================================================================
// Dial8 → Linear status echo
//
// The write half of two-way status sync: when a Dial8 action moves to a new
// workflow state, every Linear issue linked to it is moved to the matching
// workflow state.
//
// It rides the EXISTING `flow/entity.status_changed` event rather than minting
// its own: that event is already the single choke point every status writer
// funnels through (emitStatusChange, GEN-112), so subscribing here means the
// echo fires from the board drag, the ticket dropdown, the AI tools, bulk
// operations and proposal applies without touching any of them. Inngest fans one
// event out to every subscribing function, so this runs BESIDE asanaEchoStatus,
// jiraEchoStatus and flowDispatchOnStatusChange, each filtering to its own
// provider.
//
// WHY THIS IS MUCH SHORTER THAN THE JIRA SIBLING
// Jira has no settable status field: you fire a TRANSITION, whose availability
// depends on the issue's current status inside its project's workflow and on the
// connected user's permissions — hence three selection tiers, a resolution
// field, and 409 retries. Linear's `issueUpdate(input: { stateId })` is a DIRECT
// WRITE: any state on the issue's team is settable from any other, and Linear
// maintains `completedAt` / `canceledAt` itself. So there is no selection to do
// at all — the destination's derived state map already names the target.
//
// THE CURRENT STATE IS STILL READ FIRST, and for one of the three reasons Jira
// reads it: THE LOOP BREAKER. The read-back (linear-apply-remote) moves the
// Dial8 action, which emits `flow/entity.status_changed`, which wakes THIS
// function. Without the pre-check that round-trips a Linear-originated change
// straight back out — a write against the customer's issue for a change they
// made in the customer's own tool. The pre-check compares BUCKETS rather than
// state ids, because that is the resolution the read-back works at: an issue a
// user parked on a second in-progress state ("In Review") is already satisfying
// `in_progress`, and rewriting it to the mapped "In Progress" would fight them.
// (The other two Jira reasons don't apply: a direct write has no self-loop
// problem, and there is no transition list whose contents depend on where the
// issue currently sits.)
//
// It is also what makes an Inngest retry cheap: the per-link loop lives in ONE
// step.run, so a replay re-runs links that already succeeded — and finds them
// already satisfied.
//
// FAILURE MARKERS (action_external_task.last_push_error). All RETRYABLE — see
// src/lib/tasks/linear-link-marker.ts for why Linear cannot have a terminal one
// (`issue(id:)` answers a bare null for deleted, invisible AND never-existed):
//   - null/trashed issue → { code: 'task_missing' } — RETRIED on the next status
//     change, and the reconcile sweep keeps polling it.
//   - 401/403 → { code: 'unauthorized' } — RETRIED: a reconnect between runs
//     fixes it.
//   - no state mapped for the bucket → { code: 'no_target_state' } — the team
//     has no state of a suitable type. Linear does not guarantee one of each
//     (a team with no canceled-type state is ordinary), and writing the nearest
//     closed state instead would tell the customer's team that abandoned work
//     shipped. RETRIED: adding the state, or re-saving the destination,
//     resolves it.
//   - issueUpdate rejected → { code: 'update_failed' }.
// A successful echo CLEARS the marker.
//
// HOUSE RULE — no `step.*` inside a `step.run` callback: nesting them deadlocks
// silently in production. Every Linear call below happens inside ONE flat
// step.run.
// =====================================================================

interface StatusChangedEventData {
  entity_type: string
  entity_id: string
  workspace_id: string
  to_status_id: string
}

interface LinkRow {
  id: string
  external_id: string
  completed: boolean
  external_state_label: string | null
}

export const linearEchoStatus = inngest.createFunction(
  {
    id: 'linear-echo-status',
    retries: 3,
    // Two constraints (Inngest evaluates both):
    //  - per-workspace cap (limit 5) mirrors the other integration functions —
    //    a bulk status change over 100 actions can't stampede Linear (whose
    //    OAuth quota is 5000 requests/hour/user plus a complexity budget).
    //  - per-action serialization (limit 1) keeps two rapid status flips on the
    //    same action from racing each other into opposite states.
    concurrency: [
      { limit: 5, key: 'event.data.workspace_id' },
      { limit: 1, key: 'event.data.entity_id' },
    ],
    triggers: [{ event: 'flow/entity.status_changed' }],
  },
  async ({ event, step }) => {
    const { entity_type, entity_id, workspace_id, to_status_id } =
      event.data as StatusChangedEventData

    // Gate 1: actions are the only entity that can carry an external task link.
    // Project/initiative/milestone status changes share this event.
    if (entity_type !== 'action') {
      return { status: 'skipped' as const, reason: 'not_an_action' }
    }

    const supabase = getServiceClient()

    // Gate 2: does this action have any Linear links at all? This is the cheap
    // read that makes the echo free for every workspace that doesn't use Linear.
    const links = await step.run('load-links', async () => {
      const { data } = await supabase
        .from('action_external_task')
        .select('id, external_id, completed, external_state_label')
        .eq('action_id', entity_id)
        .eq('workspace_id', workspace_id)
        .eq('provider', LINEAR_PROVIDER)
      return (data ?? []) as LinkRow[]
    })

    if (links.length === 0) {
      return { status: 'skipped' as const, reason: 'no_links' }
    }

    // Gate 3: the target status's CATEGORY — the only status property that maps
    // to an external lifecycle (names are per-team and arbitrary).
    const bucket = await step.run('resolve-bucket', async () => {
      const { data } = await supabase
        .from('workflow_state')
        .select('category')
        .eq('id', to_status_id)
        .maybeSingle()
      return bucketForCategory((data?.category as string | null) ?? '')
    })

    // Gate 4: destination + token. A workspace can hold links from a Linear
    // account that was since disconnected — no state / no token is a clean
    // no-op, not a retry.
    const destination = await step.run('resolve-destination', async () => {
      const state = await loadLinearSyncState(workspace_id)
      if (!state) return null
      const resolved = await getValidTokenForAccount(state.accountId)
      if (!resolved) return null
      return {
        token: resolved.token,
        teamId: state.config.team_id ?? null,
        stateMap: state.config.state_map ?? null,
      }
    })

    if (!destination) {
      return { status: 'skipped' as const, reason: 'no_linear_account' }
    }

    // HOUSE RULE: one flat step.run per phase. Every Linear call and every write
    // below happens INSIDE this single callback — no step.* may be invoked from
    // in here (it deadlocks in production rather than throwing).
    const results = await step.run('echo-issues', async () => {
      const summary: Array<{ linkId: string; outcome: string }> = []

      /**
       * Re-derived maps, CACHED PER TEAM.
       *
       * Per team rather than one shared slot because Linear workflow states are
       * team-scoped and issues move between teams: a map re-derived for the team
       * one link's issue happens to live on must never become the map every
       * later link writes against, or the repair would start sending one team's
       * state ids at another team's issues. Within a team it is still derived at
       * most once per run, so the batch cost stays one `listTeamStates` per team
       * actually involved rather than one per link. A cached `null` records "we
       * tried this team and got nothing", so a failed read is not retried per
       * link either.
       */
      const freshMaps = new Map<string, LinearStateMap | null>()

      /**
       * Re-derive the map from a team's CURRENT states.
       *
       * The saved map is a snapshot taken at destination-save time, and Linear
       * lets a workspace admin delete or replace a workflow state at any moment.
       * When that happens the stored id is not "wrong" in a way any validation
       * could have caught — it was correct when written — so the repair is to
       * re-read the team and fold it again with the SAME pure function the
       * settings route uses (deriveLinearStateMap), which is what keeps the two
       * from drifting.
       *
       * `teamId` is the team the ISSUE is on, falling back to the configured
       * destination team when the read didn't say. Null is reserved for "there
       * is nothing better to offer" — no team to read, or the read itself
       * failed.
       */
      const rederiveStateMap = async (
        teamId: string | null,
      ): Promise<LinearStateMap | null> => {
        const target = teamId ?? destination.teamId
        if (!target) return null
        const cached = freshMaps.get(target)
        if (cached !== undefined) return cached
        try {
          const states = await listTeamStates(destination.token, target)
          const derived = deriveLinearStateMap(states)
          freshMaps.set(target, derived)
          return derived
        } catch (err) {
          console.warn(
            `[linear-echo-status] could not re-derive the state map for team ${target}:`,
            err instanceof Error ? err.message : String(err),
          )
          freshMaps.set(target, null)
          return null
        }
      }

      for (const link of links) {
        // ── 1. Where is the issue RIGHT NOW? ────────────────────────────────
        // The loop breaker (see the header): a change the read-back just
        // imported must not be echoed straight back out.
        let current
        try {
          current = await getIssue(destination.token, link.external_id)
        } catch (err) {
          const failure = markerForError(err)
          if (!failure) throw err // transient — let Inngest retry the whole step
          await stampLinearLinkMarker(supabase, link.id, failure)
          summary.push({ linkId: link.id, outcome: failure })
          continue
        }

        // Null OR trashed: the issue cannot be read, or is in Linear's 30-day
        // delete grace window. Both are `task_missing` and both are RETRYABLE —
        // Linear returns a bare null for deleted, invisible and never-existed
        // alike, so a terminal reading would kill the sync for every link a
        // permissions change touched.
        if (!current || current.trashed === true) {
          await stampLinearLinkMarker(supabase, link.id, 'task_missing')
          summary.push({ linkId: link.id, outcome: 'task_missing' })
          continue
        }

        const currentType = issueStateType(current)
        const currentBucket = linearBucketForStateType(currentType)

        // A remote CANCELED/DUPLICATE issue also satisfies a `done` bucket.
        //
        // This is the bounce-back guard, and it exists because of a shared
        // fallback: when a remote cancellation is applied to a Dial8 team that
        // has no canceled-category workflow state, applyRemoteTaskState lands
        // the action on the team's DONE state instead — which emits a status
        // change whose bucket is 'done' and wakes this function. Strict equality
        // would read canceled ≠ done, decide the issue must move, and flip the
        // customer's own cancellation to Done in the customer's own Linear. (The
        // Jira sibling never sees this because its categories fold done and
        // canceled together; linearBucketForStateType deliberately does not.)
        //
        // Deliberately ONE-WAY: a Dial8-side cancel must still be written out to
        // an issue sitting on a done state, or the cancel would never reach the
        // customer's team at all. Only a remote terminal state satisfies `done`
        // — a terminal abandonment must never be "upgraded" to shipped.
        //
        // An unknown current type (bucket null) satisfies nothing and falls
        // through to the write. That diverges from the read-back, which leaves
        // unknown types alone — and it is loop-safe precisely BECAUSE of that:
        // a state this build cannot classify can never be a change the read-back
        // just imported, so there is no loop to break, and overwriting on a
        // bucket mismatch is the echo's ordinary Dial8-wins behavior.
        const satisfied =
          currentBucket === bucket ||
          (bucket === 'done' && (currentBucket === 'canceled' || currentBucket === 'done'))

        if (satisfied) {
          // Already where the bucket wants it. Refresh the recorded provider
          // state (which is what stops the read-back from bouncing back here)
          // and retire any earlier marker — but fire NOTHING at Linear.
          //
          // Compared at BUCKET resolution, not state id: a user who parked the
          // issue on a second in-progress state means it, and rewriting it to
          // the mapped one would be the echo overruling a human for no gain.
          await markSynced(supabase, link.id, {
            completed: currentBucket === 'done' || currentBucket === 'canceled',
            label: issueStateName(current) ?? link.external_state_label,
          })
          summary.push({ linkId: link.id, outcome: 'already_synced' })
          continue
        }

        // ── 2. It has to move: what state does this bucket map to? ──────────
        // The team the issue is on RIGHT NOW, which is not necessarily the
        // configured destination: issues move between teams in Linear (that is
        // why the re-fetch asks for it), and workflow states are team-scoped, so
        // the saved map's ids are only valid for the destination team.
        const issueTeamId = current.team?.id ?? null
        const onConfiguredTeam = !issueTeamId || issueTeamId === destination.teamId

        // For an issue that has moved off the destination team, the saved map is
        // not merely stale — it names states of a team this issue is not on, and
        // every write of one would be rejected. Derive from the issue's own team
        // so the FIRST write is right, instead of relying on a reject-and-retry.
        let targetStateId = onConfiguredTeam
          ? linearTargetForBucket(destination.stateMap, bucket)
          : linearTargetForBucket(await rederiveStateMap(issueTeamId), bucket)

        if (!targetStateId) {
          // The saved map may simply predate a state the team has since added,
          // so try ONE re-derivation before declining.
          const fresh = await rederiveStateMap(issueTeamId)
          targetStateId = linearTargetForBucket(fresh, bucket)
        }

        if (!targetStateId) {
          // The team genuinely expresses no state for this bucket. Declining is
          // the honest outcome: landing a canceled action on "Done" would tell
          // the customer's team the work shipped.
          await stampLinearLinkMarker(supabase, link.id, 'no_target_state')
          console.warn(
            `[linear-echo-status] no '${bucket}' state mapped for issue ${link.external_id} ` +
              `(action ${entity_id}); marked and skipped.`,
          )
          summary.push({ linkId: link.id, outcome: 'no_target_state' })
          continue
        }

        // ── 3. Write it. One mutation, no transition graph. ─────────────────
        let updated
        try {
          updated = await updateIssueState(destination.token, link.external_id, targetStateId)
        } catch (err) {
          const failure = markerForError(err)
          if (failure) {
            await stampLinearLinkMarker(supabase, link.id, failure)
            summary.push({ linkId: link.id, outcome: failure })
            continue
          }

          // A rejected input almost always means the saved state id no longer
          // exists on the team (someone deleted or replaced the state in
          // Linear). Re-derive ONCE and retry with the fresh id — the id we just
          // sent is the only thing that changed, so retrying the same call is
          // the whole fix.
          if (isRetryableInput(err)) {
            const fresh = await rederiveStateMap(issueTeamId)
            const retryStateId = linearTargetForBucket(fresh, bucket)
            if (retryStateId && retryStateId !== targetStateId) {
              try {
                updated = await updateIssueState(
                  destination.token,
                  link.external_id,
                  retryStateId,
                )
              } catch (retryErr) {
                const retryFailure = markerForError(retryErr) ?? 'update_failed'
                await stampLinearLinkMarker(supabase, link.id, retryFailure)
                summary.push({ linkId: link.id, outcome: retryFailure })
                continue
              }
            } else {
              await stampLinearLinkMarker(supabase, link.id, 'update_failed')
              summary.push({ linkId: link.id, outcome: 'update_failed' })
              continue
            }
          } else {
            throw err // transient (5xx, network, rate limit) — Inngest retries
          }
        }

        // Success. Linear returns the issue's state inline, so the label and
        // completion come from the write itself — no extra read.
        const landedType = issueStateType(updated)
        const landedBucket = linearBucketForStateType(landedType)
        await markSynced(supabase, link.id, {
          completed: landedBucket === 'done' || landedBucket === 'canceled',
          label: issueStateName(updated) ?? link.external_state_label,
        })

        summary.push({ linkId: link.id, outcome: 'synced' })
      }

      return summary
    })

    return {
      status: 'ok' as const,
      bucket,
      results,
    }
  },
)

/**
 * Record the new provider state and retire any earlier marker.
 *
 * This is what clears a marker on the echo side — nothing ages them out, so a
 * link whose echo starts working again has to be un-marked here or it shows as
 * broken forever. (The read-back paths clear their own via
 * clearLinearLinkMarker.)
 */
async function markSynced(
  supabase: ReturnType<typeof getServiceClient>,
  linkId: string,
  state: { completed: boolean; label: string | null },
): Promise<void> {
  await supabase
    .from('action_external_task')
    .update({
      completed: state.completed,
      external_state_label: state.label,
      last_synced_at: new Date().toISOString(),
      last_push_error: null,
    })
    .eq('id', linkId)
}

/**
 * Classify a Linear failure into a marker, or null when the caller should decide
 * (a rejected input) or the run should retry (transient).
 *
 * Only the token rejection is classified here. A null issue is not an error at
 * all in GraphQL terms — it comes back as data — so it is handled inline above
 * rather than thrown.
 */
function markerForError(err: unknown): LinearLinkMarkerCode | null {
  if (err instanceof LinearUnauthorizedError) return 'unauthorized'
  return null
}

/**
 * Was this a rejected INPUT (as opposed to a transient failure)?
 *
 * Linear answers a bad mutation input with HTTP 200 and an `errors[]` entry, or
 * with a `success: false` the client turns into a LinearApiError carrying status
 * 200. Either way the distinguishing property is that retrying the identical
 * call is pointless — which is exactly when the stale-state-id re-derivation is
 * worth attempting.
 *
 * Deliberately BROADER than `isLinearInputError` (which the push uses): every
 * 200-level rejection reaches the repair path, because the only recovery on
 * offer here is re-deriving one state id — cheap, and harmless when the
 * rejection turns out to have been about something else. The push's predicate
 * has to be narrower because its recovery DISCARDS user-supplied fields.
 */
function isRetryableInput(err: unknown): boolean {
  return err instanceof LinearApiError && err.status === 200
}
