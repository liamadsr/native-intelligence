import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  getIssue,
  issueStatusCategoryKey,
  issueStatusName,
  JiraApiError,
  JiraUnauthorizedError,
} from '@/lib/integrations/jira-api'
import { JIRA_PROVIDER, loadJiraSyncState } from '@/lib/tasks/jira-config'
import { jiraRemoteState, type JiraRemoteState } from '@/lib/tasks/lifecycle'
import {
  clearJiraLinkMarker,
  stampJiraLinkMarker,
  JIRA_TASK_MISSING,
} from '@/lib/tasks/jira-link-marker'
import {
  applyRemoteTaskState,
  type ApplyRemoteResult,
  type RemoteTaskLink,
} from '@/lib/tasks/apply-remote-task-state'

// =====================================================================
// Jira → Native Intelligence read-back (webhook fast path)
//
// Fired by the receiver (src/app/api/webhooks/jira/route.ts) with the issue ids
// named in one delivery.
//
// THE RE-FETCH IS THE SECURITY BOUNDARY. The receiver is an unauthenticated,
// unsigned, forgeable endpoint (Atlassian offers no way to secure a dynamic
// webhook — see the receiver's docblock), so nothing in the delivery body is
// trusted. Every issue id is re-read here over an AUTHENTICATED call against the
// workspace's own connected token, which means the worst a forged delivery can
// do is make us re-read an issue we already had access to and apply what Jira
// itself reports. The reconcile sweep (jira-reconcile.ts) calls the same helper,
// so the two paths cannot drift.
//
// WHY THIS RESOLVES WORKSPACES ITSELF (the Asana sibling is handed one). Jira
// permits exactly one receiver URL per app, so a delivery names an issue and
// nothing else — no sync state, no workspace. The link table is therefore the
// router: `(provider, external_id)` is indexed for exactly this, and one issue
// id may legitimately match links in SEVERAL workspaces (two Native Intelligence workspaces
// connected to the same Jira site). Each matched workspace resolves its OWN
// destination and token.
//
// FOLDING A STATUS INTO THE SHARED CONTRACT. `applyRemoteTaskState` is shared
// verbatim with Asana, whose lifecycle is one boolean, so the fold happens in
// `jiraRemoteState` (src/lib/tasks/lifecycle.ts) and travels as that function's
// optional, Jira-only arguments:
//   - `remoteCompleted` from `statusCategory.key === 'done'` — the stable,
//     non-localizable enum, never the status name;
//   - `remoteHint.category`, so a reopen into an `indeterminate` status lands in
//     a STARTED Native Intelligence state rather than the team default — and, because its mere
//     presence says the un-completion is unambiguous, so a CANCELLED action
//     follows the issue back out instead of being pinned forever (Asana, which
//     passes no hint, still refuses: see apply-remote-task-state.ts step 5);
//   - `remoteCanceled`, so a done-category status that reads as an abandonment
//     ("Won't Do") lands in a CANCELED state rather than a completed one.
// The last two exist because the echo compares full statuses: fold too hard
// here and the state we choose contradicts the issue, which the echo then
// "corrects" by transitioning the customer's issue back. The part that fits
// nowhere (the actual status name) is written to `external_state_label`, which
// migration 212 provisioned for precisely this.
//
// HOUSE RULE — no `step.*` inside a `step.run` callback: nesting them deadlocks
// silently in production. Each phase is ONE flat step.run, and the only
// step.sendEvent (the self-chain) is at the top level of the handler.
//
// WHAT IS ACTUALLY BOUNDED, precisely, because the trigger is reachable by
// anyone with an HTTP client and a vague claim here is worse than none:
//   - at most MAX_ISSUES_PER_RUN (25) issue ids are accepted per invocation;
//   - at most MAX_LINKS_PER_RUN (50) LINKS are processed per invocation, which
//     is the real unit of cost — one authenticated `GET /issue` each, issued
//     sequentially inside one step.run. One id can match links in many
//     workspaces, so bounding ids alone bounded nothing;
//   - everything either cap defers is SELF-CHAINED, in the delivered order;
//   - and the whole function is throttled to 30 runs/minute globally.
// The receiver additionally drops ids that match no link at all, so a forged
// delivery naming issues nobody linked costs one indexed SELECT and stops.
//
// The one honest asterisk: an id whose OWN link count exceeds the link cap is
// still processed whole (a single id is never split across runs — the chain
// carries ids, not link cursors, so a partially-processed id would be re-read
// from the start forever). Every run therefore consumes at least one whole id,
// which is exactly what makes the chain strictly shorter each hop and guarantees
// it terminates.
// =====================================================================

interface RemoteChangeEventData {
  issueIds: string[]
}

/** Issue IDS accepted per invocation. The remainder self-chains. */
const MAX_ISSUES_PER_RUN = 25

/**
 * Authenticated Jira GETs per invocation — one per LINK, which is the unit the
 * work is actually measured in.
 *
 * 50 sequential gateway reads is a few seconds against `maxDuration = 300`
 * (src/app/api/inngest/route.ts), leaving room for the three retries Inngest
 * will spend on this step and for the slowest tenant in the batch.
 */
const MAX_LINKS_PER_RUN = 50

/** A link row plus the workspace that owns it (the delivery doesn't say). */
interface WorkspaceLink extends RemoteTaskLink {
  workspace_id: string
  external_state_label: string | null
  /** The cloudId this issue lives on (migration 216); null for pre-216 rows. */
  external_scope: string | null
  /** Stored `{ code, at }` marker — read only to retire it after a good read. */
  last_push_error: unknown
}

export const jiraApplyRemote = inngest.createFunction(
  {
    id: 'jira-apply-remote-change',
    retries: 3,
    // UNKEYED, unlike the Asana sibling's per-workspace cap: the triggering
    // event carries no workspace (see the header), and Inngest evaluates the
    // key against the event, not against anything the handler later discovers.
    // A flat ceiling still bounds the fan-out — a noisy Jira project cannot
    // stampede our API budget or the database — it just shares that ceiling
    // across tenants instead of per-tenant. Acceptable while the run is
    // 25-issue-bounded and self-chaining; revisit if one tenant is ever seen
    // starving another.
    concurrency: [{ limit: 5 }],
    // GLOBAL BACKSTOP for a trigger that anyone can raise: the receiver is an
    // unauthenticated, unsigned public endpoint (Atlassian offers nothing
    // better), so the honest assumption is that events can arrive at HTTP speed.
    // Concurrency alone doesn't bound that — it caps parallelism, not arrival —
    // whereas a throttle caps the RATE at which runs start and queues the rest,
    // which is exactly the shape of protection the Atlassian point quota (shared
    // across every tenant of this app) needs. 30/min is far above real webhook
    // traffic for one project and far below what a flood would produce.
    throttle: { limit: 30, period: '1m' },
    triggers: [{ event: 'tasks/jira-remote-change' }],
  },
  async ({ event, step }) => {
    const { issueIds } = event.data as RemoteChangeEventData

    const allIds = [...new Set((issueIds ?? []).filter((id) => typeof id === 'string' && id))]
    if (allIds.length === 0) {
      return { status: 'skipped' as const, reason: 'no_issue_ids' }
    }
    const ids = allIds.slice(0, MAX_ISSUES_PER_RUN)
    const remainder = allIds.slice(MAX_ISSUES_PER_RUN)

    // ── Phase 1: which links do these issue ids map to? ─────────────────────
    // One batched read over the (provider, external_id) index rather than a
    // query per id. Anything unlinked — an issue created directly in Jira, or
    // one whose link was deleted — simply isn't in the result and is skipped,
    // which is also what makes a forged delivery for an unknown issue free.
    const links = await step.run('load-links', async () => {
      const supabase = getServiceClient()
      const { data } = await supabase
        .from('action_external_task')
        .select('id, action_id, external_id, external_scope, completed, workspace_id, external_state_label, last_push_error')
        .eq('provider', JIRA_PROVIDER)
        .in('external_id', ids)
      return (data ?? []) as WorkspaceLink[]
    })

    if (links.length === 0) {
      // Nothing to re-fetch for THESE ids — but the tail past the id cap has not
      // been looked at yet, and returning here without chaining it would drop it
      // silently. Unreachable from the receiver today (it caps a delivery at
      // MAX_ISSUES_PER_RUN, and the self-chain below never emits more than it
      // was handed), so this is a guard for any future caller that raises
      // `tasks/jira-remote-change` with a longer list — and for the chain code
      // in phase 3, which now sits directly on top of this early return.
      // `deferredIds` is necessarily empty here: the LINK cap is applied below,
      // over links that do not exist.
      if (remainder.length > 0) {
        await step.sendEvent('continue-remote-change', {
          name: 'tasks/jira-remote-change',
          data: { issueIds: remainder },
        })
        return {
          status: 'continued' as const,
          reason: 'no_links' as const,
          issues: ids.length,
          remaining: remainder.length,
        }
      }
      return { status: 'skipped' as const, reason: 'no_links', issues: ids.length }
    }

    // ── Phase 1b: take only as many LINKS as this run can afford ────────────
    // The id cap above bounds what the receiver hands us; it does not bound the
    // work, because one id can match links in any number of workspaces (Jira
    // issue ids are per-site sequences that every site starts at 10000, so a
    // guessed id hits real links across unrelated tenants). Each link is one
    // authenticated GET, sequential, inside the single step.run below.
    //
    // Split at an ID boundary rather than mid-id: the continuation event carries
    // ids, so a half-processed id would be re-loaded from the start next time
    // and could never finish. Taking at least one whole id per run — even one
    // that alone exceeds the cap — is what makes the deferred list STRICTLY
    // shorter every hop, which is the termination proof.
    const linksByIssueId = new Map<string, WorkspaceLink[]>()
    for (const link of links) {
      const group = linksByIssueId.get(link.external_id)
      if (group) group.push(link)
      else linksByIssueId.set(link.external_id, [link])
    }

    const due: WorkspaceLink[] = []
    const deferredIds: string[] = []
    for (const id of ids) {
      const group = linksByIssueId.get(id)
      // An id nothing links to costs nothing and is not worth chaining.
      if (!group) continue
      const wouldOverflow = due.length > 0 && due.length + group.length > MAX_LINKS_PER_RUN
      if (deferredIds.length > 0 || wouldOverflow) {
        // Once one id is deferred every later id is too, so the continuation
        // sees the delivery in its original order.
        deferredIds.push(id)
        continue
      }
      due.push(...group)
    }

    // ── Phase 2: per workspace, re-fetch each issue and apply ───────────────
    const outcome = await step.run('apply-remote-state', async () => {
      const supabase = getServiceClient()
      const results: ApplyRemoteResult[] = []
      const skipped: Array<{ workspaceId: string; reason: string }> = []

      const byWorkspace = new Map<string, WorkspaceLink[]>()
      for (const link of due) {
        const bucket = byWorkspace.get(link.workspace_id)
        if (bucket) bucket.push(link)
        else byWorkspace.set(link.workspace_id, [link])
      }

      for (const [workspaceId, workspaceLinks] of byWorkspace) {
        const state = await loadJiraSyncState(workspaceId)
        const cloudId = state?.config.cloud_id
        if (!state || !cloudId) {
          // Links survive a disconnect (they are Native Intelligence rows), so a workspace
          // whose Jira account is gone is an ordinary outcome, not an error.
          skipped.push({ workspaceId, reason: 'no_sync_state' })
          continue
        }

        const resolved = await getValidTokenForAccount(state.accountId)
        if (!resolved) {
          skipped.push({ workspaceId, reason: 'no_token' })
          continue
        }

        let aborted = false
        for (const link of workspaceLinks) {
          if (aborted) break

          let landing: JiraRemoteState
          let label: string | null
          // The site the LINK lives on, not the one the config points at today:
          // Jira issue ids are per-site and every site's start at 10000, so after
          // a destination switch the config's cloudId resolves an unrelated
          // issue on the new tenant.
          const issueCloudId = link.external_scope || cloudId
          try {
            const issue = await getIssue(resolved.token, issueCloudId, link.external_id, 'status')
            label = issueStatusName(issue)
            landing = jiraRemoteState(issueStatusCategoryKey(issue), label)
          } catch (err) {
            if (err instanceof JiraUnauthorizedError) {
              // The token died mid-run. Stop THIS workspace rather than the
              // whole run — unlike Asana, one invocation can span several
              // tenants and the others are unaffected.
              console.warn(
                `[jira-apply-remote] token rejected for workspace ${workspaceId}; ` +
                  'skipping its remaining links.',
              )
              skipped.push({ workspaceId, reason: 'unauthorized' })
              aborted = true
              break
            }
            if (err instanceof JiraApiError && err.status === 404) {
              // Unreadable: deleted in Jira — which is also how a
              // `jira:issue_deleted` delivery resolves, with no special casing —
              // OR no longer browsable by this account. Jira answers 404 for
              // both and never says which, so the marker is RETRYABLE: this
              // sweep and the next status change try again, and a restored
              // permission repairs itself. See jira-link-marker.ts.
              await stampJiraLinkMarker(supabase, link.id, JIRA_TASK_MISSING)
              results.push({ linkId: link.id, outcome: 'task_missing' })
              continue
            }
            throw err // transient — let Inngest retry the step
          }

          // The issue read fine, so any earlier "couldn't read it" marker is
          // stale — retire it. No-op (and no write) when nothing is stored.
          await clearJiraLinkMarker(supabase, link.id, link.last_push_error)

          results.push(
            await applyRemoteTaskState({
              supabase,
              workspaceId,
              actorUserId: state.userId,
              link,
              ...landing,
            }),
          )

          // The status NAME, which the shared boolean contract can't carry.
          // Written independently of the outcome above — including the two that
          // write nothing to the action (`unchanged`, when only the name moved
          // within a category, and `no_target_state`, where the divergence this
          // label shows IS the outcome) — and only when it actually changed, so
          // a sweep over unchanged issues stays read-only.
          if (label !== link.external_state_label) {
            const { error } = await supabase
              .from('action_external_task')
              .update({ external_state_label: label })
              .eq('id', link.id)
            if (error) {
              console.warn(
                `[jira-apply-remote] could not update the status label for link ${link.id}:`,
                error.message,
              )
            }
          }
        }
      }

      return { results, skipped }
    })

    // ── Phase 3 (TOP LEVEL): self-chain everything both caps deferred ───────
    // step.sendEvent lives here, never inside a step.run callback.
    //
    // ONE chain for both bounds: the ids the LINK cap could not afford, then the
    // ids past the 25-id cap — i.e. the delivery's own order, resumed where this
    // run stopped.
    //
    // Chained even when a workspace aborted: the remainder may belong entirely
    // to healthy workspaces, and an unusable one costs the continuation a single
    // token resolve.
    const chained = [...deferredIds, ...remainder]
    if (chained.length > 0) {
      await step.sendEvent('continue-remote-change', {
        name: 'tasks/jira-remote-change',
        data: { issueIds: chained },
      })
      return {
        status: 'continued' as const,
        applied: outcome.results,
        skipped: outcome.skipped,
        remaining: chained.length,
      }
    }

    return {
      status: 'ok' as const,
      applied: outcome.results,
      skipped: outcome.skipped,
    }
  },
)
