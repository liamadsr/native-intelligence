/**
 * C5, the server half (docs/plans/teammate-agent.md; WS-C): the pull request
 * for an edit job's branch, when the Mac has no signed-in `gh`. The desktop
 * (push.rs, desktop PR #70) has already pushed the job's own `dial8/…` branch
 * from the person's checkout, as the person, after their yes on the Mac. It
 * then posts here with the session token, and the server opens the pull
 * request with the person's Native Intelligence GitHub sign-in, the way a cloud coding
 * run's outcome does (src/app/api/internal/agent-run/outcome/route.ts):
 *
 *   - only the session's OWN branch (`dial8/<slug>-<its id's first 8>`, or
 *     exactly the branch its `branch` event named), only on github.com;
 *   - replay-safe: a session that already has its pull request answers with
 *     it, and GitHub's 422 "already exists" finds the open one for the branch;
 *   - the URL is kept on the session (migration 418), and the Mac's own
 *     `pull_request` event shows it in the thread.
 *
 * The repository is the one the Mac pushed to (its push URL, credentials
 * already removed): GitHub opens a pull request only where that branch is.
 * Nothing here pushes, and no credential reaches the Mac or the agent.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { lookupRepoDefaultBranch } from '@/lib/agent-run/github-default-branch'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { TERMINAL_STATUSES, loadSession, pushWasAllowed, recordPullRequest } from './store'
import {
  PR_BODY_MAX,
  PR_TITLE_MAX,
  codePoints,
  isPlainBranchName,
  isPullRequestUrl,
  isSessionBranch,
  parseRemoteRepo,
  repoFullName,
} from './pull-request'

type Svc = SupabaseClient

/** The session token's claims (la1, src/lib/local-agent/tokens.ts). */
export interface SessionTokenClaims {
  sid: string
  uid: string
  wid: string
}

export type OpenPullRequestResult =
  | { ok: true; url: string; reused?: true }
  | { ok: false; status: 400 | 404 | 409 | 502; code: string; error: string }

export interface OpenPullRequestDeps {
  fetchImpl?: typeof fetch
  /** The person's GitHub token (newest github/github, the coding runs' lookup); injectable for tests. */
  githubToken?: (svc: Svc, userId: string) => Promise<string | null>
}

/**
 * GitHub calls, at most, so the route answers inside the desktop's 30 s for it
 * (push.rs SERVER_TIMEOUT) and the Mac never records a failure for a pull
 * request the server went on to open: the stored PR's state (5 s, replays
 * only), the default branch (5 s, lookupRepoDefaultBranch's own), the create
 * (8 s) and, after a 422 or a create that may have landed, one lookup of the
 * open PR (5 s). 23 s at worst.
 */
const STATE_TIMEOUT_MS = 5_000
const CREATE_TIMEOUT_MS = 8_000
const LOOKUP_TIMEOUT_MS = 5_000

function fail(status: 400 | 404 | 409 | 502, code: string, error: string): OpenPullRequestResult {
  return { ok: false, status, code, error }
}

/** Control characters out, one line, trimmed (push.rs strips them from the title too). */
function cleanTitle(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length >= 1 && codePoints(t) <= PR_TITLE_MAX ? t : null
}

function githubHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

/** GitHub's own words, short, for the Mac's `pull_request` event (never a token: GitHub doesn't echo it). */
async function githubWhy(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: unknown; errors?: Array<{ message?: unknown }> }
    const parts = [body.message, ...(body.errors ?? []).map((e) => e?.message)].filter((m): m is string => typeof m === 'string' && !!m)
    return parts.join('; ').slice(0, 300) || `HTTP ${res.status}`
  } catch {
    return `HTTP ${res.status}`
  }
}

/** The open pull request for `head` in `repo`, when GitHub has one. */
async function findOpen(doFetch: typeof fetch, repo: string, owner: string, head: string, token: string): Promise<string | null> {
  try {
    const res = await doFetch(
      `https://api.github.com/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open&per_page=5`,
      { headers: githubHeaders(token), signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) },
    )
    if (!res.ok) return null
    const list = (await res.json()) as Array<{ html_url?: unknown }>
    const url = Array.isArray(list) ? list[0]?.html_url : null
    return isPullRequestUrl(url) ? url : null
  } catch {
    return null
  }
}

/** The pull request is still open on GitHub (false when closed, merged, gone, or GitHub can't say). */
async function isOpen(doFetch: typeof fetch, repo: string, number: string, token: string): Promise<boolean> {
  try {
    const res = await doFetch(`https://api.github.com/repos/${repo}/pulls/${number}`, {
      headers: githubHeaders(token),
      signal: AbortSignal.timeout(STATE_TIMEOUT_MS),
    })
    if (!res.ok) return false
    const pr = (await res.json()) as { state?: unknown; merged?: unknown }
    return pr.state === 'open' && pr.merged !== true
  } catch {
    return false
  }
}

/**
 * Open (or find) the pull request for the session's branch. `body` is the
 * desktop's JSON: `{ sessionId, remoteUrl, branch, base, title, body }`.
 */
export async function openSessionPullRequest(
  svc: Svc,
  claims: SessionTokenClaims,
  body: Record<string, unknown>,
  deps: OpenPullRequestDeps = {},
): Promise<OpenPullRequestResult> {
  if (body.sessionId !== undefined && body.sessionId !== claims.sid) {
    return fail(400, 'SESSION_MISMATCH', 'This token is for another session.')
  }
  const remote = parseRemoteRepo(body.remoteUrl)
  if (!remote) return fail(400, 'BAD_REMOTE', "The remote URL doesn't name a repository.")
  if (remote.host !== 'github.com') {
    return fail(400, 'UNSUPPORTED_HOST', `Native Intelligence opens pull requests on github.com only. Sign in to gh on your Mac to open one on ${remote.host}.`)
  }
  const title = cleanTitle(body.title)
  if (!title) return fail(400, 'BAD_TITLE', `The title is required, at most ${PR_TITLE_MAX} characters.`)
  if (body.body !== undefined && body.body !== null && (typeof body.body !== 'string' || codePoints(body.body) > PR_BODY_MAX)) {
    return fail(400, 'BAD_BODY', `The description is at most ${PR_BODY_MAX} characters.`)
  }
  const prBody = typeof body.body === 'string' ? body.body : ''
  // A base that isn't a plain branch name is dropped: the repository's default branch is used instead.
  const askedBase = isPlainBranchName(body.base) ? body.base : null

  const session = await loadSession(svc, claims.uid, claims.sid)
  if (!session || session.workspace_id !== claims.wid) return fail(404, 'NOT_FOUND', 'Local agent not found.')
  if (session.mode !== 'edit') return fail(409, 'NOT_AN_EDIT_JOB', 'Only an edit job has a branch to open a pull request for.')
  // A job that ended after the person allowed its push (a stop, or another
  // chat taking the folder, mid-push) still gets the pull request they said
  // yes to; a stop requested since doesn't take that back either.
  if ((TERMINAL_STATUSES as string[]).includes(session.status) && !(await pushWasAllowed(svc, session))) {
    return fail(409, 'ENDED', `This local agent has ${session.status === 'cancelled' ? 'been stopped' : session.status}.`)
  }
  if (!isSessionBranch(body.branch, session)) {
    return fail(400, 'NOT_THIS_JOBS_BRANCH', "That isn't this job's own dial8/ branch.")
  }
  const head = body.branch as string
  const repo = repoFullName(remote)

  const token = await (deps.githubToken ?? storedGithubToken)(svc, claims.uid)
  if (!token) {
    return fail(409, 'GITHUB_NOT_CONNECTED', 'Connect GitHub in Native Intelligence (Settings, Connectors), or sign in to gh on your Mac, to open the pull request. The branch is pushed.')
  }
  const doFetch = deps.fetchImpl ?? fetch

  // Replay: the session's pull request in this repository, while it's still
  // open (a closed or merged one isn't the answer to a new push).
  if (session.pr_url && isPullRequestUrl(session.pr_url)) {
    const mine = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)$/i.exec(session.pr_url)
    if (mine && `${mine[1]}/${mine[2]}`.toLowerCase() === repo.toLowerCase() && (await isOpen(doFetch, repo, mine[3], token))) {
      return { ok: true, url: session.pr_url, reused: true }
    }
  }

  const base = askedBase ?? (await lookupRepoDefaultBranch(repo, token, { fetchImpl: doFetch }))
  if (!base) return fail(502, 'BASE_LOOKUP_FAILED', `GitHub didn't say which branch ${repo} merges into. Try again.`)

  let url: string | null = null
  try {
    const res = await doFetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({ title, body: prBody, head, base }),
      signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
    })
    if (res.ok) {
      const created = (await res.json()) as { html_url?: unknown }
      url = isPullRequestUrl(created.html_url) ? created.html_url : null
      if (!url) return fail(502, 'GITHUB_FAILED', 'GitHub answered without a pull request URL.')
    } else if (res.status === 422) {
      // A retry after a create that landed, or one opened another way: the open one for this branch.
      url = await findOpen(doFetch, repo, remote.owner, head, token)
      if (!url) return fail(409, 'GITHUB_REFUSED', `GitHub refused the pull request: ${await githubWhy(res)}`)
    } else if (res.status >= 500) {
      // GitHub may have opened it before failing to say so.
      url = await findOpen(doFetch, repo, remote.owner, head, token)
      if (!url) return fail(502, 'GITHUB_FAILED', `GitHub refused the pull request: ${await githubWhy(res)}`)
    } else {
      return fail(502, 'GITHUB_FAILED', `GitHub refused the pull request: ${await githubWhy(res)}`)
    }
  } catch (err) {
    // A create that timed out or dropped may still have landed.
    url = await findOpen(doFetch, repo, remote.owner, head, token)
    if (!url) return fail(502, 'GITHUB_FAILED', `GitHub couldn't be reached: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`)
  }

  await recordPullRequest(svc, claims.uid, session.id, url)
  return { ok: true, url }
}
