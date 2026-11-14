/**
 * A pull request's present title, state and head on GitHub, read with the
 * person's own GitHub sign-in (storedGithubToken): the one read the PR links
 * share. Linking one by hand (the actions' PRs route and the MCP's
 * link_pr, whose rows get_pr_status reads) and a Mac job's pull request
 * (local-agent store.ts, to learn it already merged) use it. Null when GitHub
 * can't say (no access, rate limit, gone, a timeout). Never throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { storedGithubToken } from '@/lib/oauth/github-token'

export interface PrMetadata {
  title: string
  /** `open`, `closed` or `merged` (GitHub says closed + merged). */
  state: string
  draft: boolean
  headBranch: string
}

/**
 * Why there is no state: `unknowable` will stay so (no GitHub connection, no
 * access, not found); `passing` may clear on its own (a rate limit, GitHub's
 * own error, a timeout or a dropped connection).
 */
export type PrReadFailure = 'unknowable' | 'passing'

export type PrRead = { ok: true; meta: PrMetadata } | { ok: false; why: PrReadFailure }

interface PrReadOptions {
  /** Only with the person's sign-in: no anonymous read (a private repository answers 404 anyway). */
  requireToken?: boolean
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

/** A refusal GitHub gives while it rate-limits (403 or 429 with its limit spent, or a wait asked for). */
function rateLimited(res: Response): boolean {
  if (res.status === 429) return true
  return res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after'))
}

/** The pull request's present state, or why there is none. Never throws. */
export async function readPrState(
  /** The SERVICE client: the token columns are the service role's alone (migration 466). */
  service: SupabaseClient,
  repoFullName: string,
  prNumber: number,
  userId: string,
  opts: PrReadOptions = {},
): Promise<PrRead> {
  let accessToken: string | null
  try {
    accessToken = await storedGithubToken(service, userId)
  } catch {
    return { ok: false, why: 'passing' }
  }
  if (!accessToken && opts.requireToken) return { ok: false, why: 'unknowable' }
  try {
    const headers: Record<string, string> = { Accept: 'application/vnd.github+json' }
    if (accessToken) headers.Authorization = `Bearer ${accessToken}`
    const res = await (opts.fetchImpl ?? fetch)(`https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`, {
      headers,
      ...(opts.timeoutMs ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    })
    if (!res.ok) {
      if (rateLimited(res) || res.status >= 500) return { ok: false, why: 'passing' }
      // 401 / 403 (no access), 404 (not found or not visible), 410, 422: it won't change by waiting.
      return { ok: false, why: 'unknowable' }
    }
    const data = await res.json()
    return {
      ok: true,
      meta: {
        title: data.title,
        // GitHub answers 'open' or 'closed'; a merged one is closed and merged.
        state: data.merged ? 'merged' : data.state,
        draft: data.draft || false,
        headBranch: data.head?.ref || null,
      },
    }
  } catch {
    // A timeout, a dropped connection, an answer that isn't JSON.
    return { ok: false, why: 'passing' }
  }
}

/** The pull request's present state, or null when GitHub can't say (readPrState says why). */
export async function fetchPrMetadata(
  service: SupabaseClient,
  repoFullName: string,
  prNumber: number,
  userId: string,
  opts: PrReadOptions = {},
): Promise<PrMetadata | null> {
  const read = await readPrState(service, repoFullName, prNumber, userId, opts)
  return read.ok ? read.meta : null
}
