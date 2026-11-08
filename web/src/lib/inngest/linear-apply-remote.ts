import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  getIssue,
  issueStateName,
  issueStateType,
  LinearUnauthorizedError,
} from '@/lib/integrations/linear-api'
import { LINEAR_PROVIDER, loadLinearSyncState } from '@/lib/tasks/linear-config'
import { linearBucketForStateType, linearRemoteState } from '@/lib/tasks/lifecycle'
import {
  clearLinearLinkMarker,
  stampLinearLinkMarker,
  LINEAR_TASK_MISSING,
} from '@/lib/tasks/linear-link-marker'
import {
  applyRemoteTaskState,
  type ApplyRemoteResult,
  type RemoteTaskLink,
} from '@/lib/tasks/apply-remote-task-state'

// =====================================================================
// Linear → Native Intelligence read-back (webhook fast path)
//
// Fired by the receiver (src/app/api/webhooks/linear/route.ts) with the issue
// UUIDs named in one delivery.
//
// THE RE-FETCH IS THE CORRECTNESS BOUNDARY — and, unusually for this codebase,
// NOT the security one. Linear signs its deliveries (hex HMAC-SHA256 over the
// raw body), so the receiver has already established that the caller holds the
// app's signing secret. But that secret is APP-level: every organization that
// installs the app shares it, so a signature proves "some installer", not "the
// owner of these issues". Re-reading each issue over the WORKSPACE'S OWN token
// is what makes a delivery's claims irrelevant — the worst a misdirected or
// replayed one can do is make us re-read an issue we already had permission to
// read and apply what Linear itself reports.
//
// It also disposes of an open research question rather than betting on it: the
// exact shape of the webhook's `data.state` (and of the `updatedFrom` key for a
// state change) could not be confirmed. Reading NEITHER makes that uncertainty
// structurally irrelevant. Everything applied below comes from `issue(id:)`.
//
// WHY THIS RESOLVES WORKSPACES ITSELF (the Asana sibling is handed one). Linear
// webhooks are app-level: one URL for the whole app, auto-provisioned per
// authorizing organization, so a delivery names an issue and an organization and
// nothing else. The link table is therefore the router: `(provider,
// external_id)` is indexed for exactly this, and one issue UUID may legitimately
// match links in SEVERAL workspaces (two Native Intelligence workspaces connected to the same
// Linear org). Each matched workspace resolves its OWN destination and token.
//
// FOLDING A STATE INTO THE SHARED CONTRACT. `applyRemoteTaskState` is shared
// verbatim with Asana and Jira, so the fold happens in `linearRemoteState`
// (src/lib/tasks/lifecycle.ts) and travels as that function's optional
// arguments — but derived PURELY FROM `WorkflowState.type`, never from a name:
//   - `remoteCompleted` from type `completed`;
//   - `remoteHint.category`, so a reopen into a `started` state lands in a
//     STARTED Native Intelligence state rather than the team default — and, because its mere
//     presence says the un-completion is unambiguous, so a CANCELLED action
//     follows the issue back out;
//   - `remoteCanceled` for types `canceled` and `duplicate`, which are
//     abandonment rather than completion.
// Jira needs `isCanceledStatusName` for that last bit because it has no canceled
// category; Linear has a real one, so the heuristic must NEVER be applied here.
// The part that fits nowhere (the state NAME) goes to `external_state_label`.
//
// A TYPE THIS BUILD DOESN'T RECOGNIZE IS NO SIGNAL AT ALL. `linearBucketForStateType`
// returns null for it, and the link is skipped: quietly deciding an unknown
// state means "not started" would let the read-back reopen work a user just
// closed. That is a real difference from the Jira path, whose statusCategory
// enum has no room for a new value.
//
// HOUSE RULE — no `step.*` inside a `step.run` callback: nesting them deadlocks
// silently in production. Each phase is ONE flat step.run, and the only
// step.sendEvent (the self-chain) is at the top level of the handler.
//
// WHAT IS ACTUALLY BOUNDED:
//   - at most MAX_ISSUES_PER_RUN (25) issue ids are accepted per invocation;
//   - at most MAX_LINKS_PER_RUN (50) LINKS are processed per invocation, which
//     is the real unit of cost — one authenticated GraphQL read each, issued
//     sequentially inside one step.run;
//   - everything either cap defers is SELF-CHAINED, in the delivered order;
//   - and the whole function is throttled to 30 runs/minute globally.
// An id whose OWN link count exceeds the link cap is still processed whole (a
// single id is never split across runs — the chain carries ids, not link
// cursors), which is what makes the deferred list strictly shorter every hop and
// guarantees the chain terminates.
// =====================================================================

interface RemoteChangeEventData {
  issueIds: string[]
  /**
   * The Linear organization the delivery claimed to come from, when it carried
   * one. A HINT for the sanity check below — never a requirement, and never
   * trusted for anything the re-fetch answers.
   */
  organizationId?: string
}

/** Issue IDS accepted per invocation. The remainder self-chains. */
const MAX_ISSUES_PER_RUN = 25

/**
 * Authenticated Linear reads per invocation — one per LINK, which is the unit
 * the work is actually measured in.
 *
 * 50 sequential GraphQL reads is a few seconds against `maxDuration = 300`
 * (src/app/api/inngest/route.ts), leaving room for the three retries Inngest
 * will spend on this step. It also sits far inside Linear's 5000 requests/hour
 * per user.
 */
const MAX_LINKS_PER_RUN = 50

/** A link row plus the workspace that owns it (the delivery doesn't say). */
interface WorkspaceLink extends RemoteTaskLink {
  workspace_id: string
  external_state_label: string | null
  external_url: string | null
  /** Stored `{ code, at }` marker — read only to retire it after a good read. */
  last_push_error: unknown
}

export const linearApplyRemote = inngest.createFunction(
  {
    id: 'linear-apply-remote-change',
    retries: 3,
    // UNKEYED, like the Jira sibling and unlike Asana's per-workspace cap: the
    // triggering event carries no workspace (see the header), and Inngest
    // evaluates the key against the event, not against anything the handler
    // later discovers. A flat ceiling still bounds the fan-out, it just shares
    // that ceiling across tenants instead of per-tenant.
    concurrency: [{ limit: 5 }],
    // Rate ceiling on a webhook-driven trigger. Deliveries are signed, so this
    // is not the anti-forgery measure it is for Jira — it is capacity control: a
    // bulk edit in Linear (a hundred issues moved at once) arrives as a burst,
    // and 30 runs/minute queues it rather than stampeding both our database and
    // the tenant's Linear quota.
    throttle: { limit: 30, period: '1m' },
    triggers: [{ event: 'tasks/linear-remote-change' }],
  },
  async ({ event, step }) => {
    const { issueIds, organizationId } = event.data as RemoteChangeEventData

    const allIds = [...new Set((issueIds ?? []).filter((id) => typeof id === 'string' && id))]
    if (allIds.length === 0) {
      return { status: 'skipped' as const, reason: 'no_issue_ids' }
    }
    const ids = allIds.slice(0, MAX_ISSUES_PER_RUN)
    const remainder = allIds.slice(MAX_ISSUES_PER_RUN)

    // ── Phase 1: which links do these issue ids map to? ─────────────────────
    // One batched read over the (provider, external_id) index rather than a
    // query per id. Anything unlinked — an issue created directly in Linear, or
    // one whose link was deleted — simply isn't in the result and is skipped.
    const links = await step.run('load-links', async () => {
      const supabase = getServiceClient()
      const { data } = await supabase
        .from('action_external_task')
        .select(
          'id, action_id, external_id, completed, workspace_id, external_state_label, external_url, last_push_error',
        )
        .eq('provider', LINEAR_PROVIDER)
        .in('external_id', ids)
      return (data ?? []) as WorkspaceLink[]
    })

    if (links.length === 0) {
      // Nothing to re-fetch for THESE ids — but the tail past the id cap has not
      // been looked at yet, and returning here without chaining it would drop it
      // silently. Unreachable from the receiver today (it caps a delivery at 25
      // and the self-chain never emits more than it was handed), so this guards
      // any future caller that raises the event with a longer list.
      if (remainder.length > 0) {
        await step.sendEvent('continue-remote-change', {
          name: 'tasks/linear-remote-change',
          data: { issueIds: remainder, ...(organizationId ? { organizationId } : {}) },
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
    // The id cap bounds what the receiver hands us; it does not bound the work,
    // because one id can match links in any number of workspaces. Each link is
    // one authenticated read, sequential, inside the single step.run below.
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
        const state = await loadLinearSyncState(workspaceId)
        if (!state) {
          // Links survive a disconnect (they are Native Intelligence rows), so a workspace
          // whose Linear account is gone is an ordinary outcome, not an error.
          skipped.push({ workspaceId, reason: 'no_sync_state' })
          continue
        }

        // DEFENCE IN DEPTH, not authentication (the signature is that). The
        // delivery names an organization; this workspace's connection belongs to
        // exactly one. A mismatch means a delivery from one Linear org somehow
        // reached links belonging to another — impossible through the normal
        // path, so treat it as one and do nothing rather than re-reading issues
        // this token has no business reading.
        //
        // Only checked when BOTH sides are known: a delivery without the field,
        // or a config saved before organization_id was stored, is ordinary.
        const configuredOrg = state.config.organization_id
        if (organizationId && configuredOrg && organizationId !== configuredOrg) {
          skipped.push({ workspaceId, reason: 'organization_mismatch' })
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

          let issue
          try {
            issue = await getIssue(resolved.token, link.external_id)
          } catch (err) {
            if (err instanceof LinearUnauthorizedError) {
              // The token died mid-run. Stop THIS workspace rather than the
              // whole run — one invocation can span several tenants and the
              // others are unaffected.
              console.warn(
                `[linear-apply-remote] token rejected for workspace ${workspaceId}; ` +
                  'skipping its remaining links.',
              )
              skipped.push({ workspaceId, reason: 'unauthorized' })
              aborted = true
              break
            }
            throw err // transient — let Inngest retry the step
          }

          // Null OR trashed. Linear answers a bare `{ data: { issue: null } }`
          // with no errors entry for deleted, invisible AND never-existed
          // alike, and `trashed` is its 30-day delete grace window — all of
          // them "gone for now, possibly back". RETRYABLE, never terminal: this
          // path and the 6-hourly sweep keep trying, and a restored permission
          // repairs itself. See linear-link-marker.ts.
          //
          // `archivedAt` deliberately does NOT land here: Linear auto-archives
          // old completed issues, so an archived issue is a perfectly real one
          // whose state must still apply.
          if (!issue || issue.trashed === true) {
            await stampLinearLinkMarker(supabase, link.id, LINEAR_TASK_MISSING)
            results.push({ linkId: link.id, outcome: 'task_missing' })
            continue
          }

          const type = issueStateType(issue)
          const label = issueStateName(issue)

          // The issue read fine, so any earlier "couldn't read it" marker is
          // stale — retire it. No-op (and no write) when nothing is stored.
          await clearLinearLinkMarker(supabase, link.id, link.last_push_error)

          // An unknown/absent state type is NO SIGNAL. Skip applying rather than
          // defaulting: deciding a state this build has never seen means "not
          // started" would reopen work a user just closed. The label still
          // updates below, so the UI shows what Linear actually says.
          if (linearBucketForStateType(type) === null) {
            results.push({ linkId: link.id, outcome: 'unchanged' })
          } else {
            results.push(
              await applyRemoteTaskState({
                supabase,
                workspaceId,
                actorUserId: state.userId,
                link,
                ...linearRemoteState(type),
              }),
            )
          }

          // The display fields the shared boolean contract can't carry: the
          // state NAME, and the issue URL.
          //
          // The URL is refreshed because Linear rewrites an issue's identifier
          // — and with it its canonical URL — when the issue moves to another
          // team. That is precisely the drift this re-fetch exists to absorb,
          // and keeping the push-time URL would leave "Open in Linear" pointing
          // at a retired identifier that works only while Linear keeps
          // redirecting it. A missing url is never written back as null: an
          // absent field means the read didn't say, not that the issue lost its
          // URL.
          //
          // Written independently of the outcome above — including the ones that
          // write nothing to the action — and only for fields that ACTUALLY
          // changed, so a sweep over unchanged issues stays read-only.
          const url = typeof issue.url === 'string' && issue.url ? issue.url : null
          const patch: Record<string, string | null> = {}
          if (label !== link.external_state_label) patch.external_state_label = label
          if (url !== null && url !== link.external_url) patch.external_url = url

          if (Object.keys(patch).length > 0) {
            const { error } = await supabase
              .from('action_external_task')
              .update(patch)
              .eq('id', link.id)
            if (error) {
              console.warn(
                `[linear-apply-remote] could not update the display fields for link ${link.id}:`,
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
    const chained = [...deferredIds, ...remainder]
    if (chained.length > 0) {
      await step.sendEvent('continue-remote-change', {
        name: 'tasks/linear-remote-change',
        data: { issueIds: chained, ...(organizationId ? { organizationId } : {}) },
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
