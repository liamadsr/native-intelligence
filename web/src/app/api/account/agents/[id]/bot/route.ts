/**
 * POST /api/account/agents/[id]/bot — give an agent its bot
 * (docs/plans/bots-v4.md, Phase B1).
 *
 * Every shared agent made now gets its bot as it's made (POST
 * /api/account/agents). This is for one made before that, or one just
 * shared from personal: the editor's "Give it a bot". The bot is made as it
 * is for a new agent (library/agent-bot.ts makeAgentTeammate): a full teammate
 * for an owner, admin or team lead, a work bot for anyone else, wearing
 * `bot_character` or the first free face, and speaking in `voice` (one of the
 * desktop's voice ids, bots-v4 B2) or Automatic.
 *
 * Under the persona's rule (its author, or a workspace owner or admin): the
 * bot speaks from the agent's instructions, so whoever may change them may
 * give it one. A personal agent gets none, and an agent that already has a bot
 * is a 409 (add it to another team from the editor or Teams instead).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { isBotCharacterType } from '@/lib/bots/teammate-faces'
import { parseVoice } from '@/lib/bots/voice-id'
import { personaKindOf, personaRule } from '@/lib/agents/editable-fields'
import { listAgentBots } from '@/lib/agents/agent-bots'
import { PERSONAL_AGENT_BOT_ERROR, agentBotFace, agentGetsABot, makeAgentTeammate, skillsErrorMessage } from '@/lib/library/agent-bot'
import { AGENT_FACE_RESERVED_ERROR, agentFaceRefused } from '@/lib/bots/agent-face'

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth
  const { id } = await params

  const body = (await request.json().catch(() => ({}))) as { bot_character?: unknown; voice?: unknown } | null
  if (body?.bot_character !== undefined && !isBotCharacterType(body.bot_character)) {
    return badRequest('bot_character must be one of the characters', { field: 'bot_character' })
  }
  // One face: an agent's bot never wears the assistant's own face.
  if (agentFaceRefused(body?.bot_character)) return badRequest(AGENT_FACE_RESERVED_ERROR, { field: 'bot_character' })
  const voice = body?.voice === undefined ? null : parseVoice(body.voice)
  if (voice && !voice.ok) return badRequest(voice.error, { field: 'voice' })

  const { data: recipe, error: recipeError } = await supabase
    .from('recipe')
    .select('id, name, category, is_system, workspace_id, created_by, visibility')
    .eq('id', id)
    .maybeSingle()
  if (recipeError) return serverError(recipeError.message)
  const agent = recipe as {
    id: string
    name: string
    category?: string
    is_system?: boolean
    workspace_id?: string | null
    created_by?: string | null
    visibility?: string | null
  } | null
  if (!agent || agent.category !== 'agent') return notFound('Agent not found')
  const kind = personaKindOf(agent, workspaceId)
  if (kind === 'anchor') return notFound('Agent not found')
  const rule = personaRule({ kind, createdBy: agent.created_by ?? null }, { userId: user.id, role: (member as { role?: string | null }).role })
  if (!rule.editable) return forbidden(rule.reason)
  if (!agentGetsABot(agent.visibility)) return badRequest(PERSONAL_AGENT_BOT_ERROR, { field: 'visibility' })

  const service = getServiceClient()
  try {
    if ((await listAgentBots(service, { workspaceId, agentId: id })).length > 0) {
      return apiError('This persona already has an agent. Add it to another team instead.', { status: 409, code: 'AGENT_HAS_BOT' })
    }
    const made = await makeAgentTeammate(service, {
      workspaceId,
      userId: user.id,
      agent: { id: agent.id, name: agent.name },
      character: await agentBotFace(service, workspaceId, body?.bot_character),
      voice: voice?.ok ? voice.voice : null,
    })
    if ('error' in made) return apiError(made.error, { status: made.status, code: 'AGENT_BOT_NOT_MADE' })
    return NextResponse.json(
      {
        ai_team_member: made.teammate,
        bot_kind: made.kind,
        ...(made.skillsError ? { skills_error: skillsErrorMessage(made.skillsError) } : {}),
      },
      { status: 201 },
    )
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not give the persona an agent')
  }
}
