/**
 * Who may use the Reviews routes, and with which GitHub token: a workspace
 * member who is not a guest, with their own GitHub connected. The token is
 * read with the service client, for the session's own user only (migration
 * 466 keeps the token columns the service role's).
 */
import { requireWorkspaceMember, type MemberAuthContext } from '@/lib/api-auth'
import { apiError, forbidden } from '@/lib/api-errors'
import { storedGithubToken } from '@/lib/oauth/github-token'
import { getServiceClient } from '@/lib/supabase/service'
import { GithubError, failureMessage, type GithubFailure } from './reviews-server'

export interface ReviewsAuth extends MemberAuthContext {
  token: string
}

export async function requireReviews(): Promise<ReviewsAuth | Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (auth.member.role === 'guest') return forbidden('Reviews are for workspace members.')
  const token = await storedGithubToken(getServiceClient(), auth.user.id)
  if (!token) return githubFailure('not_connected')
  return { ...auth, token }
}

const STATUS: Record<GithubFailure, number> = {
  not_connected: 409,
  unauthorized: 409,
  rate_limited: 429,
  not_found: 404,
  unavailable: 502,
}

/** A GitHub failure as the shared error shape, with its reason as the code. */
export function githubFailure(why: GithubFailure): Response {
  return apiError(failureMessage(why), { status: STATUS[why], code: `github_${why}` })
}

/** A thrown GithubError as its response; anything else is rethrown. */
export function githubErrorResponse(err: unknown): Response {
  if (err instanceof GithubError) return githubFailure(err.why)
  throw err
}
