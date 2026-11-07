/**
 * PATCH  /api/account/work-bots/[id] — rename, re-face or re-voice a work bot
 * DELETE /api/account/work-bots/[id] — delete a work bot
 *
 * Bots-v3 Phase 3. Any workspace member who can reach the bot (its team isn't
 * private, or they are on it) may rename it, change its face or its voice
 * (`voice`, migration 308, bots-v4 B2: one of the desktop's voice ids, or null
 * for Automatic, checked for its shape) or delete it:
 * any member may edit any loop (migration 107), so "it fronts only loops they
 * can edit" holds for every member, and reachability is the rest. ONLY work
 * bots (`fronts_only`): a full teammate answers 403 and stays with owners,
 * admins and team leads (the ai-members routes).
 *
 * A custom agent's work bot (bots-v3 Phase 6) fronts its agent, not loops, so
 * since bots-v4 B1 changing or deleting it is for whoever may edit what it
 * fronts: the agent's author, or an owner or admin (editable-fields.ts
 * botRule). Otherwise anyone who reaches a plain member's agent's bot could
 * point it at a copy of their own and speak through it, or take the agent's
 * bot away.
 *
 * "Make a copy for this bot" (bots-v4 B1, decision 11): a custom agent's work
 * bot may be pointed (`agent_recipe_id`) at a copy of its own agent, and
 * nothing else: the copy must be this workspace's shared agent whose
 * `forked_from` is the agent the bot is built on now. A loop's work bot speaks
 * from its loops, so its persona never changes (409). Its team and its limits
 * stay as they are; its skills too, unless the copy already has bots, whose
 * shared list it then takes (one list per agent).
 *
 * Deleting it nulls `flow.ai_team_member_id` on every loop it fronted (ON
 * DELETE SET NULL); each of those loops' editors then asks for a bot. It also
 * cascades into every chat thread with it and its memory, and those threads are
 * their owners' alone (RLS, migration 300): so a plain member may not delete a
 * bot other people have a chat with (409). Owners and admins may, as they may
 * delete any teammate from the Teams panel.
 */
import { NextResponse, type NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { isBotCharacterType } from '@/lib/bots/teammate-faces'
import { parseVoice } from '@/lib/bots/voice-id'
import { callerCanReachTeammate } from '@/lib/chat/teammate-access'
import { cleanBotName, othersTalkTo } from '@/lib/flows/flow-bot'
import { botRule, personaKindOf } from '@/lib/agents/editable-fields'
import { replaceBotSkills, skillsOnJoining } from '@/lib/agents/agent-bots'
import { AGENT_FACE_RESERVED_ERROR, agentFaceRefused } from '@/lib/bots/agent-face'

const COLUMNS = 'id, workspace_id, team_id, name, is_system, system_key, fronts_only, bot_character, voice, agent_recipe_id'

interface WorkBotRow {
  team_id: string | null
  is_system: boolean
  fronts_only: boolean
  agent_recipe_id: string | null
}

/** The work bot `id` in the caller's workspace, when they may manage it; else the response to send. */
async function manageableWorkBot(
  service: SupabaseClient,
  args: { id: string; workspaceId: string; userId: string; memberId: string },
): Promise<WorkBotRow | Response> {
  const { data, error } = await service
    .from('ai_team_member')
    .select(COLUMNS)
    .eq('id', args.id)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) return serverError(error.message)
  const row = data as WorkBotRow | null
  if (!row) return notFound('Agent not found')
  const reachable = await callerCanReachTeammate(service, {
    userId: args.userId,
    workspaceId: args.workspaceId,
    teammate: { isSystem: row.is_system === true, teamId: row.team_id ?? null },
    memberId: args.memberId,
  }).catch(() => false)
  if (!reachable) return notFound('Agent not found')
  if (!row.fronts_only) {
    return forbidden('Only a work agent can be changed here: full agents are managed by owners, admins and team leads')
  }
  return row
}

type PersonaRow = {
  id: string
  category: string | null
  is_system: boolean | null
  workspace_id: string | null
  visibility: string | null
  forked_from: string | null
  created_by: string | null
}

/** The recipes a work bot's change touches (its agent now, and the one asked for), by id. */
async function readPersonas(service: SupabaseClient, ids: Array<string | null>): Promise<Map<string, PersonaRow> | Response> {
  const wanted = ids.filter((x): x is string => !!x)
  if (wanted.length === 0) return new Map()
  const { data, error } = await service
    .from('recipe')
    .select('id, category, is_system, workspace_id, visibility, forked_from, created_by')
    .in('id', wanted)
  if (error) return serverError(error.message)
  return new Map(((data ?? []) as PersonaRow[]).map((r) => [r.id, r]))
}

/**
 * Why a work bot can't be pointed from `from` to `to`, or null when it can:
 * only a custom agent's work bot, and only onto a copy of that agent (this
 * workspace's shared agent recipe, `forked_from` = `from`).
 */
function refuseRepoint(personas: Map<string, PersonaRow>, args: { workspaceId: string; from: string | null; to: string }): Response | null {
  const from = args.from ? (personas.get(args.from) ?? null) : null
  const to = personas.get(args.to) ?? null
  if (personaKindOf(from, args.workspaceId) !== 'workspace') {
    return apiError('A loop’s agent speaks from its loops: its persona cannot be changed', { status: 409, code: 'WORK_BOT' })
  }
  const isCopy =
    !!to &&
    personaKindOf(to, args.workspaceId) === 'workspace' &&
    to.visibility !== 'personal' &&
    to.forked_from === args.from
  if (!isCopy) return badRequest('A work agent can only move to a copy of its own custom agent', { field: 'agent_recipe_id' })
  return null
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { user, workspaceId, member } = auth
  const { id } = await params

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('JSON body required')

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? cleanBotName(body.name) : null
    if (!name) return badRequest('name must be a non-empty string', { field: 'name' })
    updates.name = name
  }
  if (body.bot_character !== undefined) {
    if (!isBotCharacterType(body.bot_character)) {
      return badRequest('bot_character must be one of the characters', { field: 'bot_character' })
    }
    // One face: a work bot (never the Assistant) never wears the assistant's own face.
    if (agentFaceRefused(body.bot_character)) return badRequest(AGENT_FACE_RESERVED_ERROR, { field: 'bot_character' })
    updates.bot_character = body.bot_character
  }
  if (body.voice !== undefined) {
    const voice = parseVoice(body.voice)
    if (!voice.ok) return badRequest(voice.error, { field: 'voice' })
    updates.voice = voice.voice
  }
  if (body.agent_recipe_id !== undefined) {
    if (typeof body.agent_recipe_id !== 'string' || !body.agent_recipe_id) {
      return badRequest('agent_recipe_id must be an agent id', { field: 'agent_recipe_id' })
    }
    updates.agent_recipe_id = body.agent_recipe_id
  }
  if (Object.keys(updates).length === 0) return badRequest('No fields to update')

  const service = getServiceClient()
  const target = await manageableWorkBot(service, { id, workspaceId, userId: user.id, memberId: member.id })
  if (target instanceof Response) return target

  if (updates.agent_recipe_id === target.agent_recipe_id) delete updates.agent_recipe_id
  const personas = await readPersonas(service, [target.agent_recipe_id, (updates.agent_recipe_id as string | undefined) ?? null])
  if (personas instanceof Response) return personas

  // A custom agent's work bot fronts its agent: it is the agent author's (or an
  // owner's or admin's) to change, as the agent is (editable-fields.ts botRule).
  const current = target.agent_recipe_id ? (personas.get(target.agent_recipe_id) ?? null) : null
  const kind = personaKindOf(current, workspaceId)
  if (kind === 'workspace') {
    const rule = botRule('agent_work_bot', { userId: user.id, role: (member as { role?: string | null }).role }, { kind, createdBy: current?.created_by ?? null })
    if (!rule.editable) return forbidden(rule.reason)
  }
  let joiningSkills: string[] | null = null
  if (updates.agent_recipe_id) {
    const refused = refuseRepoint(personas, { workspaceId, from: target.agent_recipe_id, to: updates.agent_recipe_id as string })
    if (refused) return refused
    try {
      joiningSkills = await skillsOnJoining(service, { workspaceId, agentId: updates.agent_recipe_id as string, botId: id })
    } catch (err) {
      return serverError(err instanceof Error ? err.message : 'Could not read the agent’s skills')
    }
  }
  if (Object.keys(updates).length === 0) return NextResponse.json({ ai_team_member: { id } })

  const { data, error } = await service
    .from('ai_team_member')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .eq('fronts_only', true)
    .select(COLUMNS)
    .single()
  if (error || !data) return serverError(error?.message ?? 'Update failed')
  if (joiningSkills) {
    const skillErr = await replaceBotSkills(service, { botId: id, skillIds: joiningSkills })
    if (skillErr) {
      return apiError(`It now uses the copy, but its skills didn’t change to the copy’s: ${skillErr.message}`, {
        status: 500,
        code: 'AGENT_SKILLS_NOT_COPIED',
      })
    }
  }
  return NextResponse.json({ ai_team_member: data })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // The role is read with the member row: requireWorkspaceMember reads only
  // `id` unless asked, and an unread role made every owner and admin a plain
  // member here (refused with the 409 below).
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { user, workspaceId, member } = auth
  const { id } = await params

  const service = getServiceClient()
  const target = await manageableWorkBot(service, { id, workspaceId, userId: user.id, memberId: member.id })
  if (target instanceof Response) return target

  // A custom agent's work bot is its agent's face: deleting it is the agent
  // author's, or an owner's or admin's, as changing it is.
  const personas = await readPersonas(service, [target.agent_recipe_id])
  if (personas instanceof Response) return personas
  const current = target.agent_recipe_id ? (personas.get(target.agent_recipe_id) ?? null) : null
  const kind = personaKindOf(current, workspaceId)
  if (kind === 'workspace') {
    const rule = botRule('agent_work_bot', { userId: user.id, role: member.role }, { kind, createdBy: current?.created_by ?? null })
    if (!rule.editable) return forbidden(rule.reason)
  }

  const elevated = member.role === 'owner' || member.role === 'admin'
  if (!elevated && (await othersTalkTo(service, { teammateId: id, userId: user.id }))) {
    return apiError('Other people have a chat with this agent, and deleting it would delete their chats. Ask an owner or admin, or rename it instead.', {
      status: 409,
      code: 'WORK_BOT_IN_USE',
    })
  }

  const { error } = await service
    .from('ai_team_member')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .eq('fronts_only', true)
  if (error) return serverError(error.message)
  return NextResponse.json({ ok: true })
}
