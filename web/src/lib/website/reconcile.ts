/**
 * An open website change nothing will move any more (roadmap track E): its
 * coding run ended without reaching the outcome route (a Stop, the reaper),
 * its card was answered or lapsed while a settle was lost, a merge or a
 * deploy watch died half way. At most one change is open per site (463), so
 * one stuck change would block every later one: before a new change starts,
 * and when the agent's section is read, a stale open change is settled from
 * what the run, the card and GitHub say now.
 *
 *   preparing    its run is over with no pull request (failed); its pull
 *                request is open but no card came within the wait (the card
 *                is raised now); it never got a run at all (failed).
 *   awaiting_yes its card is no longer pending: declined or lapsed.
 *   merging      stuck past a few minutes: merged on GitHub → deploying (and
 *                the watch starts), else back to failed.
 *   deploying    past the watch: live, unverified ("not seen").
 *
 * Best effort; never throws. Returns the change as it stands now, or null
 * when it is no longer open.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isAgentRunTerminal } from '@/lib/agent-run/types'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { failChange, finishMerge, raiseMergeCard, type ApprovalDeps } from './approval'
import { giveUpDeploy } from './deploy'
import { getPull, parsePullUrl, type GithubDeps } from './github'
import { getChange, getSite, updateChange } from './store'
import type { WebsiteChange } from './types'

type Svc = SupabaseClient

const MINUTE = 60_000
/** A run that started this long ago and still has no change row update is checked. */
export const STALE_PREPARING_MS = 10 * MINUTE
/** A pull request with no card after this long gets its card now (the preview wait is about four minutes). */
export const STALE_CARD_MS = 15 * MINUTE
export const STALE_MERGING_MS = 5 * MINUTE
/** The deploy watch runs about twenty minutes. */
export const STALE_DEPLOYING_MS = 45 * MINUTE
/** A merge card waits a day (approvals.ts APPROVAL_TTL_MS); with no row read back, a change waits a little longer. */
const CARD_LIFETIME_MS = 25 * 60 * MINUTE

export type ReconcileDeps = ApprovalDeps & {
  now?: () => number
  github?: (token: string) => GithubDeps
  token?: (svc: Svc, userId: string) => Promise<string | null>
}

function since(change: WebsiteChange, nowMs: number): number {
  const at = Date.parse(change.updatedAt ?? change.createdAt)
  return Number.isFinite(at) ? nowMs - at : Infinity
}

/** Failed, and the owner told (they were promised a text). */
async function failStuck(svc: Svc, change: WebsiteChange, reason: string, deps: ReconcileDeps): Promise<void> {
  const site = await getSite(svc, change.workspaceId, change.siteId)
  if (site) await failChange(svc, change, site, reason, deps)
  else await updateChange(svc, change.workspaceId, change.id, { state: 'failed', error: reason }, ['preparing', 'awaiting_yes', 'merging'])
}

export async function reconcileOpenChange(svc: Svc, change: WebsiteChange, deps: ReconcileDeps = {}): Promise<WebsiteChange | null> {
  const nowMs = (deps.now ?? Date.now)()
  const age = since(change, nowMs)
  try {
    if (change.state === 'preparing') {
      if (change.prNumber) {
        if (age < STALE_CARD_MS) return change
        await raiseMergeCard(svc, { workspaceId: change.workspaceId, changeId: change.id }, deps)
        return await getChange(svc, change.workspaceId, change.id)
      }
      if (change.agentRunId) {
        const { data } = await svc.from('agent_run').select('status, pr_url').eq('id', change.agentRunId).eq('workspace_id', change.workspaceId).maybeSingle()
        const run = data as { status?: string; pr_url?: string | null } | null
        const status = run?.status ?? null
        if (status && !isAgentRunTerminal(status)) return change
        if (!status && age < STALE_PREPARING_MS) return change
        // The run opened its PR but the outcome route's hook never recorded it: record it, and the card follows.
        const pull = status === 'pr_open' ? parsePullUrl(run?.pr_url) : null
        if (pull) {
          await updateChange(svc, change.workspaceId, change.id, { pr_number: pull.number, pr_url: run?.pr_url ?? null }, ['preparing'])
          await raiseMergeCard(svc, { workspaceId: change.workspaceId, changeId: change.id }, deps)
          return await getChange(svc, change.workspaceId, change.id)
        }
        await failStuck(svc, change, `the run ended (${status ?? 'gone'}) without a change`, deps)
        return null
      }
      if (age < STALE_PREPARING_MS) return change
      await failStuck(svc, change, 'it never started', deps)
      return null
    }
    if (change.state === 'awaiting_yes') {
      if (!change.approvalId) return change
      const { data } = await svc.from('tool_approval').select('status, expires_at, decided_at').eq('id', change.approvalId).eq('workspace_id', change.workspaceId).maybeSingle()
      const row = data as { status?: string; expires_at?: string; decided_at?: string | null } | null
      // No row read back: keep it until well past a card's day (approvals.ts APPROVAL_TTL_MS).
      if (!row) return age > CARD_LIFETIME_MS ? (await updateChange(svc, change.workspaceId, change.id, { state: 'expired' }, ['awaiting_yes']), null) : change
      const lapsed = row.status === 'pending' && !!row.expires_at && Date.parse(row.expires_at) < nowMs
      if (row.status === 'pending' && !lapsed) return change
      if (row.status === 'approved') {
        // A yes whose merge never got going (it failed before the change moved): failed and told, so the site is free.
        const decided = row.decided_at ? Date.parse(row.decided_at) : NaN
        if (!Number.isFinite(decided) || nowMs - decided < STALE_MERGING_MS) return change
        await failStuck(svc, change, 'the yes was taken but the merge never started', deps)
        return null
      }
      if (row.status === 'failed') {
        await failStuck(svc, change, 'the yes could not run', deps)
        return null
      }
      await updateChange(svc, change.workspaceId, change.id, { state: row.status === 'denied' ? 'declined' : 'expired' }, ['awaiting_yes'])
      return null
    }
    if (change.state === 'merging') {
      if (age < STALE_MERGING_MS || !change.prNumber) return change
      const site = await getSite(svc, change.workspaceId, change.siteId)
      const token = site ? await (deps.token ?? storedGithubToken)(svc, site.connectedBy) : null
      const pull = site && token ? await getPull(deps.github?.(token) ?? { token }, site.repoFullName, change.prNumber) : null
      if (site && pull?.ok && pull.value.merged && pull.value.mergeSha) {
        // The same finish as a yes's: the merge commit, a wiring's key live, the watch.
        await finishMerge(svc, change, site, pull.value.mergeSha, deps)
        return await getChange(svc, change.workspaceId, change.id)
      }
      await failStuck(svc, change, 'the merge was interrupted', deps)
      return null
    }
    if (change.state === 'deploying') {
      if (age < STALE_DEPLOYING_MS) return change
      await giveUpDeploy(svc, { workspaceId: change.workspaceId, changeId: change.id }, deps)
      return null
    }
    return null
  } catch (err) {
    console.warn('[website] reconcile skipped:', err instanceof Error ? err.message : String(err))
    return change
  }
}
