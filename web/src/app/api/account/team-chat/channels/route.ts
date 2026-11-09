/**
 * /api/account/team-chat/channels (roadmap #7, migration 474)
 *   GET  → { channels: TeamChatChannel[], memberId } the channels and DMs the
 *          person may read here, with unread counts.
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

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    const channels = await listChannels(auth.supabase, { workspaceId: auth.workspaceId, memberId: auth.member.id })
    return NextResponse.json({ channels, memberId: auth.member.id })
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
