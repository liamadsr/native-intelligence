/**
 * PR updates (docs/plans/now-file.md "PR updates", Slice 2): a GitHub pull
 * request that is the person's own work changed, and their agent hears of it
 * as ONE templated `pr.changed` event (migration 443), plus a `pr_changed`
 * log line when the PR is linked to an action of theirs.
 *
 * The GitHub webhook (src/app/api/webhooks/github/route.ts) hands it:
 *   • a PR merged, closed without merging or reopened (recordPrChange). The
 *     webhook calls it only for a PR from the repo's own people (OWNER,
 *     MEMBER or COLLABORATOR: `firesLoops`, the check that fires loops);
 *   • a failing check on a coding run's branch (recordPrCiFailure), only
 *     while the CI fix loop isn't handling it (src/lib/coding/ci-fix.ts: its
 *     outcome says the loop is off for the run's starter, or the run works no
 *     action; whenever the loop is on it fixes, retries and posts "CI still
 *     red" itself), only for the PR GitHub matched to the failing commit in
 *     this repo (a fork's check names none), once per head commit.
 *
 * WHOSE WORK (decision 8: PRs that touch the person's own work only):
 *   • an action's assignees: action_github_pr → action_assignee (093) and
 *     actions.assignee_id (member ids) → member.user_id;
 *   • a coding run's starter: agent_run.triggered_by, found by repo and
 *     branch as ci-fix.ts finds it (pr_url has no index), only on the PR's
 *     own branch in the base repo (a fork's same-named branch is not ours);
 *   • a Mac session's person: local_agent_session.pr_url (418).
 * Nobody else in a workspace hears of it.
 *
 * TRUSTED REPOS. Linking matches identifiers in any PR's title or body, in
 * every workspace with GitHub connected, so an action link alone proves
 * nothing. An assignee hears of it only when the repo is the workspace's: the
 * workspace has a GitHub connection and one of its projects links that repo
 * (projects.github_repo, 066), or the PR is one of the workspace's own coding
 * runs' or Mac sessions'.
 *
 * TEMPLATED: the repo (GitHub's own characters), the number, the state and
 * the action's identifier. Never the PR's title or body, so no outside text
 * reaches the agent this way. The ref is `github_pr` / `owner/name#7`, the
 * Now file's `pr` track id.
 *
 * The router routes it quiet and never asks Jev (router.ts JEV_NEVER_KINDS):
 * "while you were away", the digest and the check-in show it. Never throws
 * into the webhook: a lost event is a gap, never a failed delivery.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendLogLine, logDedupeKey, logLineFor } from '@/lib/log/agent-log'
import { isRepoFullName } from '@/lib/environments/types'
import { githubPrUrl } from '@/lib/coding/ci-red'
import { NI_BRANCH_PREFIX, prNumberOf, type CiEvent, type CiFixOutcome } from '@/lib/coding/ci-fix'
import { recordAgentEvents, type AgentEventInput, type RecordAgentEventsDeps } from './record'
import { agentEventKey, type PrChangeState } from './types'

/** A PR event's ref type; its id is `owner/name#7` (prRefId). */
export const PR_REF_TYPE = 'github_pr'
/** At most this many people hear of one change (a PR linked to many actions). */
export const PR_CHANGE_MAX_RECIPIENTS = 50
/** At most this many linked actions are read for one change. */
const MAX_LINKS = 50

/** A PR's ref id, the Now file's `pr` track id. Pure. */
export function prRefId(repoFullName: string, prNumber: number): string {
  // Lower case, as the Now file's pr tracks are (canonicalTrackId): GitHub's repo names ignore case.
  return `${repoFullName.toLowerCase()}#${prNumber}`
}

/** One change to one pull request, as the webhook saw it. */
export interface PrChange {
  repoFullName: string
  prNumber: number
  prUrl: string
  state: PrChangeState
  /** What pins this change in the dedupe key: the instant it happened (ms), else the delivery; a CI failure's commit. */
  pin: string
  /** When it happened (ISO); null for now. */
  at: string | null
  /** The PR's head branch, and the repo that branch lives in (a fork's is another). */
  headBranch: string | null
  headRepoFullName: string | null
}

/** An action link (action_github_pr), as the webhook's update returns it. */
export interface PrLink {
  workspace_id: string
  action_id: string
}

/** How a PR is the person's: an action of theirs, their coding run, their Mac session. */
export type PrRecipientVia = 'assignee' | 'coding_run' | 'local_agent'

export interface PrRecipient {
  workspaceId: string
  userId: string
  via: Set<PrRecipientVia>
  /** The linked action the event names, when there is one. */
  actionId: string | null
}

/** A coding run as this file reads it (ci-fix.ts's lookup). */
interface CodingRunRow {
  workspace_id?: unknown
  triggered_by?: unknown
  action_id?: unknown
  pr_url?: unknown
  status?: unknown
}

const SHA_RE = /^[0-9a-f]{7,64}$/
const DELIVERY_RE = /^[A-Za-z0-9-]{1,100}$/
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/**
 * A `pull_request` payload's change worth telling, or null: closed (merged or
 * not) or reopened, with a well-formed repo, number and github.com link of
 * the same PR. Reads nothing of the title or body. Pure.
 */
export function prChangeFromPullRequest(action: string, payload: unknown, deliveryId?: string | null): PrChange | null {
  if (action !== 'closed' && action !== 'reopened') return null
  const p = (payload ?? {}) as { pull_request?: Record<string, unknown> | null; repository?: { full_name?: unknown } | null }
  const pr = p.pull_request ?? {}
  const repo = p.repository?.full_name
  const n = pr.number
  if (!isRepoFullName(repo) || typeof n !== 'number' || !Number.isInteger(n) || n <= 0) return null
  const prUrl = githubPrUrl(pr.html_url)
  if (!prUrl || prNumberOf(prUrl, repo) !== n) return null
  const state: PrChangeState = action === 'reopened' ? 'reopened' : pr.merged === true ? 'merged' : 'closed'
  const atRaw = state === 'merged' ? pr.merged_at : state === 'closed' ? pr.closed_at : pr.updated_at
  const ms = typeof atRaw === 'string' ? Date.parse(atRaw) : NaN
  const delivery = typeof deliveryId === 'string' && DELIVERY_RE.test(deliveryId) ? deliveryId : null
  const head = (pr.head ?? {}) as { ref?: unknown; repo?: { full_name?: unknown } | null }
  return {
    repoFullName: repo,
    prNumber: n,
    prUrl,
    state,
    pin: Number.isFinite(ms) ? String(ms) : (delivery ?? 'once'),
    at: Number.isFinite(ms) ? new Date(ms).toISOString() : null,
    headBranch: str(head.ref),
    headRepoFullName: str(head.repo?.full_name),
  }
}

/** The branch is a coding run's or a Mac session's (dial8/…) in the base repo itself, not a fork. Pure. */
function ownBranch(change: PrChange): boolean {
  return !!change.headBranch?.startsWith(NI_BRANCH_PREFIX) && change.headRepoFullName?.toLowerCase() === change.repoFullName.toLowerCase()
}

const ids = (rows: unknown, col: string): string[] => [
  ...new Set(((Array.isArray(rows) ? rows : []) as Array<Record<string, unknown>>).map((r) => r[col]).filter((v): v is string => typeof v === 'string' && !!v)),
]

/** Read rows or throw (recordPrChange catches). */
async function read(q: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await q
  if (error) throw new Error(`${what} read failed: ${error.message}`)
  return (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>
}

/**
 * Whose own work this PR is (the header's three links), after the repo
 * check, with the action each event names. `runs` is the coding-run lookup
 * when the caller already did it (a CI failure). Throws on a failed read.
 */
export async function findPrRecipients(
  supabase: SupabaseClient,
  change: PrChange,
  opts: { links?: readonly PrLink[] | null; runs?: readonly CodingRunRow[] } = {},
): Promise<{ recipients: PrRecipient[]; identifiers: Map<string, string> }> {
  const own = ownBranch(change)
  const runRows =
    opts.runs ??
    (own
      ? await read(
          supabase
            .from('agent_run')
            .select('workspace_id, triggered_by, action_id, pr_url, status')
            .eq('repo_full_name', change.repoFullName)
            .eq('branch', change.headBranch!)
            .eq('kind', 'coding')
            .is('ci_fix_of_run_id', null)
            .order('created_at', { ascending: false })
            .limit(5),
          'agent_run',
        )
      : [])
  const runs = runRows.filter(
    (r) => typeof r.workspace_id === 'string' && typeof r.triggered_by === 'string' && typeof r.pr_url === 'string' && prNumberOf(r.pr_url, change.repoFullName) === change.prNumber,
  ) as Array<{ workspace_id: string; triggered_by: string; action_id?: unknown }>
  const sessions = own
    ? (await read(supabase.from('local_agent_session').select('workspace_id, user_id').eq('pr_url', change.prUrl).limit(20), 'local_agent_session')).filter(
        (s): s is { workspace_id: string; user_id: string } => typeof s.workspace_id === 'string' && typeof s.user_id === 'string',
      )
    : []
  const links = (
    opts.links ??
    (await read(
      supabase.from('action_github_pr').select('workspace_id, action_id').eq('repo_full_name', change.repoFullName).eq('pr_number', change.prNumber).limit(MAX_LINKS),
      'action_github_pr',
    ))
  )
    .filter((l): l is PrLink => typeof l?.workspace_id === 'string' && typeof l?.action_id === 'string')
    .slice(0, MAX_LINKS)

  const linkActionIds = [...new Set(links.map((l) => l.action_id))]
  const actionIds = [...new Set([...linkActionIds, ...runs.map((r) => r.action_id).filter((a): a is string => typeof a === 'string')])]
  const actions = actionIds.length
    ? await read(supabase.from('actions').select('id, workspace_id, identifier, assignee_id').in('id', actionIds), 'actions')
    : []
  const actionById = new Map(actions.filter((a) => typeof a.id === 'string').map((a) => [a.id as string, a]))
  const assigneeRows = linkActionIds.length
    ? await read(supabase.from('action_assignee').select('action_id, member_id').in('action_id', linkActionIds), 'action_assignee')
    : []
  // Each linked action's member ids: its assignees (093) and its assignee_id (022).
  const membersOf = new Map<string, Set<string>>()
  const addMember = (actionId: unknown, memberId: unknown) => {
    if (typeof actionId !== 'string' || typeof memberId !== 'string' || !memberId) return
    if (!membersOf.has(actionId)) membersOf.set(actionId, new Set())
    membersOf.get(actionId)!.add(memberId)
  }
  for (const a of assigneeRows) addMember(a.action_id, a.member_id)
  for (const id of linkActionIds) addMember(id, actionById.get(id)?.assignee_id)
  const memberIds = [...new Set([...membersOf.values()].flatMap((s) => [...s]))]
  const members = memberIds.length ? await read(supabase.from('member').select('id, workspace_id, user_id').in('id', memberIds), 'member') : []
  const memberById = new Map(members.filter((m) => typeof m.id === 'string').map((m) => [m.id as string, m]))

  const byPerson = new Map<string, PrRecipient>()
  const add = (workspaceId: string, userId: string, via: PrRecipientVia, actionId: string | null) => {
    const key = `${workspaceId}:${userId}`
    const r = byPerson.get(key) ?? { workspaceId, userId, via: new Set<PrRecipientVia>(), actionId: null }
    r.via.add(via)
    if (!r.actionId && actionId) r.actionId = actionId
    byPerson.set(key, r)
  }
  // Sorted by identifier, so a person on two linked actions is told the same one every time.
  const ident = (id: string) => String(actionById.get(id)?.identifier ?? id)
  for (const link of [...links].sort((a, b) => ident(a.action_id).localeCompare(ident(b.action_id)))) {
    const action = actionById.get(link.action_id)
    if (!action || action.workspace_id !== link.workspace_id) continue
    for (const memberId of membersOf.get(link.action_id) ?? []) {
      const m = memberById.get(memberId)
      if (!m || m.workspace_id !== link.workspace_id || typeof m.user_id !== 'string') continue
      add(link.workspace_id, m.user_id, 'assignee', link.action_id)
    }
  }
  for (const run of runs) add(run.workspace_id, run.triggered_by, 'coding_run', typeof run.action_id === 'string' ? run.action_id : null)
  for (const s of sessions) add(s.workspace_id, s.user_id, 'local_agent', null)

  // The repo check, for workspaces where only an action link names the PR.
  const ownWorkspaces = new Set([...runs.map((r) => r.workspace_id), ...sessions.map((s) => s.workspace_id)])
  const toCheck = [...new Set([...byPerson.values()].map((r) => r.workspaceId))].filter((w) => !ownWorkspaces.has(w))
  const trusted = new Set(ownWorkspaces)
  if (toCheck.length) {
    const [connected, projects] = await Promise.all([
      read(supabase.from('connected_account').select('workspace_id').eq('provider', 'github').eq('capability', 'github').in('workspace_id', toCheck), 'connected_account'),
      read(supabase.from('projects').select('workspace_id, github_repo').in('workspace_id', toCheck).not('github_repo', 'is', null), 'projects'),
    ])
    const withGithub = new Set(ids(connected, 'workspace_id'))
    const repo = change.repoFullName.toLowerCase()
    for (const p of projects) {
      if (typeof p.workspace_id === 'string' && withGithub.has(p.workspace_id) && typeof p.github_repo === 'string' && p.github_repo.trim().toLowerCase() === repo) {
        trusted.add(p.workspace_id)
      }
    }
  }

  const identifiers = new Map<string, string>()
  for (const [id, a] of actionById) identifiers.set(id, typeof a.identifier === 'string' && a.identifier ? a.identifier : id)
  const recipients = [...byPerson.values()].filter((r) => trusted.has(r.workspaceId)).slice(0, PR_CHANGE_MAX_RECIPIENTS)
  return { recipients, identifiers }
}

/** The event each person gets for one change. Pure. */
export function prChangedEvents(change: PrChange, recipients: readonly PrRecipient[], identifiers: ReadonlyMap<string, string>): AgentEventInput[] {
  return recipients.map((r) => {
    const action = r.actionId ? (identifiers.get(r.actionId) ?? null) : null
    return {
      workspaceId: r.workspaceId,
      userId: r.userId,
      kind: 'pr.changed' as const,
      // Failing checks block the work; a state change is news.
      priority: change.state === 'ci_failed' ? 2 : 1,
      occursAt: change.at,
      refType: PR_REF_TYPE,
      refId: prRefId(change.repoFullName, change.prNumber),
      facts: { repo: change.repoFullName, prNumber: change.prNumber, prState: change.state, ...(action ? { action } : {}) },
      dedupeKey: agentEventKey.prChanged(change.repoFullName, change.prNumber, change.state, change.pin),
    }
  })
}

/**
 * Whether a person gets the `pr_changed` log line: only through an action of
 * theirs, and not for their own coding run's merge, which its settle line
 * already logs (logWorkSettle, work/resolve.ts). Pure.
 */
export function prChangeLogged(change: Pick<PrChange, 'state'>, r: Pick<PrRecipient, 'via'>): boolean {
  return r.via.has('assignee') && !(change.state === 'merged' && r.via.has('coding_run'))
}

export interface PrChangeDeps extends RecordAgentEventsDeps {
  /** The log writer (appendLogLine); tests pass a spy. */
  appendLog?: typeof appendLogLine
}

/**
 * Tell each person whose own work the PR is: one `pr.changed` event each,
 * and the log line for an action-linked one. `links`: the action links the
 * webhook already holds (a close's update returns them). Returns how many
 * events newly landed. Never throws.
 */
export async function recordPrChange(
  supabase: SupabaseClient,
  change: PrChange,
  opts: { links?: readonly PrLink[] | null; runs?: readonly CodingRunRow[] } = {},
  deps: PrChangeDeps = {},
): Promise<number> {
  try {
    const { recipients, identifiers } = await findPrRecipients(supabase, change, opts)
    if (!recipients.length) return 0
    const landed = await recordAgentEvents(prChangedEvents(change, recipients, identifiers), supabase, deps)
    const appendLog = deps.appendLog ?? appendLogLine
    for (const r of recipients) {
      if (!prChangeLogged(change, r)) continue
      const action = r.actionId ? (identifiers.get(r.actionId) ?? null) : null
      const line = logLineFor({ type: 'pr_changed', repo: change.repoFullName, number: change.prNumber, state: change.state, action })
      if (!line) continue
      await appendLog(
        {
          workspaceId: r.workspaceId,
          userId: r.userId,
          kind: line.kind,
          line: line.line,
          refType: PR_REF_TYPE,
          refId: prRefId(change.repoFullName, change.prNumber),
          dedupeKey: logDedupeKey.prChanged(change.repoFullName, change.prNumber, change.state, change.pin),
          at: change.at,
        },
        supabase,
      )
    }
    return landed
  } catch (err) {
    console.warn('[agent-event] pr.changed skipped:', err instanceof Error ? err.message : String(err))
    return 0
  }
}

/**
 * The CI fix loop's outcomes that leave a failing check untold: the loop is
 * off for the run's starter, or the run works no action (the loop needs one).
 * Both come after ci-fix.ts's own checks (our dial8/ branch, a trusted check
 * app, our coding run with its PR open). Every other outcome means the loop
 * is handling it (a fix started, CI reported still red, a fix already under
 * way for the PR or this commit) or the event isn't ours: told nothing. A
 * reason added there later stays quiet here until it is listed.
 */
const CI_UNTOLD_REASONS: ReadonlySet<string> = new Set(['ci_fix_loop_off', 'no_action'])

/** Whether a failing check's outcome leaves it for the agent to hear. Pure. */
export function ciFailureUntold(outcome: CiFixOutcome): boolean {
  return outcome.handled === 'ignored' && CI_UNTOLD_REASONS.has(outcome.reason)
}

/**
 * A failing check on a coding run's branch that the fix loop isn't handling:
 * one `pr.changed` (state ci_failed) per person whose work the PR is, once
 * per head commit (a burst of check suites and runs for one commit is one
 * row). Only the PR GitHub matched to the commit in this repo (the check's
 * `pull_requests`; a fork's check names none). Returns how many events newly
 * landed. Never throws.
 */
export async function recordPrCiFailure(supabase: SupabaseClient, ev: CiEvent, outcome: CiFixOutcome, deps: PrChangeDeps = {}): Promise<number> {
  try {
    if (!ciFailureUntold(outcome)) return 0
    if (!isRepoFullName(ev.repoFullName) || !SHA_RE.test(ev.headSha) || !ev.branch.startsWith(NI_BRANCH_PREFIX)) return 0
    if (!ev.prNumbers?.length) return 0
    // ci-fix.ts's lookup: the run that made this branch and opened its PR.
    const runs = await read(
      supabase
        .from('agent_run')
        .select('workspace_id, triggered_by, action_id, pr_url, status')
        .eq('repo_full_name', ev.repoFullName)
        .eq('branch', ev.branch)
        .eq('kind', 'coding')
        .is('ci_fix_of_run_id', null)
        .order('created_at', { ascending: false })
        .limit(1),
      'agent_run',
    )
    const run = runs[0]
    const prUrl = githubPrUrl(run?.pr_url)
    if (!run || run.status !== 'pr_open' || !prUrl) return 0
    const prNumber = prNumberOf(prUrl, ev.repoFullName)
    if (!prNumber || !ev.prNumbers.includes(prNumber)) return 0
    const change: PrChange = {
      repoFullName: ev.repoFullName,
      prNumber,
      prUrl,
      state: 'ci_failed',
      pin: ev.headSha,
      at: null,
      headBranch: ev.branch,
      headRepoFullName: ev.repoFullName,
    }
    return await recordPrChange(supabase, change, { runs }, deps)
  } catch (err) {
    console.warn('[agent-event] pr.changed (ci) skipped:', err instanceof Error ? err.message : String(err))
    return 0
  }
}
