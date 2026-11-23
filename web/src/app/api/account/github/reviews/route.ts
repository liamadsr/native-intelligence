import { NextResponse } from 'next/server'
import { parseReviewFilters, prKey } from '@/lib/github/reviews'
import { linkedActionsFor, searchReviews } from '@/lib/github/reviews-server'
import { githubErrorResponse, requireReviews } from '@/lib/github/reviews-auth'

/**
 * GET /api/account/github/reviews — one page of the person's pull requests for
 * a Reviews section, read live from GitHub with their own token
 * (docs/plans/github-reviews.md, phase 1). Query: section, state, repo,
 * author, assignee, label, review, linked, sort, after (GitHub's cursor).
 *
 * Each pull request carries the actions it is linked to that the person can
 * see (their own client; the actions' policies decide). `linked` filters
 * within the page GitHub returned.
 */
export async function GET(request: Request) {
  const auth = await requireReviews()
  if (auth instanceof Response) return auth
  const params = new URL(request.url).searchParams
  const filters = parseReviewFilters(params)
  const after = params.get('after')
  try {
    const page = await searchReviews(auth.token, filters, after && after.length <= 200 ? after : null)
    const links = await linkedActionsFor(auth.supabase, auth.workspaceId, page.prs)
    let prs = page.prs.map((p) => ({ ...p, linked: links.get(prKey(p.repo, p.number)) ?? [] }))
    if (filters.linked === 'linked') prs = prs.filter((p) => p.linked.length > 0)
    if (filters.linked === 'unlinked') prs = prs.filter((p) => p.linked.length === 0)
    return NextResponse.json({ viewer: page.viewer, total: page.total, cursor: page.cursor, prs })
  } catch (err) {
    return githubErrorResponse(err)
  }
}
