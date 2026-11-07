import crypto from 'crypto'
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { resolveWorkForDeliverable } from '@/lib/work/resolve'
import { completeActionsForMergedPr } from '@/lib/actions/agent-finish'
import { emitPrStatusChange } from '@/lib/flows/emit-pr-status-change'
import { ciEventFrom, handleCiFailure } from '@/lib/coding/ci-fix'
import { prChangeFromPullRequest, recordPrChange, recordPrCiFailure } from '@/lib/agent-events/pr-changed'

/**
 * POST /api/webhooks/github — Handle GitHub webhook events.
 *
 * Supports:
 * - pull_request.opened / edited — auto-link PRs mentioning action identifiers (e.g. ENG-42)
 * - pull_request.closed — update PR state to closed/merged
 * - pull_request.reopened — update PR state back to open
 * - pull_request.synchronize — update sync timestamp
 * - pull_request.ready_for_review — the person took a proactive run's draft
 *   (P10 F4): its suggested bug action is confirmed
 * - check_suite.completed / check_run.completed with a failing conclusion —
 *   on a branch a coding run created, and only when that run's owner switched
 *   on the ci_fix_loop recipe for the repo, start one fix run, two at most per
 *   PR, then the starter's chat says CI is still red (src/lib/coding/ci-fix.ts, P10 F7).
 *   Every other check event, and any branch we didn't create, is ignored.
 *
 * opened, closed (merged or not) and reopened also fire the linked actions'
 * workspaces' pr_status_changed loops (emitPrStatusChange, F1): once per
 * linked action, keyed on the X-GitHub-Delivery id.
 *
 * The agent hears of a PR that is the person's own work (docs/plans/now-file.md
 * "PR updates"): a merge, a close or a reopen from the repo's own people, and a
 * failing check on a coding run's branch the CI fix loop isn't handling, each
 * one templated `pr.changed` event per person (repo, number, state, action;
 * never the title or body) and, for an action-linked PR, a log line
 * (src/lib/agent-events/pr-changed.ts).
 *
 * Requires GITHUB_WEBHOOK_SECRET env var for HMAC signature verification.
 */
export async function POST(request: Request) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET
  if (!secret) {
    console.error('GITHUB_WEBHOOK_SECRET is not configured')
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 })
  }

  // Verify HMAC signature
  const signature = request.headers.get('x-hub-signature-256')
  const body = await request.text()

  if (!signature || !verifySignature(secret, body, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  const event = request.headers.get('x-github-event')
  // GitHub's id for this delivery: a redelivery fires a loop once.
  const deliveryId = request.headers.get('x-github-delivery')
  const payload = JSON.parse(body)

  if (event === 'ping') {
    return NextResponse.json({ ok: true })
  }

  // A failing check on one of our own branches (P10 F7). The signature is
  // already verified above, like every other event.
  if (event === 'check_suite' || event === 'check_run') {
    const ci = ciEventFrom(event, payload)
    if (!ci) return NextResponse.json({ ok: true, skipped: true })
    const service = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false, autoRefreshToken: false } },
    )
    const outcome = await handleCiFailure(service, ci)
    // A failure the fix loop leaves alone reaches the agent instead (never throws).
    await recordPrCiFailure(service, ci, outcome)
    return NextResponse.json({ ok: true, ...outcome })
  }

  if (event !== 'pull_request') {
    return NextResponse.json({ ok: true, skipped: true })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  )

  const action = payload.action as string
  const pr = payload.pull_request
  const repo = payload.repository
  const repoFullName = repo.full_name as string
  const prNumber = pr.number as number
  const prUrl = pr.html_url as string
  const prTitle = pr.title as string
  const prDraft = pr.draft as boolean
  const headBranch = pr.head?.ref as string | undefined
  const prState = pr.merged ? 'merged' : (pr.state as string)
  // Only a PR from the repo's own people fires loops (F1 review): a stranger's
  // PR on a public repo that mentions ENG-42 must not run a workspace's
  // automations. Linking and state sync are unchanged.
  const firesLoops = LOOP_FIRING_AUTHORS.has(String(pr.author_association ?? ''))

  if (action === 'opened' || action === 'edited') {
    // Scan title and body for action identifiers like ENG-42, PROJ-123
    const text = `${prTitle} ${pr.body || ''}`
    const identifiers = extractActionIdentifiers(text)

    if (identifiers.length === 0) {
      return NextResponse.json({ ok: true, linked: 0 })
    }

    // Find which workspaces have GitHub connected and access to this repo
    // We look up connected accounts for GitHub to find workspace IDs
    const { data: githubAccounts } = await supabase
      .from('connected_account')
      .select('user_id, workspace_id')
      .eq('provider', 'github')
      .eq('capability', 'github')

    if (!githubAccounts || githubAccounts.length === 0) {
      return NextResponse.json({ ok: true, linked: 0, reason: 'no_github_accounts' })
    }

    let totalLinked = 0
    // The actions this PR is now linked to: an opened PR fires their
    // workspaces' pr_status_changed loops (emitPrStatusChange).
    const linked: Array<{ workspace_id: string; action_id: string }> = []

    // For each workspace with GitHub connected, try to match identifiers to actions
    const workspaceIds = [...new Set(githubAccounts.map((a) => a.workspace_id))]

    for (const wsId of workspaceIds) {
      // Look up actions by identifier in this workspace
      const { data: actions } = await supabase
        .from('actions')
        .select('id, identifier')
        .eq('workspace_id', wsId)
        .in('identifier', identifiers)

      if (!actions || actions.length === 0) continue

      // Link each matching action to this PR
      for (const act of actions) {
        const { error } = await supabase
          .from('action_github_pr')
          .upsert(
            {
              workspace_id: wsId,
              action_id: act.id,
              pr_url: prUrl,
              repo_full_name: repoFullName,
              pr_number: prNumber,
              pr_title: prTitle,
              pr_state: prState,
              pr_draft: prDraft,
              head_branch: headBranch || null,
              last_synced_at: new Date().toISOString(),
            },
            { onConflict: 'action_id,repo_full_name,pr_number' },
          )

        if (!error) {
          totalLinked++
          linked.push({ workspace_id: wsId, action_id: act.id })
        }
      }
    }

    // A PR opening is a state change; an edit that only links it is not.
    if (action === 'opened' && firesLoops) {
      await emitPrStatusChange({ links: linked, repoFullName, prNumber, prState: 'open', deliveryId })
    }

    return NextResponse.json({ ok: true, linked: totalLinked })
  }

  if (action === 'closed' || action === 'reopened' || action === 'synchronize') {
    // Update all existing links for this PR
    const updateData: Record<string, unknown> = {
      pr_state: prState,
      pr_draft: prDraft,
      pr_title: prTitle,
      last_synced_at: new Date().toISOString(),
    }

    const { data: updated } = await supabase
      .from('action_github_pr')
      .update(updateData)
      .eq('repo_full_name', repoFullName)
      .eq('pr_number', prNumber)
      .select('id, workspace_id, action_id')

    // Closing, merging and reopening are state changes: each linked action's
    // workspace runs its pr_status_changed loops (a push, synchronize, is not).
    if ((action === 'closed' || action === 'reopened') && firesLoops) {
      await emitPrStatusChange({
        links: (updated ?? []) as Array<{ workspace_id: string; action_id: string }>,
        repoFullName,
        prNumber,
        prState: pr.merged ? 'merged' : action === 'closed' ? 'closed' : 'open',
        deliveryId,
      })
      // The agent of each person whose own work it is hears of it (never throws).
      const change = prChangeFromPullRequest(action, payload, deliveryId)
      if (change) await recordPrChange(supabase, change, { links: (updated ?? []) as Array<{ workspace_id: string; action_id: string }> })
    }

    // A merged PR is the human verb on a coding run's deliverable: the work
    // item waiting on it stops waiting (ACTIVITY-AND-REVIEW-DESIGN §4.3).
    // Keyed on the PR url, which is what the run's deliverable carries.
    if (action === 'closed' && pr.merged) {
      await resolveWorkForDeliverable(supabase, { type: 'pr', id: prUrl })
      // The merge is what ships a coding agent's work: the action its run
      // worked is Done, including when the person marked the job Reviewed
      // before the merge (decision 9; that Reviewed left the action open).
      await completeActionsForMergedPr(supabase, prUrl)
    }

    return NextResponse.json({ ok: true, updated: updated?.length || 0 })
  }

  if (action === 'ready_for_review') {
    // A proactive run's draft marked ready by a person (P10 F4): the bug it
    // filed as a suggestion becomes a confirmed action. Only actions that
    // path filed, only while still suggested, only those linked to this PR.
    const { data: links } = await supabase
      .from('action_github_pr')
      .select('workspace_id, action_id')
      .eq('repo_full_name', repoFullName)
      .eq('pr_number', prNumber)
    let confirmed = 0
    for (const link of (links ?? []) as Array<{ workspace_id: string; action_id: string }>) {
      const { data: rows } = await supabase
        .from('actions')
        .update({ confirmation: 'confirmed' })
        .eq('id', link.action_id)
        .eq('workspace_id', link.workspace_id)
        .eq('confirmation', 'suggested')
        .eq('context_data->>proactive_coding', 'true')
        .select('id')
      confirmed += rows?.length ?? 0
    }
    return NextResponse.json({ ok: true, confirmed })
  }

  return NextResponse.json({ ok: true, skipped: true })
}

/**
 * The pull_request.author_association values whose PRs fire pr_status_changed
 * loops: the repo's owner, its org's members and its collaborators. Never a
 * CONTRIBUTOR, FIRST_TIMER, FIRST_TIME_CONTRIBUTOR, MANNEQUIN or NONE.
 */
const LOOP_FIRING_AUTHORS: ReadonlySet<string> = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

function verifySignature(secret: string, payload: string, signature: string): boolean {
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`
  const expectedBuf = new Uint8Array(Buffer.from(expected))
  const providedBuf = new Uint8Array(Buffer.from(signature))
  // timingSafeEqual throws on unequal-length buffers (a malformed/absent/truncated
  // signature). Guard the length first so we return a clean false → 401, never a 500.
  if (expectedBuf.length !== providedBuf.length) return false
  return crypto.timingSafeEqual(expectedBuf, providedBuf)
}

/**
 * Extract action identifiers from text.
 * Matches patterns like ENG-42, PROJ-123, BUG-1.
 * Must be uppercase letters followed by a dash and digits.
 */
function extractActionIdentifiers(text: string): string[] {
  const matches = text.match(/\b([A-Z]+-\d+)\b/g)
  return matches ? [...new Set(matches)] : []
}
