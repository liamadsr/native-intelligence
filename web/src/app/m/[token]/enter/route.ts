/**
 * POST /m/<token>/enter (a form on the meeting's page) → 303 to the app: a
 * signed-in member of the meeting's workspace joins its conversation and is
 * taken to it and its call (/account?meeting=…, switching workspace first
 * when another is current). A same-origin POST only: opening the link (a GET,
 * which another site can make a browser do) never joins anyone to anything.
 * Not signed in, not a member, or a link that doesn't work: back to the
 * page, which says what it can. The body is capped before it is read.
 */
import type { NextRequest } from 'next/server'
import { apiError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { createClient } from '@/lib/supabase/server'
import { isSameOriginPost } from '@/lib/links/same-origin'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { WORKSPACE_COOKIE } from '@/lib/workspace'
import { isMemberOf, lookUpMeeting, privateHeaders, smallBody } from '@/lib/meeting-links/public'
import { joinMeetingByDigest } from '@/lib/meeting-links/store'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ token: string }> }

export async function POST(request: NextRequest, { params }: Params) {
  const { token } = await params
  if (!isSameOriginPost(request)) return privateHeaders(apiError('Forbidden', { status: 403, code: 'FORBIDDEN' }))
  const body = await smallBody(request)
  if (body instanceof Response) return body
  // Relative Locations: the request's own URL behind the proxies is not the address the browser used.
  const go = (to: string) => privateHeaders(new Response(null, { status: 303, headers: { Location: to } }))
  const back = () => go(`/m/${encodeURIComponent(token)}`)
  if (!teamCallsConfig()) return back()
  const svc = getServiceClient()
  const supabase = await createClient()
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return back()
  const userId = auth.user.id
  const found = await lookUpMeeting(svc, token, request.headers, { exempt: (m) => isMemberOf(svc, userId, m.workspace_id) })
  if (found.kind !== 'open' && found.kind !== 'early') return back()
  if (!(await isMemberOf(svc, userId, found.meeting.workspace_id))) return back()
  let channelId: string
  try {
    channelId = (await joinMeetingByDigest(supabase, found.digest)).channelId
  } catch {
    return back()
  }
  const current = request.cookies.get(WORKSPACE_COOKIE)?.value
  const switchTo = current && current !== found.meeting.workspace_id ? `&switch_to=${encodeURIComponent(found.meeting.workspace_id)}` : ''
  console.info(`[meetings] meeting=${found.meeting.id} outcome=member_entered`)
  return go(`/account?meeting=${encodeURIComponent(channelId)}${switchTo}`)
}
