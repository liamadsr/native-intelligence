import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  getIssue,
  getTransitions,
  issueStatusCategoryKey,
  issueStatusName,
  transitionIssue,
  JiraApiError,
  JiraUnauthorizedError,
  type JiraTransition,
} from '@/lib/integrations/jira-api'
import { JIRA_PROVIDER, loadJiraSyncState } from '@/lib/tasks/jira-config'
import {
  stampJiraLinkMarker,
  type JiraLinkMarkerCode,
} from '@/lib/tasks/jira-link-marker'
import {
  bucketForCategory,
  isCanceledStatusName,
  jiraCategoryForBucket,
  jiraTargetForBucket,
  type LifecycleBucket,
  type StatusMap,
} from '@/lib/tasks/lifecycle'

// =====================================================================
// Native Intelligence → Jira status echo
//
// The write half of two-way status sync: when a Native Intelligence action moves to a new
// workflow state, every Jira issue linked to it is transitioned to match.
//
// It rides the EXISTING `flow/entity.status_changed` event rather than minting
// its own: that event is already the single choke point every status writer
// funnels through (emitStatusChange, GEN-112), so subscribing here means the
// echo fires from the board drag, the ticket dropdown, the AI tools, bulk
// operations and proposal applies without touching any of them. Inngest fans one
// event out to every subscribing function, so this runs BESIDE asanaEchoStatus
// and flowDispatchOnStatusChange, each filtering to its own provider. That is
// the architecture, not duplication: a shared "echo everything" function would
// have to fail or succeed for all providers at once.
//
// WHY THIS IS NOT asana-echo-status WITH DIFFERENT NOUNS
// Asana's lifecycle write is a boolean you can compute offline and PUT. Jira has
// no settable status field at all — you fire a TRANSITION, and which transitions
// exist depends on the issue's CURRENT status inside its project's workflow AND
// on the connected user's permissions. So the "already in sync?" question that
// Asana answers from the link row alone has to be ASKED HERE, of Jira.
//
// THE CURRENT STATUS IS READ FIRST, BEFORE ANY TRANSITION IS SELECTED.
// That ordering is load-bearing three times over and is the loop breaker for the
// whole two-way sync:
//   - Jira workflows do not offer a self-loop, so when an issue is ALREADY in
//     the status the bucket wants, no transition lands on it — and picking "any
//     transition in the right statusCategory" then moves a Done issue to
//     "Won't Do", or an In Progress issue to In Review, seconds after a user put
//     it where they wanted it.
//   - The read-back (jira-apply-remote) moves the Native Intelligence action, which emits
//     `flow/entity.status_changed`, which wakes THIS function. Without the
//     pre-check that round-trips a Jira-originated change straight back out and
//     overwrites the user's choice. The pre-check can only do that job while the
//     two directions AGREE about what a status means, which is why the read-back
//     is category- and cancel-aware rather than a bare boolean — see
//     apply-remote-task-state.ts and the four brakes in
//     __tests__/jira-loop-termination.test.ts.
//   - The per-link loop lives in ONE step.run, so an Inngest retry replays links
//     that already succeeded. The pre-check turns a replay into a no-op — with
//     ONE honest exception, worth knowing about rather than glossing: a bucket
//     mapped to a status no offered transition reaches. That link can never
//     satisfy the pre-check (the mapped id is the only thing that would), so
//     every replay re-enters selection; it either settles on `no_transition`
//     (nothing else reaches the bucket — the common shape, pinned by the
//     "honours the EXPLICIT mapping when deciding already there" test) or falls
//     to the category tier and moves the issue again. The fix is the user's:
//     map the bucket to a reachable status, or unmap it.
//
// FAILURE MARKERS (action_external_task.last_push_error). Four codes, ALL
// RETRYABLE — see src/lib/tasks/jira-link-marker.ts for why Jira cannot have a
// terminal one (404 means "gone OR not browsable by this account", and
// Atlassian does not distinguish them):
//   - 404 → { code: 'task_missing' } — the issue could not be read. RETRIED on
//     the next status change, and the reconcile sweep keeps polling it; a
//     restored permission or an un-archived project resolves it by itself.
//   - 401 → { code: 'unauthorized' } — the token was not accepted. RETRIED: a
//     reconnect between runs fixes it.
//   - no candidate transition → { code: 'no_transition' } — the workflow (or
//     this user's permissions within it) offers no way to reach the target from
//     where the issue is. RETRIED: the issue moves, an admin edits the workflow,
//     or the destination gets an explicit status mapping, and it resolves itself.
//   - the POST failed 4xx → { code: 'transition_failed' } — most often a
//     workflow validator or a required field that isn't on the transition
//     screen (an admin misconfiguration we cannot route around from the API).
//     RETRIED for the same reason.
// A successful echo CLEARS the marker.
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
  /** The Atlassian cloudId the issue LIVES ON (migration 216). See cloudIdFor. */
  external_scope: string | null
  completed: boolean
  external_state_label: string | null
}

/**
 * Concurrent transitions on the SAME issue answer 409 Conflict — Atlassian
 * changed this deliberately (it used to be an inconsistent 400 that could
 * corrupt data) and their guidance is explicitly "implement retry logic". A
 * webhook-driven write racing a human in the Jira UI is an ordinary collision
 * here, not an exotic one.
 */
const TRANSITION_CONFLICT_ATTEMPTS = 3
const TRANSITION_CONFLICT_BACKOFF_MS = 150

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Pick the transition that best reaches `bucket`, or null.
 *
 * Three tiers, in strict order — each one a weaker signal than the last:
 *
 *  (a) EXPLICIT MAPPING. The bucket has a status id configured and some
 *      transition lands exactly on it. Unambiguous, so it always wins — even
 *      when it lands on a cancel-named status for the `done` bucket, because
 *      that is a decision somebody made rather than a guess we are making.
 *  (b) CANCELED BY NAME. Only for the `canceled` bucket, and whenever tier (a)
 *      did not MATCH — which includes "mapped, but no offered transition reaches
 *      the mapped status" (a condition hid it, or the id went stale after a
 *      project move). Keying this on the mere EXISTENCE of a mapping was a bug:
 *      it dropped an unreachable canceled mapping straight into (c), which
 *      marks the issue plain Done even though a "Won't Do" transition was right
 *      there. Jira has no canceled status CATEGORY (canceled and done share
 *      `done`), so the name is the only signal that separates them.
 *  (c) CATEGORY. Any transition whose landing status is in the bucket's
 *      statusCategory (`new` / `indeterminate` / `done`). Categories are the
 *      stable, non-localizable enum, which is exactly why the fallback keys off
 *      them rather than off English status names. With ONE exclusion: for the
 *      `done` bucket a cancel-named landing status is skipped. Transition order
 *      comes from the workflow definition and is arbitrary, so without it a
 *      workspace whose "Won't Do" happens to be listed first has completed work
 *      silently presented as abandoned.
 *
 * NO multi-hop BFS in v1. Walking the transition graph means re-fetching
 * transitions after every hop (availability is state-dependent), and every
 * intermediate hop is a REAL, visible status change in the customer's Jira with
 * its own notifications, automation triggers and audit entries. Doing that
 * silently to reach a status we merely inferred is a bad trade; `no_transition`
 * is honest and self-heals.
 *
 * NOTE this is only ever consulted AFTER the issue's current status has been
 * checked against the bucket (statusSatisfiesBucket) — "already there" is not
 * this function's job and cannot be, since the transition list never contains
 * the status the issue is currently in.
 */
export function selectTransition(
  transitions: JiraTransition[],
  bucket: LifecycleBucket,
  statusMap: StatusMap | null | undefined,
): JiraTransition | null {
  const usable = transitions.filter(
    (t) => typeof t?.id === 'string' && t.id.length > 0 && t.isAvailable !== false,
  )

  // (a) explicit mapping
  const targetStatusId = jiraTargetForBucket(bucket, statusMap)
  if (targetStatusId) {
    const exact = usable.find((t) => t.to?.id === targetStatusId)
    if (exact) return exact
  }

  // (b) canceled-by-name — including a mapping tier (a) could not reach
  if (bucket === 'canceled') {
    const byName = usable.find((t) => isCanceledStatusName(t.to?.name))
    if (byName) return byName
  }

  // (c) statusCategory, never landing `done` on a cancellation
  const category = jiraCategoryForBucket(bucket)
  return (
    usable.find(
      (t) =>
        t.to?.statusCategory?.key === category &&
        !(bucket === 'done' && isCanceledStatusName(t.to?.name)),
    ) ?? null
  )
}

/**
 * The `fields.resolution` value to send with a transition, or null to omit it.
 *
 * This exists because of how real Jira workspaces actually model cancellation.
 * Atlassian's own guidance steers admins AWAY from a separate "Cancelled"
 * status (a status outside the done category makes issues reappear in sprints)
 * and TOWARD one Done status distinguished by the resolution — so for a large
 * share of workspaces the resolution is the ONLY place the done/canceled
 * distinction can live.
 *
 * The rules, in order:
 *  - No `resolution` on this transition's screen → send nothing. Setting a field
 *    that isn't on the screen is a guaranteed 400 ("cannot be set… not on the
 *    appropriate screen"), which would turn a working transition into a failure.
 *  - Preferred value ("Won't Do" for canceled, "Done" for done) if the screen
 *    offers it — matched case-insensitively but sent back with the site's OWN
 *    spelling, since allowedValues is what the instance will accept.
 *  - Otherwise, if the field is REQUIRED, the first allowed value: a slightly
 *    wrong resolution beats a transition that cannot fire at all.
 *  - Otherwise omit — an optional resolution we can't match is not worth guessing.
 */
export function resolutionForTransition(
  transition: JiraTransition,
  bucket: LifecycleBucket,
): { name: string } | { id: string } | null {
  const field = transition.fields?.resolution
  if (!field) return null

  const allowed = (field.allowedValues ?? []).filter(
    (v) => typeof v?.name === 'string' || typeof v?.id === 'string',
  )

  const preferred =
    bucket === 'canceled' ? "Won't Do" : bucket === 'done' ? 'Done' : null

  if (preferred) {
    const match = allowed.find(
      (v) => typeof v.name === 'string' && v.name.toLowerCase() === preferred.toLowerCase(),
    )
    if (match?.name) return { name: match.name }
  }

  if (field.required && allowed.length > 0) {
    const first = allowed[0]
    if (typeof first.name === 'string' && first.name.length > 0) return { name: first.name }
    if (typeof first.id === 'string' && first.id.length > 0) return { id: first.id }
  }

  return null
}

/**
 * Does the issue's CURRENT status already satisfy the bucket?
 *
 * THE FIRST QUESTION EVERY ECHO ASKS (see the header). It decides between "leave
 * the customer's issue exactly where it is" and "transition it", and getting it
 * wrong in either direction is expensive: too lax and a Native Intelligence column nudge stops
 * mirroring at all; too strict and the echo bounces a status a human just set.
 *
 * Exactly two rules, and DELIBERATELY no third:
 *  - MAPPED: satisfied by exactly that status id. Nothing else, because the user
 *    named one.
 *  - Otherwise: the statusCategory must match. That is all.
 *
 * WHY THE CANCEL-NAME HEURISTIC IS NOT APPLIED HERE, though it lives two
 * functions up in selectTransition. The two ask different questions. Selection
 * asks "where should I MOVE this issue?", where the name is the only thing
 * separating "finished" from "abandoned" inside the shared `done` category and
 * choosing wrong writes the wrong meaning into a customer's Jira. This asks "may
 * I leave the issue exactly where it is?", where a name mismatch inside the
 * right category is a reason to do NOTHING, not a licence to move something.
 * Enforcing the name rule here as well cost us both directions:
 *  - a Native Intelligence Done-column move against an issue a human had parked on "Won't Do"
 *    started fighting that cancellation, or stamped `no_transition` on a healthy
 *    link when no other done-category status was reachable;
 *  - and it broke this module's idempotency promise, because selectTransition
 *    legitimately lands a `canceled` echo on a plain "Done" (tier c) — a landing
 *    this function then rejected forever, so every Inngest replay of the
 *    per-link loop re-entered selection.
 * The done/canceled ambiguity is resolved where it is actionable: in selection,
 * and in the `resolution` field the transition carries.
 */
export function statusSatisfiesBucket(
  status: { id?: string; name?: string | null; categoryKey?: string | null },
  bucket: LifecycleBucket,
  statusMap: StatusMap | null | undefined,
): boolean {
  const targetStatusId = jiraTargetForBucket(bucket, statusMap)
  if (targetStatusId) return status.id === targetStatusId
  return status.categoryKey === jiraCategoryForBucket(bucket)
}

export const jiraEchoStatus = inngest.createFunction(
  {
    id: 'jira-echo-status',
    retries: 3,
    // Two constraints (Inngest evaluates both):
    //  - per-workspace cap (limit 5) mirrors the other integration functions —
    //    a bulk status change over 100 actions can't stampede Jira (whose
    //    per-issue write limit is 20 writes / 2s and whose hourly point quota is
    //    shared across ALL our tenants).
    //  - per-action serialization (limit 1) keeps two rapid status flips on the
    //    same action from racing each other into opposite transitions — which is
    //    also the 409 Atlassian would otherwise hand us.
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

    // Gate 2: does this action have any Jira links at all? This is the cheap
    // read that makes the echo free for every workspace that doesn't use Jira.
    const links = await step.run('load-links', async () => {
      const { data } = await supabase
        .from('action_external_task')
        .select('id, external_id, external_scope, completed, external_state_label')
        .eq('action_id', entity_id)
        .eq('workspace_id', workspace_id)
        .eq('provider', JIRA_PROVIDER)
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

    // Gate 4: destination + token. A workspace can hold links from a Jira
    // account that was since disconnected — no state / no token is a clean
    // no-op, not a retry.
    const destination = await step.run('resolve-destination', async () => {
      const state = await loadJiraSyncState(workspace_id)
      if (!state) return null
      const cloudId = state.config.cloud_id
      if (!cloudId) return null
      const resolved = await getValidTokenForAccount(state.accountId)
      if (!resolved) return null
      return {
        token: resolved.token,
        cloudId,
        statusMap: state.config.status_map ?? null,
      }
    })

    if (!destination) {
      return { status: 'skipped' as const, reason: 'no_jira_account' }
    }

    // HOUSE RULE: one flat step.run per phase. Every Jira call and every write
    // below happens INSIDE this single callback — no step.* may be invoked from
    // in here (it deadlocks in production rather than throwing).
    const results = await step.run('echo-issues', async () => {
      const summary: Array<{ linkId: string; outcome: string }> = []

      for (const link of links) {
        // Address every call to the site the LINK lives on, not to whatever the
        // destination config points at today: a workspace that re-pointed its
        // site would otherwise read issue id 10001 on the NEW tenant, where the
        // same id is a different, unrelated issue (Jira issue ids are per-site
        // sequences and every site's start at 10000).
        const cloudId = link.external_scope || destination.cloudId

        // ── 1. Where is the issue RIGHT NOW? ────────────────────────────────
        // Before anything else, because a transition fired at an issue that is
        // already where the bucket wants it moves it somewhere it shouldn't be.
        let current
        try {
          current = await getIssue(destination.token, cloudId, link.external_id, 'status')
        } catch (err) {
          const failure = markerForError(err)
          if (!failure) throw err // transient — let Inngest retry the whole step
          await stampJiraLinkMarker(supabase, link.id, failure)
          summary.push({ linkId: link.id, outcome: failure })
          continue
        }

        const currentStatus = {
          id: current?.fields?.status?.id,
          name: issueStatusName(current),
          categoryKey: issueStatusCategoryKey(current),
        }

        if (statusSatisfiesBucket(currentStatus, bucket, destination.statusMap)) {
          // Already there. Refresh the recorded provider state (which is what
          // stops the read-back from bouncing back here) and retire any earlier
          // marker — but fire NOTHING at the customer's Jira.
          await markSynced(supabase, link.id, {
            completed: currentStatus.categoryKey === 'done',
            label: currentStatus.name,
          })
          summary.push({ linkId: link.id, outcome: 'already_synced' })
          continue
        }

        // ── 2. It has to move: what can it move to? ─────────────────────────
        let transitions: JiraTransition[]
        try {
          transitions = await getTransitions(destination.token, cloudId, link.external_id)
        } catch (err) {
          const failure = markerForError(err)
          if (!failure) throw err // transient — let Inngest retry the whole step
          await stampJiraLinkMarker(supabase, link.id, failure)
          summary.push({ linkId: link.id, outcome: failure })
          continue
        }

        const transition = selectTransition(transitions, bucket, destination.statusMap)

        if (!transition) {
          // Unambiguous now that the current status has already been ruled out:
          // the workflow (or this account's permissions inside it) offers no way
          // to the target from where the issue sits.
          await stampJiraLinkMarker(supabase, link.id, 'no_transition')
          console.warn(
            `[jira-echo-status] no transition to '${bucket}' for issue ${link.external_id} ` +
              `(action ${entity_id}); marked and skipped.`,
          )
          summary.push({ linkId: link.id, outcome: 'no_transition' })
          continue
        }

        const resolution = resolutionForTransition(transition, bucket)
        const body = {
          transition: { id: transition.id },
          ...(resolution ? { fields: { resolution } } : {}),
        }

        let posted = false
        let failure: JiraLinkMarkerCode | null = null
        for (let attempt = 1; attempt <= TRANSITION_CONFLICT_ATTEMPTS; attempt++) {
          try {
            await transitionIssue(destination.token, cloudId, link.external_id, body)
            posted = true
            break
          } catch (err) {
            // 409: someone else is transitioning this very issue right now.
            // Atlassian's documented answer is to retry, so retry — the
            // transition we picked is still the one we want.
            if (
              err instanceof JiraApiError &&
              err.status === 409 &&
              attempt < TRANSITION_CONFLICT_ATTEMPTS
            ) {
              await sleep(TRANSITION_CONFLICT_BACKOFF_MS * attempt)
              continue
            }
            const marked = markerForError(err)
            if (marked) {
              failure = marked
              break
            }
            if (err instanceof JiraApiError && err.status >= 400 && err.status < 500) {
              // A validator, a required field off-screen, or a transition that
              // stopped being valid between the GET and the POST. Not transient
              // in the Inngest sense, but not permanent either.
              failure = 'transition_failed'
              break
            }
            throw err // transient (5xx, network) — let Inngest retry the step
          }
        }

        if (!posted) {
          const code = failure ?? 'transition_failed'
          await stampJiraLinkMarker(supabase, link.id, code)
          console.warn(
            `[jira-echo-status] ${code} transitioning issue ${link.external_id} ` +
              `(action ${entity_id}); marked and skipped.`,
          )
          summary.push({ linkId: link.id, outcome: code })
          continue
        }

        // Success. `to` is the status the transition lands on, so the label and
        // completion come from the transition we just fired — no extra read.
        //
        // NOTE we deliberately do NOT try to clear `resolution` when moving OFF
        // a done-category status. Jira's default workflows clear it with a
        // post-function on the reopen transition, editing it directly is
        // screen-gated (and would 400 on most transitions), and a bespoke
        // workflow that omits the post-function is an admin choice, not ours to
        // override from an integration.
        await markSynced(supabase, link.id, {
          completed: transition.to?.statusCategory?.key === 'done',
          label: transition.to?.name ?? link.external_state_label ?? null,
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
 * clearJiraLinkMarker.)
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
 * Classify a Jira failure into a marker, or null when it's transient and the run
 * should retry.
 *
 * Only two failures are classified here: the token is rejected (401 — reconnect
 * required) and the issue could not be read (404 — deleted, OR not browsable by
 * this account; Jira does not distinguish them, which is why the marker is
 * `task_missing` and not `task_deleted`). Everything else (429 past the client's
 * own backoff, 5xx, network) gets Inngest's retries; the caller separately
 * classifies a non-404 4xx on the POST as 'transition_failed'.
 */
function markerForError(err: unknown): 'unauthorized' | 'task_missing' | null {
  if (err instanceof JiraUnauthorizedError) return 'unauthorized'
  if (err instanceof JiraApiError && err.status === 404) return 'task_missing'
  return null
}
