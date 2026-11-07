import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { apiError, badRequest } from '@/lib/api-errors'
import { isBotCharacterType } from '@/lib/bots/teammate-faces'
import { loadWorkspaceFaces } from '@/lib/bots/workspace-faces'
import { agentSkillIds, pinnableOnly, replaceBotSkills } from '@/lib/agents/agent-bots'
import { PERSONAL_AGENT_BOT_ERROR } from '@/lib/library/agent-bot'
import { NextResponse, type NextRequest } from 'next/server'
import { AGENT_FACE_RESERVED_ERROR, agentFaceRefused } from '@/lib/bots/agent-face'

/**
 * AI team members for a team.
 *
 * An AI team member bundles ONE agent recipe (category 'agent') with N skill
 * recipes (category 'skill') under its own identity (name + avatar). It lives
 * alongside human members (public.team_member) but in its own table, so the
 * human-membership path is untouched.
 *
 * Each wears a bot face (`bot_character`, migration 294): any of the characters,
 * on any teammate, changeable any time (docs/plans/bot-characters.md, "Step
 * 3"). Two teammates of a workspace may wear the same one: the picker warns,
 * nothing here refuses it.
 *
 * A new teammate on an agent starts with the skills the agent always checks
 * (bots-v4 decision 11): its other bots' list, copied. It takes none from the
 * caller: the agent's skills change in its editor, under the agent's rule
 * (PUT /api/account/agents/[id]/skills). A personal agent has no bot.
 *
 * The teammate is inserted with the caller's client (RLS: owners, admins and
 * the team's leads), with the default limits, the only ones a team lead may
 * set (migration 305); its copied skills go through the database's one write
 * of a bot's skills, on the service client (replace_ai_member_skills: no
 * client writes them).
 */

interface AiMemberRow {
  id: string
  name: string
  avatar_url: string | null
  team_role: string
  created_at: string
  is_system: boolean
  system_key: string | null
  fronts_only?: boolean | null
  bot_character: string | null
  agent_recipe_id: string
  agent: { id: string; name: string; icon: string | null; color: string | null } | null
  ai_team_member_skill: {
    sort_order: number
    skill_recipe_id: string
    skill: { id: string; name: string; icon: string | null; color: string | null } | null
  }[]
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id: teamId } = await params

  // Verify team belongs to this workspace
  const { data: team, error: teamErr } = await supabase
    .from('team')
    .select('id')
    .eq('id', teamId)
    .eq('workspace_id', workspaceId)
    .single()

  if (teamErr || !team) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  const [{ data, error }, workspaceFaces] = await Promise.all([
    supabase
      .from('ai_team_member')
      .select(
        `id, name, avatar_url, team_role, created_at, is_system, system_key, fronts_only, bot_character, agent_recipe_id,
         agent:agent_recipe_id(id, name, icon, color),
         ai_team_member_skill(sort_order, skill_recipe_id, skill:skill_recipe_id(id, name, icon, color))`,
      )
      .eq('team_id', teamId)
      .order('created_at', { ascending: true }),
    // Every face worn in the WORKSPACE, not just this team: the picker warns on
    // a face another teammate wears and preselects the first free one, the way
    // the insert default picks it (workspace-faces.ts).
    loadWorkspaceFaces({ session: supabase, service: getServiceClient(), workspaceId }),
  ])

  if (error) {
    console.error('AI team members fetch error:', error.message, error.code, error.details)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const aiMembers = ((data || []) as unknown as AiMemberRow[]).map((row) => {
    const skillRows = (row.ai_team_member_skill || []).slice().sort((a, b) => a.sort_order - b.sort_order)
    return {
      id: row.id,
      name: row.name,
      avatar_url: row.avatar_url,
      team_role: row.team_role,
      created_at: row.created_at,
      // A system teammate (row 4) stands for a built-in loop: the roster groups it
      // and offers no remove. Its agent is a loop identity recipe no session can
      // read, so `agent` is null for it.
      is_system: row.is_system === true,
      system_key: row.system_key ?? null,
      // A work bot (migration 302) speaks for loops: its persona is the work-bot
      // anchor, fixed like a system teammate's, and it takes no assignments.
      fronts_only: row.fronts_only === true,
      bot_character: row.bot_character ?? null,
      // What the caller can read: the persona and skills, named. Another
      // creator's `personal` recipe is hidden by recipe_select_visibility, so its
      // join is null and it drops out of these...
      agent: row.agent,
      skills: skillRows.map((s) => s.skill).filter(Boolean),
      // ...and what the teammate has, readable or not, so the edit dialog keeps
      // what it can't name instead of dropping it on save (its skills are a
      // full replace).
      agent_recipe_id: row.agent_recipe_id,
      skill_recipe_ids: skillRows.map((s) => s.skill_recipe_id),
    }
  })

  return NextResponse.json({ aiMembers, workspace_faces: workspaceFaces })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id: teamId } = await params
  const body = await request.json()
  const name = (body.name || '').trim()
  const agentRecipeId = body.agent_recipe_id as string | undefined
  const avatarUrl = (body.avatar_url || null) as string | null
  const teamRole = body.team_role === 'lead' ? 'lead' : 'member'
  // Omitted: left NULL, and migration 294's insert default gives the starting
  // face (the first free one). Given: one of the characters, worn or not.
  const botCharacter: unknown = body.bot_character

  if (!name) return NextResponse.json({ error: 'Name is required' }, { status: 400 })
  if (!agentRecipeId) return NextResponse.json({ error: 'agent_recipe_id is required' }, { status: 400 })
  if (botCharacter !== undefined && !isBotCharacterType(botCharacter)) {
    return badRequest('bot_character must be one of the characters', { field: 'bot_character' })
  }
  // One face: a new teammate never wears the assistant's own face.
  if (agentFaceRefused(botCharacter)) return badRequest(AGENT_FACE_RESERVED_ERROR, { field: 'bot_character' })
  // Its skills are its agent's (decision 11): it starts with them, and they change in the agent's editor.
  if (Array.isArray(body.skill_recipe_ids) && body.skill_recipe_ids.length > 0) {
    return apiError('A new agent starts with its persona’s skills: change them in the persona’s editor.', {
      status: 400,
      code: 'AGENT_SKILLS',
    })
  }

  // Verify team belongs to workspace
  const { data: team, error: teamErr } = await supabase
    .from('team')
    .select('id')
    .eq('id', teamId)
    .eq('workspace_id', workspaceId)
    .single()

  if (teamErr || !team) {
    return NextResponse.json({ error: 'Team not found' }, { status: 404 })
  }

  // Validate the agent is an in-scope 'agent' recipe: THIS workspace's own or a
  // system one. RLS alone is not the fence — the recipe SELECT policy admits any
  // public persona from any workspace, and a teammate must never bind to a
  // persona another workspace's author controls (Sequence step 1).
  const { data: agent, error: agentErr } = await supabase
    .from('recipe')
    .select('id, category, visibility')
    .eq('id', agentRecipeId)
    .eq('category', 'agent')
    .or(`workspace_id.eq.${workspaceId},is_system.eq.true`)
    .single()

  if (agentErr || !agent) {
    return NextResponse.json({ error: 'Agent not found or not an agent' }, { status: 400 })
  }
  // A personal agent has no bot (bots-v4 B1): its words are its author's alone.
  if ((agent as { visibility?: string | null }).visibility === 'personal') {
    return apiError(PERSONAL_AGENT_BOT_ERROR, { status: 400, code: 'PERSONAL_AGENT_BOT' })
  }

  // The skills it starts with: the ones its agent's other bots always check
  // (read on the service client: they may sit on teams the caller can't see).
  let startSkillIds: string[]
  try {
    startSkillIds = await pinnableOnly(getServiceClient(), {
      workspaceId,
      ids: await agentSkillIds(getServiceClient(), { workspaceId, agentId: agentRecipeId }),
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not read the agent’s skills' }, { status: 500 })
  }

  const { data: created, error } = await supabase
    .from('ai_team_member')
    .insert({
      workspace_id: workspaceId,
      team_id: teamId,
      name,
      avatar_url: avatarUrl,
      agent_recipe_id: agentRecipeId,
      team_role: teamRole,
      created_by: user.id,
      ...(botCharacter !== undefined ? { bot_character: botCharacter } : {}),
    })
    .select('id')
    .single()

  if (error || !created) {
    return NextResponse.json({ error: error?.message || 'Failed to create' }, { status: 500 })
  }

  if (startSkillIds.length > 0) {
    const skillErr = await replaceBotSkills(getServiceClient(), { botId: created.id, skillIds: startSkillIds })
    if (skillErr) {
      // Roll back the parent so we don't leave a skill-less orphan the user
      // didn't ask for.
      await supabase.from('ai_team_member').delete().eq('id', created.id)
      return NextResponse.json({ error: `The teammate wasn’t added: its agent’s skills couldn’t be copied (${skillErr.message})` }, { status: 500 })
    }
  }

  return NextResponse.json({ ai_team_member: { id: created.id } }, { status: 201 })
}
