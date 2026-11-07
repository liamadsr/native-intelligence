/**
 * POST /api/local-agent/sessions/[id]/pull-request: C5's server fallback
 * (docs/plans/teammate-agent.md). The desktop already pushed the edit job's own
 * `dial8/…` branch, as the person, after their yes on the Mac, and has no
 * signed-in gh; the server opens the pull request with the person's Dial8
 * GitHub sign-in (src/lib/local-agent/open-pull-request.ts).
 *
 * Auth: `Authorization: Bearer <the session's la1 token>` (the one the
 * launcher holds), never a cookie or a shared secret; its `sid` must be this
 * route's id. Body (desktop push.rs):
 *   { sessionId, remoteUrl, branch, base: string | null, title, body }
 * Answers 200 { url } (also when the session already has its pull request),
 * or { error, code } with 400 / 401 / 404 / 409 / 502; the desktop puts
 * `error` in its `pull_request` event.
 */
import { NextResponse } from 'next/server'
import { apiError, unauthorized } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { readJsonBody } from '@/lib/local-agent/http'
import { openSessionPullRequest } from '@/lib/local-agent/open-pull-request'
import { isUuid } from '@/lib/local-agent/store'
import { verifyModelToken } from '@/lib/local-agent/tokens'

export const dynamic = 'force-dynamic'
/** GitHub's default-branch read and the create (15 s each), under the desktop's 30 s. */
export const maxDuration = 60

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const header = request.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return unauthorized()
  const verified = verifyModelToken(header.slice('Bearer '.length).trim())
  if (!verified.ok) {
    if (verified.reason === 'unconfigured') return apiError('Session tokens are not configured', { status: 503, code: 'NOT_CONFIGURED' })
    return unauthorized(verified.reason === 'expired' ? 'Session token expired' : 'Invalid session token')
  }
  const { id } = await ctx.params
  if (!isUuid(id) || id !== verified.claims.sid) return apiError('This token is for another session', { status: 403, code: 'SESSION_MISMATCH' })

  const body = await readJsonBody(request)
  if (body instanceof Response) return body
  try {
    const result = await openSessionPullRequest(getServiceClient(), verified.claims, body)
    if (!result.ok) return apiError(result.error, { status: result.status, code: result.code })
    return NextResponse.json({ url: result.url, ...(result.reused ? { reused: true } : {}) })
  } catch (err) {
    console.error('[local-agent] pull request failed:', err instanceof Error ? err.message : err)
    return apiError("Dial8 couldn't open the pull request right now", { status: 503, code: 'UNAVAILABLE' })
  }
}
