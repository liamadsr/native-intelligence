import { NextResponse } from 'next/server'
import { badRequest } from '@/lib/api-errors'
import { REPO_RE, mergeBlocker, prKey } from '@/lib/github/reviews'
import { linkedActionsFor, readFiles, readPull } from '@/lib/github/reviews-server'
import { githubErrorResponse, requireReviews } from '@/lib/github/reviews-auth'

/**
 * GET /api/account/github/reviews/pull?repo=owner/name&number=12 — one pull
 * request for the Reviews side panel: its description, its checks, its
 * changed files with their patches (first 100), the actions linked to it
 * that the person can see, and why they can't merge it from here (null when
 * they can). Read live with the person's own token.
 */
export async function GET(request: Request) {
  const auth = await requireReviews()
  if (auth instanceof Response) return auth
  const params = new URL(request.url).searchParams
  const repo = params.get('repo') ?? ''
  const number = Number(params.get('number'))
  if (!REPO_RE.test(repo) || !Number.isInteger(number) || number <= 0) return badRequest('repo (owner/name) and number are required')
  try {
    const [pull, files] = await Promise.all([readPull(auth.token, repo, number), readFiles(auth.token, repo, number)])
    const links = await linkedActionsFor(auth.supabase, auth.workspaceId, [pull.pr])
    const pr = { ...pull.pr, linked: links.get(prKey(repo, number)) ?? [] }
    return NextResponse.json({ pr, body: pull.body, checks: pull.checks, files, mergeBlocker: mergeBlocker(pr) })
  } catch (err) {
    return githubErrorResponse(err)
  }
}
