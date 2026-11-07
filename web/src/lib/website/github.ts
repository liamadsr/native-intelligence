/**
 * The GitHub calls the website flow makes (roadmap track E), as the owner
 * who connected GitHub (their OAuth token, `repo` scope: src/lib/oauth/
 * config.ts). Plain REST (and one GraphQL mutation, the revert), the
 * outcome route's idiom. Every call takes a {@link GithubDeps} so the tests
 * drive it without the network; none throws for a GitHub answer (a failed
 * call is a result), only for a programming error.
 *
 *   repos        the owner's repos, newest push first, and one repo's facts
 *   tree, file   the repo read the inspection does (./inspect.ts)
 *   pull         a pull request's head, state and mergeability
 *   preview      a pull request head's preview URL, from the host's GitHub
 *                deployment (Vercel, Netlify, Cloudflare) or commit status
 *   production   whether the merge commit's production deploy finished
 *   merge        squash (else merge, else rebase), pinned to the head the
 *                owner approved: GitHub refuses a head that moved since
 *   close        a declined change's pull request, with a line why
 *   revert       GitHub's own revert of a merged pull request, as a new PR
 */
import { REPO_FULL_NAME_RE } from '@/lib/environments/types'

export interface GithubDeps {
  token: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

const API = 'https://api.github.com'
/** A ref we put in a URL (the default branch, a sha). */
const SAFE_REF = /^[A-Za-z0-9._/-]{1,200}$/

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

type Answer<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

async function call<T>(deps: GithubDeps, path: string, init: RequestInit = {}): Promise<Answer<T>> {
  const doFetch = deps.fetchImpl ?? fetch
  try {
    const res = await doFetch(`${API}${path}`, {
      ...init,
      headers: { ...headers(deps.token), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) },
      signal: AbortSignal.timeout(deps.timeoutMs ?? 10_000),
    })
    if (res.status === 204) return { ok: true, value: null as T }
    const text = await res.text()
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    if (!res.ok) {
      const message = body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string' ? (body as { message: string }).message : `GitHub answered ${res.status}`
      return { ok: false, status: res.status, error: message.slice(0, 300) }
    }
    return { ok: true, value: body as T }
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message.slice(0, 300) : 'GitHub could not be reached' }
  }
}

export function isRepoName(value: unknown): value is string {
  return typeof value === 'string' && REPO_FULL_NAME_RE.test(value)
}

// ── Repos ────────────────────────────────────────────────────────────────────

export interface RepoFacts {
  fullName: string
  private: boolean
  defaultBranch: string
  pushedAt: string | null
  homepage: string | null
  language: string | null
  description: string | null
  archived: boolean
  fork: boolean
  hasPages: boolean
  /** The owner may push to it (open a branch and a pull request). */
  canPush: boolean
}

interface RawRepo {
  full_name?: unknown
  private?: unknown
  default_branch?: unknown
  pushed_at?: unknown
  homepage?: unknown
  language?: unknown
  description?: unknown
  archived?: unknown
  fork?: unknown
  has_pages?: unknown
  permissions?: { push?: unknown; admin?: unknown; maintain?: unknown } | null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

export function toRepoFacts(raw: RawRepo): RepoFacts | null {
  const fullName = str(raw.full_name)
  const branch = str(raw.default_branch)
  if (!fullName || !isRepoName(fullName) || !branch || !SAFE_REF.test(branch) || branch.includes('..')) return null
  const p = raw.permissions ?? {}
  return {
    fullName,
    private: raw.private === true,
    defaultBranch: branch,
    pushedAt: str(raw.pushed_at),
    homepage: str(raw.homepage),
    language: str(raw.language),
    description: str(raw.description)?.slice(0, 200) ?? null,
    archived: raw.archived === true,
    fork: raw.fork === true,
    hasPages: raw.has_pages === true,
    canPush: p.push === true || p.admin === true || p.maintain === true,
  }
}

/** Pages of 100 repos read at most (newest push first). */
const REPO_PAGES = 3

/** The repos the owner can see, newest push first (up to {@link REPO_PAGES} pages of 100). */
export async function listOwnerRepos(deps: GithubDeps): Promise<Answer<RepoFacts[]>> {
  const repos: RepoFacts[] = []
  for (let page = 1; page <= REPO_PAGES; page++) {
    const got = await call<RawRepo[]>(deps, `/user/repos?sort=pushed&per_page=100&page=${page}&affiliation=owner,collaborator,organization_member`)
    if (!got.ok) {
      if (page === 1) return got
      break
    }
    const batch = Array.isArray(got.value) ? got.value : []
    repos.push(...batch.map(toRepoFacts).filter((r): r is RepoFacts => !!r))
    if (batch.length < 100) break
  }
  return { ok: true, value: repos }
}

/** One repo's facts, as the owner sees it. */
export async function getRepo(deps: GithubDeps, repo: string): Promise<Answer<RepoFacts>> {
  if (!isRepoName(repo)) return { ok: false, status: 400, error: 'not a repository name' }
  const got = await call<RawRepo>(deps, `/repos/${repo}`)
  if (!got.ok) return got
  const facts = got.value ? toRepoFacts(got.value) : null
  return facts ? { ok: true, value: facts } : { ok: false, status: 502, error: 'GitHub sent a repository we could not read' }
}

// ── Reading the repo ─────────────────────────────────────────────────────────

export interface TreeEntry {
  path: string
  size: number
}

/** Every file in the branch (blobs only), and whether GitHub cut the list short. */
export async function getTree(deps: GithubDeps, repo: string, ref: string): Promise<Answer<{ files: TreeEntry[]; truncated: boolean }>> {
  if (!isRepoName(repo) || !SAFE_REF.test(ref)) return { ok: false, status: 400, error: 'bad repository or branch' }
  const got = await call<{ tree?: Array<{ path?: unknown; type?: unknown; size?: unknown }>; truncated?: unknown }>(deps, `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`)
  if (!got.ok) return got
  const files = (got.value?.tree ?? [])
    .filter((e) => e.type === 'blob' && typeof e.path === 'string')
    .map((e) => ({ path: e.path as string, size: typeof e.size === 'number' ? e.size : 0 }))
  return { ok: true, value: { files, truncated: got.value?.truncated === true } }
}

/** The largest file the inspection reads. */
export const FILE_READ_MAX_BYTES = 200_000

/** One file's text at a ref, or null when it is missing, binary or too big. */
export async function getFileText(deps: GithubDeps, repo: string, path: string, ref: string): Promise<string | null> {
  if (!isRepoName(repo) || !SAFE_REF.test(ref) || path.includes('..')) return null
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  const got = await call<{ content?: unknown; encoding?: unknown; size?: unknown }>(deps, `/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(ref)}`)
  if (!got.ok || !got.value || got.value.encoding !== 'base64' || typeof got.value.content !== 'string') return null
  if (typeof got.value.size === 'number' && got.value.size > FILE_READ_MAX_BYTES) return null
  const text = Buffer.from(got.value.content, 'base64').toString('utf8')
  return text.includes('\u0000') ? null : text
}

// ── Pull requests ────────────────────────────────────────────────────────────

export interface PullFacts {
  number: number
  nodeId: string
  url: string
  title: string
  body: string
  state: 'open' | 'closed'
  /** A coding run nobody started by hand opens its pull request as a draft (src/lib/coding/unattended.ts). */
  draft: boolean
  merged: boolean
  /** The commit a merge made (null until merged). */
  mergeSha: string | null
  mergeable: boolean | null
  headSha: string
  baseRef: string
  changedFiles: number
}

export async function getPull(deps: GithubDeps, repo: string, number: number): Promise<Answer<PullFacts>> {
  if (!isRepoName(repo) || !Number.isInteger(number) || number <= 0) return { ok: false, status: 400, error: 'bad pull request' }
  const got = await call<{
    number?: unknown
    node_id?: unknown
    html_url?: unknown
    title?: unknown
    body?: unknown
    state?: unknown
    draft?: unknown
    merged?: unknown
    merge_commit_sha?: unknown
    mergeable?: unknown
    head?: { sha?: unknown }
    base?: { ref?: unknown }
    changed_files?: unknown
  }>(deps, `/repos/${repo}/pulls/${number}`)
  if (!got.ok) return got
  const v = got.value ?? {}
  const headSha = str(v.head?.sha)
  const url = str(v.html_url)
  if (!headSha || !url) return { ok: false, status: 502, error: 'GitHub sent a pull request we could not read' }
  return {
    ok: true,
    value: {
      number,
      nodeId: str(v.node_id) ?? '',
      url,
      title: str(v.title) ?? '',
      body: typeof v.body === 'string' ? v.body : '',
      state: v.state === 'closed' ? 'closed' : 'open',
      draft: v.draft === true,
      merged: v.merged === true,
      mergeSha: v.merged === true && typeof v.merge_commit_sha === 'string' && /^[0-9a-f]{40}$/i.test(v.merge_commit_sha) ? v.merge_commit_sha : null,
      mergeable: typeof v.mergeable === 'boolean' ? v.mergeable : null,
      headSha,
      baseRef: str(v.base?.ref) ?? '',
      changedFiles: typeof v.changed_files === 'number' ? v.changed_files : 0,
    },
  }
}

export interface PullFiles {
  /** The files it changes, at most 100. */
  files: string[]
  /** Hosts its added lines name (https://host…, //host…) that no removed line did: an outside address it brings in. */
  addedHosts: string[]
  /** False when some of it couldn't be read (100+ files, a file GitHub sends no patch for): the card says so. */
  complete: boolean
}

const HOST_IN_LINE = /(?:https?:)?\/\/([A-Za-z0-9.-]+\.[A-Za-z]{2,})(?::\d+)?/g

/** The outside hosts a set of diff patches adds (in an added line, in no removed line). Pure. */
export function addedHostsOf(patches: readonly string[]): string[] {
  const added = new Set<string>()
  const removed = new Set<string>()
  for (const patch of patches) {
    for (const line of patch.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      const into = line.startsWith('+') ? added : line.startsWith('-') ? removed : null
      if (!into) continue
      for (const m of line.matchAll(HOST_IN_LINE)) into.add(m[1].toLowerCase())
    }
  }
  return [...added].filter((h) => !removed.has(h)).sort()
}

/** What a pull request changes: its files, and the outside hosts it adds. */
export async function getPullFiles(deps: GithubDeps, repo: string, number: number): Promise<Answer<PullFiles>> {
  if (!isRepoName(repo) || !Number.isInteger(number) || number <= 0) return { ok: false, status: 400, error: 'bad pull request' }
  const got = await call<Array<{ filename?: unknown; patch?: unknown }>>(deps, `/repos/${repo}/pulls/${number}/files?per_page=100`)
  if (!got.ok) return got
  const rows = Array.isArray(got.value) ? got.value : []
  return {
    ok: true,
    value: {
      files: rows.map((r) => (typeof r.filename === 'string' ? r.filename : '')).filter(Boolean),
      addedHosts: addedHostsOf(rows.map((r) => (typeof r.patch === 'string' ? r.patch : ''))),
      complete: rows.length < 100 && rows.every((r) => typeof r.patch === 'string'),
    },
  }
}

/** A pull request URL's repo and number, when it is one of github.com's. Pure. */
export function parsePullUrl(url: string | null | undefined): { repo: string; number: number } | null {
  const m = typeof url === 'string' ? url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/) : null
  if (!m || !isRepoName(m[1])) return null
  return { repo: m[1], number: Number(m[2]) }
}

export type MergeOutcome =
  | { ok: true; sha: string; method: 'squash' | 'merge' | 'rebase' }
  | { ok: false; code: 'HEAD_MOVED' | 'NOT_MERGEABLE' | 'FORBIDDEN' | 'FAILED'; error: string }

/**
 * Merge, pinned to `sha` (the head the owner approved): squash, else a merge
 * commit, else a rebase, whichever the repo allows. GitHub answers 409 when
 * the head moved since, 405 when it can't merge (conflicts, a required
 * check or review), 403 when the token may not.
 */
export async function mergePull(deps: GithubDeps, repo: string, number: number, sha: string, title: string): Promise<MergeOutcome> {
  if (!isRepoName(repo) || !Number.isInteger(number) || !/^[0-9a-f]{40}$/i.test(sha)) return { ok: false, code: 'FAILED', error: 'bad merge request' }
  let last: { status: number; error: string } = { status: 0, error: 'not tried' }
  for (const method of ['squash', 'merge', 'rebase'] as const) {
    const got = await call<{ sha?: unknown; merged?: unknown }>(deps, `/repos/${repo}/pulls/${number}/merge`, {
      method: 'PUT',
      body: JSON.stringify({ sha, merge_method: method, commit_title: title.slice(0, 200) }),
    })
    if (got.ok) {
      const merged = str(got.value?.sha)
      return merged ? { ok: true, sha: merged, method } : { ok: false, code: 'FAILED', error: 'GitHub merged it but sent no commit' }
    }
    last = got
    if (got.status === 409) return { ok: false, code: 'HEAD_MOVED', error: got.error }
    if (got.status === 403) return { ok: false, code: 'FORBIDDEN', error: got.error }
    // 405 "Merge commits are not allowed" / "Squash merges are not allowed": try the next method.
    if (got.status === 405 && /not allowed/i.test(got.error)) continue
    if (got.status === 405 || got.status === 422) return { ok: false, code: 'NOT_MERGEABLE', error: got.error }
    return { ok: false, code: 'FAILED', error: got.error }
  }
  return { ok: false, code: 'NOT_MERGEABLE', error: last.error }
}

/**
 * Mark a draft pull request ready (GraphQL markPullRequestReadyForReview): a
 * coding run's PR is a draft until a person says so, and the owner's yes is
 * that person. True when it is ready now.
 */
export async function markPullReady(deps: GithubDeps, nodeId: string): Promise<boolean> {
  if (!nodeId) return false
  const got = await call<{ data?: { markPullRequestReadyForReview?: { pullRequest?: { isDraft?: unknown } } }; errors?: unknown[] }>(deps, '/graphql', {
    method: 'POST',
    body: JSON.stringify({ query: 'mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { isDraft } } }', variables: { id: nodeId } }),
  })
  return got.ok && got.value?.data?.markPullRequestReadyForReview?.pullRequest?.isDraft === false
}

/** Close a pull request, with a comment saying why. Best effort. */
export async function closePull(deps: GithubDeps, repo: string, number: number, comment: string): Promise<boolean> {
  if (!isRepoName(repo) || !Number.isInteger(number)) return false
  if (comment) await call(deps, `/repos/${repo}/issues/${number}/comments`, { method: 'POST', body: JSON.stringify({ body: comment.slice(0, 2000) }) })
  const got = await call(deps, `/repos/${repo}/pulls/${number}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) })
  return got.ok
}

/**
 * GitHub's own revert of a merged pull request (GraphQL revertPullRequest):
 * a new pull request that undoes it. The node id is the merged PR's.
 */
export async function revertPull(deps: GithubDeps, args: { nodeId: string; title: string; body: string }): Promise<Answer<{ number: number; url: string }>> {
  if (!args.nodeId) return { ok: false, status: 400, error: 'no pull request to revert' }
  const got = await call<{ data?: { revertPullRequest?: { revertPullRequest?: { number?: unknown; url?: unknown } } }; errors?: Array<{ message?: unknown }> }>(deps, '/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: 'mutation($id: ID!, $title: String!, $body: String!) { revertPullRequest(input: { pullRequestId: $id, title: $title, body: $body }) { revertPullRequest { number url } } }',
      variables: { id: args.nodeId, title: args.title.slice(0, 200), body: args.body.slice(0, 4000) },
    }),
  })
  if (!got.ok) return got
  const pr = got.value?.data?.revertPullRequest?.revertPullRequest
  const number = typeof pr?.number === 'number' ? pr.number : null
  const url = str(pr?.url)
  if (!number || !url) {
    const message = got.value?.errors?.map((e) => (typeof e.message === 'string' ? e.message : '')).filter(Boolean).join('; ')
    return { ok: false, status: 422, error: (message || 'GitHub did not make the revert').slice(0, 300) }
  }
  return { ok: true, value: { number, url } }
}

// ── Deploys ──────────────────────────────────────────────────────────────────

interface RawDeployment {
  id?: unknown
  environment?: unknown
  production_environment?: unknown
  transient_environment?: unknown
  creator?: { login?: unknown; type?: unknown } | null
}

interface RawDeploymentStatus {
  state?: unknown
  environment_url?: unknown
  target_url?: unknown
  creator?: { login?: unknown; type?: unknown } | null
}

/**
 * The host apps whose previews may be texted to the owner. A deployment or a
 * status from anyone else (github-actions[bot] included: any workflow on the
 * branch runs as it) is never trusted for a link.
 */
export const PREVIEW_APP_LOGINS: ReadonlySet<string> = new Set(['vercel[bot]', 'netlify[bot]', 'cloudflare-workers-and-pages[bot]', 'cloudflare-pages[bot]'])

function byPreviewApp(creator: { login?: unknown; type?: unknown } | null | undefined): boolean {
  return creator?.type === 'Bot' && typeof creator.login === 'string' && PREVIEW_APP_LOGINS.has(creator.login)
}

/** The host each host app's bot deploys to. */
const HOST_APP_HOSTS: Readonly<Record<string, 'vercel' | 'netlify' | 'cloudflare' | 'github-pages'>> = {
  'vercel[bot]': 'vercel',
  'netlify[bot]': 'netlify',
  'cloudflare-workers-and-pages[bot]': 'cloudflare',
  'cloudflare-pages[bot]': 'cloudflare',
  'github-pages[bot]': 'github-pages',
}

/**
 * The host that deploys the repo, from who made its recent GitHub deployments,
 * or null. A site linked in the host's dashboard has no deploy file in the repo
 * (most Next.js sites on Vercel have no vercel.json); its deployments name it.
 */
export async function deploymentHost(deps: GithubDeps, repo: string): Promise<'vercel' | 'netlify' | 'cloudflare' | 'github-pages' | null> {
  if (!isRepoName(repo)) return null
  const got = await call<RawDeployment[]>(deps, `/repos/${repo}/deployments?per_page=10`)
  if (!got.ok || !Array.isArray(got.value)) return null
  for (const d of got.value) {
    const login = d.creator?.type === 'Bot' && typeof d.creator.login === 'string' ? d.creator.login : null
    if (login && Object.prototype.hasOwnProperty.call(HOST_APP_HOSTS, login)) return HOST_APP_HOSTS[login]
  }
  return null
}

/** An environment name a host uses for production. */
export function isProductionEnvironment(name: string, flagged: boolean): boolean {
  if (flagged) return true
  return /^(production|prod|github-pages|live)$/i.test(name.trim()) || /\bproduction\b/i.test(name)
}

export type DeployState = { state: 'success'; url: string | null } | { state: 'failure'; url: null } | { state: 'pending'; url: null } | { state: 'none'; url: null }

/** The newest status of each of a sha's deployments that `pick` keeps, and the first settled one's URL. */
async function deploymentsFor(deps: GithubDeps, repo: string, sha: string, pick: (d: { environment: string; production: boolean; byApp: boolean }) => boolean): Promise<DeployState> {
  if (!isRepoName(repo) || !/^[0-9a-f]{7,40}$/i.test(sha)) return { state: 'none', url: null }
  const got = await call<RawDeployment[]>(deps, `/repos/${repo}/deployments?sha=${sha}&per_page=20`)
  if (!got.ok || !Array.isArray(got.value)) return { state: 'none', url: null }
  const kept = got.value.filter(
    (d) => typeof d.id === 'number' && pick({ environment: typeof d.environment === 'string' ? d.environment : '', production: d.production_environment === true, byApp: byPreviewApp(d.creator) }),
  )
  if (!kept.length) return { state: 'none', url: null }
  let pending = false
  for (const d of kept.slice(0, 5)) {
    const statuses = await call<RawDeploymentStatus[]>(deps, `/repos/${repo}/deployments/${d.id}/statuses?per_page=5`)
    const newest = statuses.ok && Array.isArray(statuses.value) ? statuses.value[0] : undefined
    const state = typeof newest?.state === 'string' ? newest.state : 'pending'
    if (state === 'success') return { state: 'success', url: httpsUrl(newest?.environment_url) ?? httpsUrl(newest?.target_url) }
    if (state === 'failure' || state === 'error') {
      if (kept.length === 1) return { state: 'failure', url: null }
      continue
    }
    pending = true
  }
  return pending ? { state: 'pending', url: null } : { state: 'failure', url: null }
}

function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  try {
    const url = new URL(v)
    return url.protocol === 'https:' && v.length <= 300 ? url.toString() : null
  } catch {
    return null
  }
}

/** A preview host's URL in a commit status (Netlify, Cloudflare): the host's own domains only. */
const PREVIEW_HOSTS = /(^|\.)(netlify\.app|pages\.dev|vercel\.app|onrender\.com|surge\.sh)$/i

/** A preview URL the owner may be texted: https on a preview host's own domain. Pure. */
export function isPreviewHostUrl(url: string | null | undefined): url is string {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && PREVIEW_HOSTS.test(u.hostname)
  } catch {
    return false
  }
}

/**
 * A pull request head's preview, if its host made one: a non-production
 * GitHub deployment made by a host's app (Vercel, Netlify and Cloudflare make
 * one per PR), else a commit status, either way only on a preview host's own
 * domain: a workflow on the branch (the run's own, a collaborator's) could
 * make a deployment pointing anywhere, and this URL is texted to the owner.
 * Null when there is none (yet).
 */
export async function findPreviewUrl(deps: GithubDeps, repo: string, sha: string): Promise<DeployState> {
  const found = await deploymentsFor(deps, repo, sha, (d) => d.byApp && !isProductionEnvironment(d.environment, d.production))
  const viaDeploy: DeployState = found.state === 'success' && !isPreviewHostUrl(found.url) ? { state: 'none', url: null } : found
  if (viaDeploy.state === 'success' && viaDeploy.url) return viaDeploy
  const status = await call<{ statuses?: RawDeploymentStatus[] }>(deps, `/repos/${repo}/commits/${sha}/status`)
  if (status.ok) {
    for (const s of status.value?.statuses ?? []) {
      const url = httpsUrl(s.target_url)
      if (url && s.state === 'success' && byPreviewApp(s.creator) && isPreviewHostUrl(url)) return { state: 'success', url }
    }
  }
  return viaDeploy.state === 'success' ? { state: 'pending', url: null } : viaDeploy
}

/** The merge commit's production deploy, from the host's GitHub deployments. */
export async function productionDeploy(deps: GithubDeps, repo: string, sha: string): Promise<DeployState> {
  return deploymentsFor(deps, repo, sha, (d) => isProductionEnvironment(d.environment, d.production))
}
