/**
 * /api/account/meeting-links (calls plan, phase 7, migrations 572-575)
 *   POST { title, startsAt?, minutes? } → { meeting } a meeting link in the
 *        current workspace, made as the person (they are its host): its
 *        conversation (kind 'meeting'), its link (`<app>/m/<token>`), and
 *        when the link works (src/lib/meeting-links/create.ts). The conversation
 *        shows in team chat once it is used.
 *   GET ?channel=<id> → { meeting } the meeting a conversation is, with its
 *        link, for whoever may read the conversation (RLS), or null.
 * 404 for both while calling is off (the LiveKit settings unset): there is
 * nothing a meeting could be.
 */
import { after, NextResponse, type NextRequest } from 'next/server'
import { requireUser, requireWorkspace } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { TeamChatError } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isUuid } from '@/lib/team-chat/types'
import { teamCallsConfig } from '@/lib/team-calls/livekit'
import { teamCallsUnavailable } from '@/lib/team-calls/routes'
import { createMeetingLink } from '@/lib/meeting-links/create'
import { meetingLink } from '@/lib/meeting-links/link'
import { meetingNonce, meetingOfChannel } from '@/lib/meeting-links/store'
import { getServiceClient } from '@/lib/admin'
import { addMeetingToCalendar } from '@/lib/meeting-links/calendar-events'
import { listMyMeetings } from '@/lib/meeting-links/mine'
import { writableCalendarAccounts } from '@/lib/time-offers/host-calendar'

export async function GET(request: NextRequest) {
  if (!teamCallsConfig()) return teamCallsUnavailable()
  const view = request.nextUrl.searchParams.get('view')
  // ?view=mine: team chat's meetings section (the person's meetings, current first).
  if (view === 'mine') {
    const ws = await requireWorkspace()
    if (ws instanceof Response) return ws
    try {
      return NextResponse.json({ meetings: await listMyMeetings(ws.supabase, getServiceClient(), { workspaceId: ws.workspaceId, userId: ws.user.id }) })
    } catch (err) {
      return teamChatErrorResponse(err, 'meetings read')
    }
  }
  // ?view=calendars: where a scheduled meeting can be put (the person's writable calendars, the default first).
  if (view === 'calendars') {
    const ws = await requireWorkspace()
    if (ws instanceof Response) return ws
    try {
      const calendars = await writableCalendarAccounts(getServiceClient(), ws.user.id, ws.workspaceId)
      return NextResponse.json({ calendars })
    } catch (err) {
      return teamChatErrorResponse(err, 'calendars read')
    }
  }
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const channelId = request.nextUrl.searchParams.get('channel')
  if (!isUuid(channelId)) return badRequest('channel must be a conversation id')
  try {
    const meeting = await meetingOfChannel(auth.supabase, channelId)
    if (!meeting) return NextResponse.json({ meeting: null })
    const { workspace_id: _ws, ...rest } = meeting
    // The link's nonce is the server's alone (no client grant): read with the service role once RLS let the person see the meeting.
    const nonce = await meetingNonce(getServiceClient(), meeting.id)
    return NextResponse.json({ meeting: { ...rest, url: nonce ? meetingLink(meeting.id, nonce) : null } })
  } catch (err) {
    return teamChatErrorResponse(err, 'meeting read')
  }
}

export async function POST(request: NextRequest) {
  if (!teamCallsConfig()) return teamCallsUnavailable()
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const startsAt = typeof input.startsAt === 'string' && input.startsAt ? input.startsAt : null
  const minutes = typeof input.minutes === 'number' ? input.minutes : null
  const calendarAccountId = typeof input.calendarAccountId === 'string' && isUuid(input.calendarAccountId) ? input.calendarAccountId : null
  try {
    const made = await createMeetingLink(auth.supabase, { workspaceId: auth.workspaceId, title: String(input.title ?? ''), startsAt, minutes })
    // Scheduled: on the host's calendar (the one they picked, else their default), after the answer;
    // a calendar that fails never fails the meeting (it still shows in team chat and the app's calendar).
    if (made.startsAt && made.endsAt) {
      const meeting = { id: made.meetingId, title: made.title, startsAt: made.startsAt, endsAt: made.endsAt, url: made.url }
      after(() => addMeetingToCalendar(getServiceClient(), { meeting, userId: auth.user.id, workspaceId: auth.workspaceId, accountId: calendarAccountId }).then(() => undefined))
    }
    return NextResponse.json({ meeting: made })
  } catch (err) {
    if (err instanceof TeamChatError && err.code === 'bad_request') return badRequest(err.message)
    return teamChatErrorResponse(err, 'meeting create')
  }
}
