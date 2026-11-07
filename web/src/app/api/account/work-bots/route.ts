/**
 * POST /api/account/work-bots — make a work bot (bots-v3 Phase 3).
 *
 * A work bot is a teammate that speaks for work and takes no assignments
 * (`ai_team_member.fronts_only`, migration 302). Any workspace member may make
 * one, because any member may make a loop and every loop has a bot; full
 * teammates stay with owners, admins and team leads (ai_team_member's RLS,
 * the ai-members routes). The insert goes through the SERVICE client after
 * these checks, limited to exactly the work-bot shape (flow-bot.ts
 * createWorkBot): the anchor persona, propose-only limits, `fronts_only`.
 *
 * Body: { bot_character?, name?, team_id? }. The face defaults to the first
 * free one, the name to the face's catalogue name, the team to the caller's
 * first team; a given team must be one the caller is on.
 *
 * The flow routes make a loop's work bot inline (bot_character on POST/PATCH);
 * this route is the seam the builder (Phase 6) saves through.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { isBotCharacterType } from '@/lib/bots/teammate-faces'
import { cleanBotName, createWorkBot, freeFaceFor, workBotTeamFor } from '@/lib/flows/flow-bot'
import { AGENT_FACE_RESERVED_ERROR, agentFaceRefused } from '@/lib/bots/agent-face'

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { user, workspaceId, member } = auth

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('JSON body required')
  if (body.bot_character !== undefined && !isBotCharacterType(body.bot_character)) {
    return badRequest('bot_character must be one of the characters', { field: 'bot_character' })
  }
  // One face: a work bot never wears the assistant's own face.
  if (agentFaceRefused(body.bot_character)) return badRequest(AGENT_FACE_RESERVED_ERROR, { field: 'bot_character' })
  if (body.name !== undefined && body.name !== null && typeof body.name !== 'string') {
    return badRequest('name must be a string', { field: 'name' })
  }
  if (body.team_id !== undefined && typeof body.team_id !== 'string') {
    return badRequest('team_id must be a team id', { field: 'team_id' })
  }

  const service = getServiceClient()
  let teamId: string | null
  if (typeof body.team_id === 'string') {
    const { data: seat } = await service
      .from('team_member')
      .select('team_id')
      .eq('team_id', body.team_id)
      .eq('member_id', member.id)
      .maybeSingle()
    const { data: team } = await service
      .from('team')
      .select('id')
      .eq('id', body.team_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!seat || !team) return badRequest('An agent goes in a team you are on', { field: 'team_id' })
    teamId = body.team_id
  } else {
    teamId = await workBotTeamFor(service, { workspaceId, userId: user.id })
  }
  if (!teamId) return badRequest('Join a team first: an agent lives on a team', { field: 'team_id' })

  const character = isBotCharacterType(body.bot_character) ? body.bot_character : await freeFaceFor(service, workspaceId)
  const made = await createWorkBot(service, {
    workspaceId,
    teamId,
    name: cleanBotName(body.name as string | null | undefined),
    character,
    createdBy: user.id,
  })
  if ('error' in made) return serverError(made.error)
  return NextResponse.json({ ai_team_member: made.teammate }, { status: 201 })
}
