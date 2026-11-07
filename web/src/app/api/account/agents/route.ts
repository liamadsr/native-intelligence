import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import { trackServerEvent } from '@/lib/posthog'
import {
  LIBRARY_ITEM_FIELDS,
  PUBLISH_ROLE_ERROR,
  buildInsertRow,
  canPublishPublic,
  listLibraryItemsWithLineage,
  validateSlug,
} from '@/lib/library/queries'
import { ensureUniqueSlug, normalizeSlug } from '@/lib/library/slug'
import { parseAgentConfig } from '@/lib/library/agent-config'
import { PERSONAL_AGENT_BOT_ERROR, agentBotFace, agentGetsABot, makeAgentTeammate, skillsErrorMessage } from '@/lib/library/agent-bot'
import { isBotCharacterType } from '@/lib/bots/teammate-faces'
import { parseVoice } from '@/lib/bots/voice-id'
import { getServiceClient } from '@/lib/supabase/service'
import { AGENT_FACE_RESERVED_ERROR, agentFaceRefused } from '@/lib/bots/agent-face'

/**
 * Agents — AI personas you converse with (e.g. "Project Manager"). An agent
 * carries its own tool allowlist (agent_config.enabled_tools/disabled_tools),
 * which is the tool boundary when the agent drives a chat or capture.
 * Maps to recipe.category = 'agent' (renamed from 'live_agent').
 *
 * Making an agent makes its bot (bots-v3 Phase 6, every time since bots-v4
 * B1): every shared agent (workspace or public) gets its teammate, wearing
 * `bot_character` (one of the characters, or a built bot's id) or, with none
 * picked, the first face nobody in the workspace wears (library/agent-bot.ts):
 * a full teammate when the creator is an owner, admin or team lead, else a
 * work bot (`fronts_only`) that speaks for the agent. Its bot speaks in
 * `voice` (one of the desktop's voice ids, bots-v4 B2), else Automatic. A
 * personal agent gets none. A bad face or voice is a 400 before anything is
 * written. The agent stands even if its bot can't be made (`bot_error` says
 * why).
 */

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth

  const mine = request.nextUrl.searchParams.get('mine') === 'true'

  const { data, error } = await listLibraryItemsWithLineage(auth, 'agent', { mine })
  if (error) return serverError(error.message)
  return NextResponse.json({ agents: data || [] })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth

  const body = await request.json()
  const name = (body.name || '').trim()
  if (!name) return badRequest('Name is required')
  if (body.bot_character !== undefined && !isBotCharacterType(body.bot_character)) {
    return badRequest('bot_character must be one of the characters', { field: 'bot_character' })
  }
  // One face: the assistant's own face is never a new agent's bot's.
  if (agentFaceRefused(body.bot_character)) return badRequest(AGENT_FACE_RESERVED_ERROR, { field: 'bot_character' })
  // The route's default visibility is 'workspace' (buildInsertRow).
  if (body.bot_character !== undefined && body.visibility === 'personal') {
    return badRequest(PERSONAL_AGENT_BOT_ERROR, { field: 'bot_character' })
  }
  // Its bot's voice: one voice id, or null (Automatic). A personal agent has no bot to give one.
  const voice = body.voice === undefined ? null : parseVoice(body.voice)
  if (voice && !voice.ok) return badRequest(voice.error, { field: 'voice' })
  if (voice?.ok && voice.voice && body.visibility === 'personal') {
    return badRequest(PERSONAL_AGENT_BOT_ERROR, { field: 'voice' })
  }

  // Publishing to Discover is platform-wide — gate CREATE-as-public on owner/admin
  // (RLS opened member authoring but can't tell publish from an ordinary write).
  if (body.visibility === 'public' && !canPublishPublic(auth.member.role)) {
    return forbidden(PUBLISH_ROLE_ERROR)
  }

  // agent_config is validated against the one canonical schema, never stored raw
  // (Sequence step 1: this route and PATCH are the only writers left).
  let agentConfig: Record<string, unknown> | null | undefined = undefined
  if (body.agent_config !== undefined) {
    const parsed = parseAgentConfig(body.agent_config)
    if (!parsed.ok) return badRequest(parsed.error)
    agentConfig = parsed.config
  }

  const row = buildInsertRow(auth, {
    name,
    category: 'agent',
    visibility: body.visibility,
    system_prompt: body.system_prompt,
    icon: body.icon,
    color: body.color,
    description: body.description,
    sort_order: body.sort_order,
    model: body.model,
    agent_config: agentConfig,
  })

  // Agents aren't slash-invoked, so the editor doesn't derive a slug from the
  // name (buildInsertRow only slugs skills). But if a slug IS supplied — a
  // future surface, an API caller, a forked agent that carried one — normalize
  // it and make it unique so it can't collide in the /command namespace.
  // A collision self-heals via suffix rather than 409ing.
  if (body.slug) {
    const requested = normalizeSlug(String(body.slug))
    const slugError = validateSlug(requested)
    if (slugError) return badRequest(slugError)
    row.slug = await ensureUniqueSlug(auth.supabase, auth.workspaceId, requested)
  }

  const { data, error } = await auth.supabase
    .from('recipe')
    .insert(row)
    .select(LIBRARY_ITEM_FIELDS)
    .single()

  if (error) return serverError(error.message)

  // Fire-and-forget analytics (never blocks/fails the write). `recipe_published`
  // rides alongside on a public create.
  const { user, workspaceId } = auth
  trackServerEvent('recipe_created', { userId: user.id, workspaceId, email: user.email }, {
    category: 'agent',
    visibility: data.visibility,
    recipe_id: data.id,
    workspace_id: workspaceId,
  })
  if (data.visibility === 'public') {
    trackServerEvent('recipe_published', { userId: user.id, workspaceId, email: user.email }, {
      category: 'agent',
      recipe_id: data.id,
      workspace_id: workspaceId,
    })
  }

  // Its bot: the agent's teammate, made now so it joins the crew straight away.
  if (agentGetsABot(data.visibility)) {
    const service = getServiceClient()
    const made = await makeAgentTeammate(service, {
      workspaceId,
      userId: user.id,
      agent: { id: data.id, name: data.name ?? name },
      character: await agentBotFace(service, workspaceId, body.bot_character),
      voice: voice?.ok ? voice.voice : null,
    })
    if ('error' in made) {
      console.error('[agents] the agent’s bot was not made:', made.error)
      return NextResponse.json({ agent: data, bot_error: made.error })
    }
    return NextResponse.json({
      agent: data,
      ai_team_member: made.teammate,
      bot_kind: made.kind,
      ...(made.skillsError ? { skills_error: skillsErrorMessage(made.skillsError) } : {}),
    })
  }

  return NextResponse.json({ agent: data })
}
