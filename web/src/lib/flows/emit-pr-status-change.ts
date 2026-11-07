import { inngest } from '@/lib/inngest/client'

/**
 * Emit `flow/pr.status_changed` for a GitHub pull request whose state just
 * changed (opened, closed, merged, reopened), once per action it is LINKED to
 * (action_github_pr). Called by the GitHub webhook
 * (src/app/api/webhooks/github/route.ts); flowDispatchOnPrStatusChange
 * (src/lib/inngest/flow-functions.ts) matches the workspace's enabled
 * pr_status_changed loops on the repo and state and fires them with the
 * linked action as the entity.
 *
 * Only a LINK puts a PR in a workspace: an event never fans out to a
 * workspace no action of which the PR names, so a loop sees PRs of the repo
 * its author named (PrStatusChangedTriggerConfig.repo_full_name) that touch
 * its own work.
 *
 * Awaited by the webhook (a webhook can wait), but it never throws: a failed
 * send is logged and the webhook still answers GitHub. Each event carries an
 * idempotency id from GitHub's delivery id, so a redelivered webhook fires a
 * loop once.
 */
export async function emitPrStatusChange(args: {
  links: ReadonlyArray<{ workspace_id: string; action_id: string }>
  repoFullName: string
  prNumber: number
  prState: 'open' | 'closed' | 'merged'
  /** GitHub's X-GitHub-Delivery id, when present. */
  deliveryId?: string | null
  firedAt?: string
}): Promise<number> {
  const seen = new Set<string>()
  const events = []
  for (const link of args.links) {
    if (!link.workspace_id || !link.action_id) continue
    const key = `${link.workspace_id}:${link.action_id}`
    if (seen.has(key)) continue
    seen.add(key)
    events.push({
      name: 'flow/pr.status_changed' as const,
      ...(args.deliveryId ? { id: `pr-status:${args.deliveryId}:${link.action_id}` } : {}),
      data: {
        workspace_id: link.workspace_id,
        action_id: link.action_id,
        repo_full_name: args.repoFullName,
        pr_number: args.prNumber,
        pr_state: args.prState,
        fired_at: args.firedAt ?? new Date().toISOString(),
      },
    })
  }
  if (events.length === 0) return 0
  try {
    await inngest.send(events)
    return events.length
  } catch (err) {
    console.error('[flows] pr status inngest.send failed', err)
    return 0
  }
}
