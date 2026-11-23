/**
 * The Reviews page's server half (docs/plans/github-reviews.md, phase 1):
 * GitHub read and merged with the person's OWN token (storedGithubToken, the
 * service client: the token columns are the service role's alone, migration
 * 466), and the actions each pull request is linked to, read through the
 * person's OWN client so the actions' policies (a private team's actions
 * stay its members') decide what shows.
 *
 * Nothing GitHub says is stored here.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  PULL_QUERY,
  SEARCH_QUERY,
  buildSearchQuery,
  mergeBlocker,
  normalizeChecks,
  normalizeFiles,
  normalizePr,
  prKey,
  type MergeMethod,
  type ReviewCheck,
  type ReviewFile,
  type ReviewFilters,
  type ReviewPr,
} from './reviews'

const API = 'https://api.github.com'
const TIMEOUT_MS = 12_000
export const PAGE_SIZE = 50

/** Why a GitHub call gave nothing: no token or a refused one, a rate limit, not found, or GitHub's own trouble. */
export type GithubFailure = 'not_connected' | 'unauthorized' | 'rate_limited' | 'not_found' | 'unavailable'

export class GithubError extends Error {
  constructor(public readonly why: GithubFailure, message?: string) {
    super(message ?? why)
  }
}

type FetchImpl = typeof fetch

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

function failureOf(res: Response): GithubFailure {
  if (res.status === 401) return 'unauthorized'
  if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))) return 'rate_limited'
  if (res.status === 403) return 'unauthorized'
  if (res.status === 404 || res.status === 410) return 'not_found'
  return 'unavailable'
}

async function graphql(token: string, query: string, variables: Record<string, unknown>, fetchImpl: FetchImpl): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await fetchImpl(`${API}/graphql`, {
      method: 'POST',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new GithubError('unavailable')
  }
  if (!res.ok) throw new GithubError(failureOf(res))
  const json = (await res.json().catch(() => null)) as { data?: Record<string, unknown>; errors?: Array<{ type?: string; message?: string }> } | null
  if (!json) throw new GithubError('unavailable')
  if (json.errors?.length && !json.data) {
    const type = json.errors[0]?.type
    throw new GithubError(type === 'RATE_LIMITED' ? 'rate_limited' : type === 'NOT_FOUND' ? 'not_found' : 'unavailable', json.errors[0]?.message)
  }
  return json.data ?? {}
}

export interface ReviewsPage {
  viewer: { login: string | null; id: number | null }
  total: number
  prs: ReviewPr[]
  cursor: string | null
}

/** One page of a section's pull requests, as GitHub's search finds them. */
export async function searchReviews(
  token: string,
  filters: ReviewFilters,
  after: string | null,
  fetchImpl: FetchImpl = fetch,
): Promise<ReviewsPage> {
  const data = await graphql(token, SEARCH_QUERY, { q: buildSearchQuery(filters), first: PAGE_SIZE, after }, fetchImpl)
  const viewer = (data.viewer ?? {}) as { login?: unknown; databaseId?: unknown }
  const search = (data.search ?? {}) as { issueCount?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown }; nodes?: unknown[] }
  const prs = (Array.isArray(search.nodes) ? search.nodes : []).map(normalizePr).filter((p): p is ReviewPr => !!p)
  return {
    viewer: { login: typeof viewer.login === 'string' ? viewer.login : null, id: typeof viewer.databaseId === 'number' ? viewer.databaseId : null },
    total: typeof search.issueCount === 'number' ? search.issueCount : prs.length,
    prs,
    cursor: search.pageInfo?.hasNextPage === true && typeof search.pageInfo.endCursor === 'string' ? search.pageInfo.endCursor : null,
  }
}

export interface ReviewPull {
  pr: ReviewPr
  body: string
  checks: ReviewCheck[]
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split('/')
  return { owner, name }
}

/** One pull request, with its description and its head commit's checks. */
export async function readPull(token: string, repo: string, number: number, fetchImpl: FetchImpl = fetch): Promise<ReviewPull> {
  const data = await graphql(token, PULL_QUERY, { ...splitRepo(repo), number }, fetchImpl)
  const raw = ((data.repository ?? {}) as { pullRequest?: unknown }).pullRequest
  const pr = normalizePr(raw)
  if (!pr) throw new GithubError('not_found')
  const body = typeof (raw as { body?: unknown }).body === 'string' ? ((raw as { body: string }).body) : ''
  return { pr, body, checks: normalizeChecks(raw) }
}

/** The files the pull request changes (first 100), with their patches. */
export async function readFiles(token: string, repo: string, number: number, fetchImpl: FetchImpl = fetch): Promise<ReviewFile[]> {
  let res: Response
  try {
    res = await fetchImpl(`${API}/repos/${repo}/pulls/${number}/files?per_page=100`, { headers: headers(token), signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch {
    throw new GithubError('unavailable')
  }
  if (!res.ok) throw new GithubError(failureOf(res))
  return normalizeFiles(await res.json().catch(() => null))
}

export type MergeOutcome =
  | { ok: true; sha: string | null }
  | { ok: false; reason: string; code: 'blocked' | 'stale' | 'refused' }

/**
 * Merge, as the person, only when it is still ready: read it again, refuse on
 * any blocker (mergeBlocker), refuse when its head moved since the person saw
 * it, and merge pinned to that head (GitHub refuses if it moves in between).
 * Branch protection and GitHub's own rules have the last word.
 */
export async function mergePull(
  token: string,
  args: { repo: string; number: number; method: MergeMethod; expectedSha: string },
  fetchImpl: FetchImpl = fetch,
): Promise<MergeOutcome> {
  const { pr } = await readPull(token, args.repo, args.number, fetchImpl)
  const blocker = mergeBlocker(pr)
  if (blocker) return { ok: false, reason: blocker, code: 'blocked' }
  if (pr.headSha !== args.expectedSha) return { ok: false, reason: 'New commits arrived since you looked. Check it again.', code: 'stale' }
  if (!pr.mergeMethods.includes(args.method)) return { ok: false, reason: 'The repository does not allow that merge method.', code: 'blocked' }
  let res: Response
  try {
    res = await fetchImpl(`${API}/repos/${args.repo}/pulls/${args.number}/merge`, {
      method: 'PUT',
      headers: { ...headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ merge_method: args.method, sha: args.expectedSha }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch {
    throw new GithubError('unavailable')
  }
  const json = (await res.json().catch(() => null)) as { merged?: unknown; sha?: unknown; message?: unknown } | null
  if (res.ok && json?.merged === true) return { ok: true, sha: typeof json.sha === 'string' ? json.sha : null }
  // 405 (not mergeable), 409 (the head moved), 422: GitHub's own words.
  const message = typeof json?.message === 'string' ? json.message : 'GitHub refused the merge.'
  if (res.status === 409) return { ok: false, reason: message, code: 'stale' }
  if (res.status === 401 || res.status === 403 || res.status === 405 || res.status === 422) return { ok: false, reason: message, code: 'refused' }
  throw new GithubError(failureOf(res), message)
}

type LinkRow = { repo_full_name: string; pr_number: number; actions: unknown }

/**
 * The actions each pull request is linked to, keyed by `owner/name#12`, read
 * through the person's own client: the inner join leaves out every link
 * whose action the actions' policies hide from them.
 */
export async function linkedActionsFor(
  supabase: SupabaseClient,
  workspaceId: string,
  prs: ReadonlyArray<Pick<ReviewPr, 'repo' | 'number'>>,
): Promise<Map<string, ReviewPr['linked']>> {
  const out = new Map<string, ReviewPr['linked']>()
  const repos = [...new Set(prs.map((p) => p.repo))]
  const numbers = [...new Set(prs.map((p) => p.number))]
  if (repos.length === 0) return out
  const { data, error } = await supabase
    .from('action_github_pr')
    .select('repo_full_name, pr_number, actions!inner(id, identifier, title)')
    .eq('workspace_id', workspaceId)
    .in('repo_full_name', repos)
    .in('pr_number', numbers)
  if (error) {
    console.warn('[reviews] linked actions read failed:', error.message)
    return out
  }
  const wanted = new Set(prs.map((p) => prKey(p.repo, p.number)))
  for (const row of (data ?? []) as LinkRow[]) {
    const key = prKey(row.repo_full_name, row.pr_number)
    if (!wanted.has(key)) continue
    const a = (Array.isArray(row.actions) ? row.actions[0] : row.actions) as { id?: string; identifier?: string | null; title?: string | null } | null
    if (!a?.id) continue
    const list = out.get(key) ?? []
    if (!list.some((x) => x.id === a.id)) list.push({ id: a.id, identifier: a.identifier ?? null, title: a.title ?? null })
    out.set(key, list)
  }
  return out
}

/** The person's GitHub problem in words, for the page. */
export function failureMessage(why: GithubFailure): string {
  switch (why) {
    case 'not_connected':
      return 'Connect GitHub in Settings › Connectors to see your pull requests.'
    case 'unauthorized':
      return 'GitHub refused your sign-in. Reconnect GitHub in Settings › Connectors.'
    case 'rate_limited':
      return 'GitHub is limiting requests for a moment. Try again shortly.'
    case 'not_found':
      return 'GitHub could not find that pull request, or your sign-in cannot see it.'
    default:
      return 'GitHub did not answer. Try again shortly.'
  }
}
