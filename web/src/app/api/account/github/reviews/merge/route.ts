import { NextResponse } from 'next/server'
import { apiError, badRequest } from '@/lib/api-errors'
import { REPO_RE, type MergeMethod } from '@/lib/github/reviews'
import { mergePull } from '@/lib/github/reviews-server'
import { githubErrorResponse, requireReviews } from '@/lib/github/reviews-auth'

const METHODS: readonly MergeMethod[] = ['merge', 'squash', 'rebase']

/**
 * POST /api/account/github/reviews/merge — merge one pull request as the
 * person, after they confirmed it in the Reviews panel. Body: { repo, number,
 * method, sha } where sha is the head commit they saw.
 *
 * The server reads it again with their token and refuses unless it is still
 * open, not a draft, approved (or needing no review), its checks passing,
 * GitHub calling it clean, and their access to the repository at least
 * write; then merges pinned to `sha`, so a push in between is refused.
 * GitHub's own rules (branch protection) still have the last word.
 */
export async function POST(request: Request) {
  const auth = await requireReviews()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as { repo?: unknown; number?: unknown; method?: unknown; sha?: unknown } | null
  const repo = typeof body?.repo === 'string' ? body.repo : ''
  const number = typeof body?.number === 'number' ? body.number : NaN
  const method = typeof body?.method === 'string' && (METHODS as readonly string[]).includes(body.method) ? (body.method as MergeMethod) : null
  const sha = typeof body?.sha === 'string' && /^[0-9a-f]{40}$/i.test(body.sha) ? body.sha : null
  if (!REPO_RE.test(repo) || !Number.isInteger(number) || number <= 0 || !method || !sha) {
    return badRequest('repo, number, method (merge, squash or rebase) and sha are required')
  }
  try {
    const outcome = await mergePull(auth.token, { repo, number, method, expectedSha: sha })
    if (!outcome.ok) return apiError(outcome.reason, { status: 409, code: `merge_${outcome.code}` })
    return NextResponse.json({ merged: true, sha: outcome.sha })
  } catch (err) {
    return githubErrorResponse(err)
  }
}
