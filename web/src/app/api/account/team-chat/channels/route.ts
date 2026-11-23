/**
 * /api/account/team-chat/channels (roadmap #7, migration 474)
 *   GET  → { channels: TeamChatChannel[], threads, memberId, support } the
 *          channels and DMs the person may read here, with unread counts, and
 *          the threads they are in with replies unread (migration 556). For
 *          our support staff (the deployment's admins, migration 715) the
 *          list also holds every customer's support conversation (kind
 *          'support', with `support` saying whose), and `support` is
 *          { staff: true, userId }; for everyone else it is null. A
 *          person with no support conversation whose account was made since
 *          support chat began (and who never deleted theirs) gets it here,
 *          the first time it is due (src/lib/support-chat/store.ts).
 *   POST { name, teamId?, topic? } → { id } a new channel, for the whole
 *          workspace or for a team the person is in.
 * Everything runs as the person, under RLS (src/lib/team-chat/store.ts).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { createChannel, listChannels } from '@/lib/team-chat/store'
import { teamChatErrorResponse } from '@/lib/team-chat/route-errors'
import { isUuid, tidyChannelName, TEAM_CHAT_TOPIC_MAX } from '@/lib/team-chat/types'
import { getServiceClient } from '@/lib/admin'
import { isSupportStaffUser, syncSupportStaff } from '@/lib/support-chat/staff'
import { listSupportInbox, startSupportChatIfDue } from '@/lib/support-chat/store'

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    const scope = { workspaceId: auth.workspaceId, memberId: auth.member.id }
    let { channels, threads } = await listChannels(auth.supabase, scope)
    // No support conversation yet (715): one is due when the account was made since support chat
    // began and never deleted one (asked once in a while; the database decides, once per account).
    if (!channels.some((c) => c.kind === 'support') && (await startSupportChatIfDue(getServiceClient(), auth.user.id))) {
      ;({ channels, threads } = await listChannels(auth.supabase, scope))
    }
    // Our staff: every customer's support conversation too (715), read as them (the database checks
    // they are on the team; the sync puts them on it while they are an admin).
    const staff = isSupportStaffUser(auth.user) && (await syncSupportStaff(getServiceClient(), auth.user))
    if (!staff) return NextResponse.json({ channels, threads, memberId: auth.member.id, support: null })
    const own = new Set(channels.map((c) => c.id))
    const inbox = (await listSupportInbox(auth.supabase)).filter((c) => !own.has(c.id))
    return NextResponse.json({ channels: [...channels, ...inbox], threads, memberId: auth.member.id, support: { staff: true, userId: auth.user.id } })
  } catch (err) {
    return teamChatErrorResponse(err, 'channels list')
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const name = tidyChannelName(body.name)
  if (!name) return badRequest('Give the channel a name (up to 80 characters)')
  const teamId = body.teamId == null || body.teamId === '' ? null : body.teamId
  if (teamId !== null && !isUuid(teamId)) return badRequest('teamId must be a team id')
  const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
  if (topic.length > TEAM_CHAT_TOPIC_MAX) return badRequest(`Keep the topic to ${TEAM_CHAT_TOPIC_MAX} characters`)
  try {
    const id = await createChannel(auth.supabase, { workspaceId: auth.workspaceId, name, teamId, topic: topic || null })
    return NextResponse.json({ id }, { status: 201 })
  } catch (err) {
    return teamChatErrorResponse(err, 'channel create')
  }
}
