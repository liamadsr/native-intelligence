import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/supabase/service'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { apiError, badRequest, forbidden, notFound } from '@/lib/api-errors'
import { isBotCharacterType } from '@/lib/bots/teammate-faces'
import { parseVoice } from '@/lib/bots/voice-id'
import { MAX_PINNED_SKILLS, botKindOf, botRule, kindAllows, personaKindOf, skillsRouteFor, FIELD_REASONS } from '@/lib/agents/editable-fields'
import { isInvalidSkill, isTooManySkills, replaceBotSkills, skillsOnJoining } from '@/lib/agents/agent-bots'
import { PERSONAL_AGENT_BOT_ERROR } from '@/lib/library/agent-bot'
import { NextResponse, type NextRequest } from 'next/server'
import { AGENT_FACE_RESERVED_ERROR, agentFaceRefused } from '@/lib/bots/agent-face'

/**
 * Edit / remove a single AI team member. Writes are gated by RLS (workspace
 * admins or team leads); we additionally verify the team is in the active
 * workspace, matching the human-members route convention.
 *
 * Two editors save here: the Teams panel's "Edit AI teammate" dialog and the
 * one agent editor's "This bot" (bots-v4 B1). The fields: name, face
 * (`bot_character`, migration 294), voice (`voice`, migration 308: one of the
 * desktop's voice ids, or null for Automatic; bots-v4 B2), team (`team_id`),
 * the persona it's built on ("Make a copy for this bot" points it at a copy)
 * and, for a system teammate only, its skills. Any face goes on any teammate,
 * system ones included, and a face worn by another teammate is allowed (the
 * picker warns; docs/plans/bot-characters.md, "Step 3"). So is a voice another
 * bot chose (the editor says who). A voice is checked for its shape only:
 * which voices there are is each desktop's to say.
 *
 * What each kind of bot may change is editable-fields.ts's:
 *   - its team: a full teammate's moves to another team of the workspace
 *     (RLS checks the caller manages both); a system teammate or a work bot
 *     stays where it is (409). A bot that speaks for loops never moves onto a
 *     private team: the people its loops run as might not reach it there.
 *   - its skills: a system teammate's are its own (this route, up to five,
 *     never a newly added personal one). Any other bot's are its agent's,
 *     shared by every bot on it (decision 11): PUT /api/account/agents/[id]/skills
 *     under the persona's rule, so this route refuses them (409). A full
 *     teammate moved onto an agent that has other bots takes their list.
 *   - an agent's work bot speaks for its agent: its name, face and place on
 *     its team are the agent author's, or an owner's or admin's (botRule),
 *     not every team lead's.
 *
 * Skills are written by the database's one write of a bot's skills
 * (replace_ai_member_skills, migration 305: whole, at most five, under a lock
 * on the bot), on the service client, after the caller's own write of the row
 * has passed RLS. The limits columns aren't written here at all: they are
 * Settings → Autonomy's, owners' and admins' only (the database holds that
 * too).
 *
 * The editor may not be able to read everything the teammate has: another
 * creator's `personal` persona or skill is hidden from them by
 * recipe_select_visibility. The dialog sends those ids back as they are, so a
 * skill already on the teammate stays valid here without being readable, and
 * the persona it already has is not a re-point.
 */

/** RLS refusing a write outright: PostgREST's 42501 ("new row violates row-level security policy"). */
function isRlsRefusal(error: { code?: string; message?: string } | null): boolean {
  return !!error && (error.code === '42501' || /row-level security/i.test(error.message ?? ''))
}

const MANAGE_ONLY = 'Only workspace admins and this team’s leads can edit its AI teammates'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; aiMemberId: string }> },
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

  const { id: teamId, aiMemberId } = await params
  const body = await request.json()

  if ('bot_character' in body && !isBotCharacterType(body.bot_character)) {
    return badRequest('bot_character must be one of the characters', { field: 'bot_character' })
  }
  // A bot's voice is its own, like its face (decision 11): one voice id, or null for Automatic.
  const voice = 'voice' in body ? parseVoice(body.voice) : null
  if (voice && !voice.ok) return badRequest(voice.error, { field: 'voice' })

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

  // A system teammate (row 4) stands for a built-in loop: its agent is fixed
  // (the database refuses the rebind too, migration 283). Name, avatar, face,
  // role on the team and skills stay editable.
  const { data: target } = await supabase
    .from('ai_team_member')
    .select('is_system, system_key, fronts_only, role, agent_recipe_id')
    .eq('id', aiMemberId)
    .eq('team_id', teamId)
    .maybeSingle()
  if (!target) return notFound('AI teammate not found')
  // One face: the assistant's own face is the workspace's Assistant's alone.
  if ('bot_character' in body && agentFaceRefused(body.bot_character, target)) {
    return badRequest(AGENT_FACE_RESERVED_ERROR, { field: 'bot_character' })
  }
  if (target.is_system && body.agent_recipe_id) {
    return NextResponse.json(
      { error: 'A system teammate’s agent cannot be changed', code: 'SYSTEM_TEAMMATE' },
      { status: 409 },
    )
  }
  // A loop's work bot (fronts_only, migration 302) is bound to the work-bot
  // anchor and speaks from the loops it fronts; a persona would never be run.
  if (target.fronts_only === true && body.agent_recipe_id && body.agent_recipe_id !== target.agent_recipe_id) {
    return NextResponse.json(
      { error: 'A loop’s agent speaks from its loops: its persona cannot be changed', code: 'WORK_BOT' },
      { status: 409 },
    )
  }

  // What kind of bot it is decides whether this route takes its team and its
  // skills, and who may change a work bot (editable-fields.ts). Its persona is
  // read on the service client: a system teammate's or a loop bot's is an
  // anchor no session can read, and an agent's may be one the caller can't.
  const service = getServiceClient()
  const asksTeam = 'team_id' in body
  const asksSkills = Array.isArray(body.skill_recipe_ids)
  let kind = botKindOf(target, 'workspace')
  let personaAuthor: string | null = null
  if (asksTeam || asksSkills || target.fronts_only === true) {
    const { data: persona, error: personaErr } = await service
      .from('recipe')
      .select('is_system, workspace_id, category, created_by')
      .eq('id', target.agent_recipe_id)
      .maybeSingle()
    // Fail closed: a work bot whose agent can't be read can't be told from a
    // loop's bot, whose rule is looser.
    if (personaErr || (target.fronts_only === true && !persona)) {
      return NextResponse.json({ error: personaErr?.message ?? 'Could not read the agent’s persona' }, { status: 500 })
    }
    kind = botKindOf(target, personaKindOf(persona, workspaceId))
    personaAuthor = (persona as { created_by?: string | null } | null)?.created_by ?? null
  }

  // An agent's work bot speaks for its agent: changing it is the agent's
  // author's, or an owner's or admin's (as in the editor and the work-bot
  // route), whoever leads its team.
  if (kind === 'agent_work_bot') {
    const { data: me, error: meErr } = await service
      .from('member')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle()
    if (meErr) return NextResponse.json({ error: meErr.message }, { status: 500 })
    const rule = botRule(
      'agent_work_bot',
      { userId: user.id, role: (me as { role?: string | null } | null)?.role ?? null },
      { kind: 'workspace', createdBy: personaAuthor },
    )
    if (!rule.editable) return forbidden(rule.reason)
  }

  const updates: Record<string, unknown> = {}

  if (asksTeam) {
    const rule = kindAllows(kind, 'team')
    if (!rule.editable) return apiError(rule.reason, { status: 409, code: 'TEAM_FIXED' })
    if (typeof body.team_id !== 'string' || !body.team_id) return badRequest('team_id must be a team id', { field: 'team_id' })
    if (body.team_id !== teamId) {
      const { data: next } = await supabase
        .from('team')
        .select('id, is_private')
        .eq('id', body.team_id)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (!next) return badRequest('Team not found', { field: 'team_id' })
      // Only an explicit false is public (callerCanReachTeammate's rule).
      if (next.is_private !== false) {
        const { count, error: loopsErr } = await service
          .from('flow')
          .select('id', { count: 'exact', head: true })
          .eq('ai_team_member_id', aiMemberId)
        if (loopsErr) return NextResponse.json({ error: loopsErr.message }, { status: 500 })
        if ((count ?? 0) > 0) {
          return apiError('This agent speaks for loops, so it can’t move to a private team: the people its loops run as might not be on it.', {
            status: 409,
            code: 'BOT_FRONTS_LOOPS',
          })
        }
      }
      updates.team_id = body.team_id
    }
  }

  // The skill set, when skill_recipe_ids is given (a full replace, not a
  // patch), is checked before anything is written: a system teammate's only.
  // A skill already on the teammate stays valid even where the editor can't
  // read it (another creator's personal skill); a new one must be a skill
  // recipe they can read, of this workspace or the system, and not personal.
  let skillIds: string[] | null = null
  if (asksSkills) {
    const route = skillsRouteFor(kind)
    if (route !== 'bot') {
      return apiError(
        route === 'agent' ? 'Its skills are its persona’s, shared by every agent on it: change them in the persona’s editor.' : FIELD_REASONS.loopSkills,
        { status: 409, code: 'AGENT_SKILLS' },
      )
    }
    skillIds = [...new Set(body.skill_recipe_ids as string[])]
    if (skillIds.length > MAX_PINNED_SKILLS) {
      return apiError(`An agent can always check up to ${MAX_PINNED_SKILLS} skills`, { status: 400, code: 'TOO_MANY_SKILLS' })
    }
    const { data: attached } = await supabase
      .from('ai_team_member_skill')
      .select('skill_recipe_id')
      .eq('ai_team_member_id', aiMemberId)
    const kept = new Set((attached || []).map((s) => s.skill_recipe_id as string))
    const added = skillIds.filter((id) => !kept.has(id))
    if (added.length > 0) {
      const { data: skills } = await supabase
        .from('recipe')
        .select('id, visibility')
        .in('id', added)
        .eq('category', 'skill')
        // New skills stay in this workspace (or are system skills), even if
        // RLS also lets the editor read another workspace's public recipe.
        .or(`workspace_id.eq.${workspaceId},is_system.eq.true`)
      if ((skills || []).length !== added.length) {
        return NextResponse.json({ error: 'One or more skills are invalid' }, { status: 400 })
      }
      if ((skills || []).some((s) => (s as { visibility?: string | null }).visibility === 'personal')) {
        return apiError('A personal skill can’t be one an agent always checks: share it with the workspace first', {
          status: 400,
          code: 'PERSONAL_SKILL',
        })
      }
    }
  }

  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim()
  if ('avatar_url' in body) updates.avatar_url = body.avatar_url || null
  if (body.team_role && ['lead', 'member'].includes(body.team_role)) {
    updates.team_role = body.team_role
  }
  if ('bot_character' in body) updates.bot_character = body.bot_character
  // Not one of the limits columns (migration 305): whoever may manage the
  // teammate sets it, as its face, under the same RLS write below.
  if (voice?.ok) updates.voice = voice.voice
  // The persona it already has is no re-point: it may be one the editor
  // can't read, which the fence read below would refuse.
  if (body.agent_recipe_id && body.agent_recipe_id !== target.agent_recipe_id) {
    // Pinned to this workspace's own personas or a system one — never another
    // workspace's public persona (Sequence step 1).
    const { data: agent } = await supabase
      .from('recipe')
      .select('id, visibility')
      .eq('id', body.agent_recipe_id)
      .eq('category', 'agent')
      .or(`workspace_id.eq.${workspaceId},is_system.eq.true`)
      .single()
    if (!agent) {
      return NextResponse.json({ error: 'Agent not found or not an agent' }, { status: 400 })
    }
    // A personal agent has no bot (bots-v4 B1): its words are its author's alone.
    if ((agent as { visibility?: string | null }).visibility === 'personal') {
      return apiError(PERSONAL_AGENT_BOT_ERROR, { status: 400, code: 'PERSONAL_AGENT_BOT' })
    }
    updates.agent_recipe_id = body.agent_recipe_id
  }

  // A full teammate moving onto an agent with other bots takes the skills
  // they share (decision 11: one list per agent). Onto an agent with none (a
  // copy made for it), it keeps its own. Read before anything is written.
  let joiningSkills: string[] | null = null
  if (updates.agent_recipe_id && !target.is_system && target.fronts_only !== true) {
    try {
      joiningSkills = await skillsOnJoining(service, { workspaceId, agentId: updates.agent_recipe_id as string, botId: aiMemberId })
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not read the agent’s skills' }, { status: 500 })
    }
  }

  // Whatever else changes, the row is written first, and that write is the
  // manage check: RLS filters an UPDATE it refuses down to no rows, with no
  // error. The caller can see the teammate (read above) but may not manage it.
  // A skills-only edit still touches the row (updated_at): the skills are
  // written on the service client, so this write is what says the caller may.
  // A move to a team the caller doesn't manage fails the policy's check on
  // the new row: an RLS refusal, so the same 403.
  if (Object.keys(updates).length > 0 || skillIds) {
    const { data: written, error } = await supabase
      .from('ai_team_member')
      .update(Object.keys(updates).length > 0 ? updates : { updated_at: new Date().toISOString() })
      .eq('id', aiMemberId)
      .eq('team_id', teamId)
      .select('id')
    if (error) {
      return isRlsRefusal(error) ? forbidden(MANAGE_ONLY) : NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!written || written.length === 0) return forbidden(MANAGE_ONLY)
  }

  if (skillIds) {
    const skillErr = await replaceBotSkills(service, { botId: aiMemberId, skillIds })
    if (skillErr) {
      // The database's own limits, checked above too: at most five, each this
      // workspace's or a system skill (one left from another workspace before
      // the routes pinned skills is refused).
      if (isTooManySkills(skillErr)) {
        return apiError(`An agent can always check up to ${MAX_PINNED_SKILLS} skills`, { status: 400, code: 'TOO_MANY_SKILLS' })
      }
      if (isInvalidSkill(skillErr)) {
        return apiError('One or more skills are invalid: each must be this workspace’s or a system skill', { status: 400, code: 'INVALID_SKILLS' })
      }
      return NextResponse.json({ error: skillErr.message }, { status: 500 })
    }
  }

  if (joiningSkills) {
    const skillErr = await replaceBotSkills(service, { botId: aiMemberId, skillIds: joiningSkills })
    if (skillErr) {
      return apiError(`It now uses the new agent, but its skills didn’t change to the agent’s: ${skillErr.message}`, {
        status: 500,
        code: 'AGENT_SKILLS_NOT_COPIED',
      })
    }
  }

  return NextResponse.json({ success: true })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; aiMemberId: string }> },
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

  const { id: teamId, aiMemberId } = await params

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

  // A system teammate (row 4) is not removable: it is the attribution for a
  // built-in loop. The database refuses the delete as well (migration 283); this
  // answers with a clean 409 instead of a trigger error.
  const { data: target } = await supabase
    .from('ai_team_member')
    .select('is_system, fronts_only, agent_recipe_id')
    .eq('id', aiMemberId)
    .eq('team_id', teamId)
    .maybeSingle()
  if (target?.is_system) {
    return NextResponse.json(
      { error: 'System teammates cannot be removed', code: 'SYSTEM_TEAMMATE' },
      { status: 409 },
    )
  }
  // An agent's work bot is its agent's face: removing it is the agent
  // author's, or an owner's or admin's (botRule), as changing it is.
  if (target?.fronts_only === true) {
    const service = getServiceClient()
    const [{ data: persona, error: personaErr }, { data: me, error: meErr }] = await Promise.all([
      service.from('recipe').select('is_system, workspace_id, category, created_by').eq('id', target.agent_recipe_id).maybeSingle(),
      service.from('member').select('role').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle(),
    ])
    // Fail closed, as the PATCH does: unread, it would pass for a loop's bot.
    if (personaErr || meErr || !persona) {
      return NextResponse.json({ error: (personaErr ?? meErr)?.message ?? 'Could not read the agent’s persona' }, { status: 500 })
    }
    if (botKindOf(target, personaKindOf(persona, workspaceId)) === 'agent_work_bot') {
      const rule = botRule(
        'agent_work_bot',
        { userId: user.id, role: (me as { role?: string | null } | null)?.role ?? null },
        { kind: 'workspace', createdBy: (persona as { created_by?: string | null } | null)?.created_by ?? null },
      )
      if (!rule.editable) return forbidden(rule.reason)
    }
  }

  // ai_team_member_skill rows cascade-delete via FK. As in the PATCH, the
  // write is the manage check: RLS (admin or team lead, migration 144) filters
  // a refused DELETE down to no rows, with no error.
  const { data: deleted, error } = await supabase
    .from('ai_team_member')
    .delete()
    .eq('id', aiMemberId)
    .eq('team_id', teamId)
    .select('id')

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!deleted || deleted.length === 0) {
    return target ? forbidden(MANAGE_ONLY) : notFound('AI teammate not found')
  }

  return NextResponse.json({ success: true })
}
