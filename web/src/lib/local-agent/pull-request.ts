/**
 * C5, pure helpers (teammate plan; client-safe): what a pull request for a
 * local agent's branch may name. The server route
 * (/api/local-agent/sessions/[id]/pull-request) and the event ingest read
 * them, and the panel shows only a URL that passes `isPullRequestUrl`.
 *
 * The desktop (push.rs, desktop PR #70) pushes the job's own `dial8/…` branch
 * from the person's checkout and opens the pull request with gh, or posts
 * `{ sessionId, remoteUrl, branch, base, title, body }` to the route.
 */

/** Longest pull request URL kept (push.rs MAX_URL; migration 418's check). */
export const PR_URL_MAX = 2048
/** A pull request title GitHub takes, at most (push.rs caps the prompt's at 256). */
export const PR_TITLE_MAX = 256
/** A body, at most (push.rs: 60,000; GitHub's limit is 65,536). */
export const PR_BODY_MAX = 60_000
/** A branch name, at most (migration 410's `branch` check). */
export const BRANCH_MAX = 300

/** `https://<host>/<owner>/<repo>/pull/<n>`: one https URL, nothing else in it. */
export function isPullRequestUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length > PR_URL_MAX) return false
  return /^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d{1,10}$/.test(v)
}

/** A pull request on github.com: the only host the server opens on, and the one the session keeps and links. */
export function isGithubPullRequestUrl(v: unknown): v is string {
  return isPullRequestUrl(v) && v.startsWith('https://github.com/')
}

/** Length in code points, as the desktop counts (prompts.rs cuts a title at 256 and a body at 60,000 of them). */
export function codePoints(text: string): number {
  return Array.from(text).length
}

/**
 * A plain git branch name: what push.rs's `is_plain_name` accepts and git's
 * check-ref-format allows (no `..`, no `@{`, no control or special
 * characters, no leading `-` or `/`, no `.lock` component).
 */
export function isPlainBranchName(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > BRANCH_MAX) return false
  if (!/^[A-Za-z0-9._/-]+$/.test(v)) return false
  if (v.startsWith('-') || v.startsWith('/') || v.endsWith('/') || v.endsWith('.')) return false
  if (v.includes('..') || v.includes('//')) return false
  return v.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'))
}

/**
 * The session's own branch: `dial8/<slug>-<the session id's first 8>`, the
 * name the desktop gives an edit job's worktree (git.rs). When the session
 * already knows its branch (its `branch` event), it must be exactly that.
 */
export function isSessionBranch(branch: unknown, session: { id: string; branch: string | null }): branch is string {
  if (!isPlainBranchName(branch) || !branch.startsWith('dial8/')) return false
  if (session.branch) return branch === session.branch
  return branch.toLowerCase().endsWith(`-${session.id.slice(0, 8).toLowerCase()}`)
}

/** A repository a remote URL names. */
export interface RemoteRepo {
  host: string
  owner: string
  repo: string
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/

function repoOf(host: string, path: string): RemoteRepo | null {
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '').split('/')
  if (parts.length !== 2) return null
  const [owner, repo] = parts
  if (!NAME.test(owner) || !NAME.test(repo) || owner.startsWith('.') || repo === '.' || repo === '..') return null
  return { host: host.toLowerCase(), owner, repo }
}

/**
 * The host, owner and repository of a push URL as push.rs sends it (any
 * `user:password@` already removed): `https://github.com/o/r(.git)`,
 * `ssh://git@github.com/o/r.git` or scp style `git@github.com:o/r.git`.
 * Null for anything else.
 */
export function parseRemoteRepo(remoteUrl: unknown): RemoteRepo | null {
  if (typeof remoteUrl !== 'string' || !remoteUrl || remoteUrl.length > 2048 || /\s/.test(remoteUrl)) return null
  const scp = /^(?:[A-Za-z0-9_.-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(remoteUrl)
  if (scp && !remoteUrl.includes('://')) return repoOf(scp[1], scp[2])
  let url: URL
  try {
    url = new URL(remoteUrl)
  } catch {
    return null
  }
  if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname) return null
  return repoOf(url.hostname, url.pathname)
}

/** `owner/repo`, the shape a project's `github_repo` holds. */
export function repoFullName(r: RemoteRepo): string {
  return `${r.owner}/${r.repo}`
}
