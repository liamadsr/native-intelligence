/**
 * POST /m/<token>/leave → { state }: a guest went (phase 7): the lobby's
 * Cancel, the call's Leave, or the tab closing (a beacon). They are out of
 * the lobby, or out of the call's count; coming back means asking again.
 * Their cookie goes too. Same-origin only; the cookie is checked first.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { apiError, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { isSameOriginPost } from '@/lib/links/same-origin'
import { clearedGuestCookieOptions, MEETING_GUEST_COOKIE, tokenDigest } from '@/lib/meeting-links/link'
import { guestOf, noGuest, privateHeaders, smallBody } from '@/lib/meeting-links/public'
import { leaveAsGuest } from '@/lib/meeting-links/store'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ token: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const { token } = await params
  if (!isSameOriginPost(request)) return privateHeaders(apiError('Forbidden', { status: 403, code: 'FORBIDDEN' }))
  const guestId = guestOf(request, token)
  if (!guestId) return privateHeaders(noGuest())
  const body = await smallBody(request)
  if (body instanceof Response) return body
  try {
    const state = await leaveAsGuest(getServiceClient(), guestId, tokenDigest(token))
    const res = NextResponse.json({ state })
    res.cookies.set(MEETING_GUEST_COOKIE, '', clearedGuestCookieOptions(token))
    return privateHeaders(res)
  } catch (err) {
    console.error('[meetings] guest leave failed:', err instanceof Error ? err.message : 'unknown')
    return privateHeaders(serverError())
  }
}
