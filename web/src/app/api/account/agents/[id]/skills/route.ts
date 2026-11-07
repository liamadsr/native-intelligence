/**
 * PUT /api/account/agents/[id]/skills — the skills an agent always checks
 * (docs/plans/bots-v4.md, Phase B1, decision 11).
 *
 * Body: `{ skill_recipe_ids: string[] }`, in order: at most five, each this
 * workspace's own skill or a system one, never a personal one
 * (checkPinnableSkills).
 *
 * The persona's rule decides (its author, or a workspace owner or admin;
 * never a built-in agent or an anchor): the agent's skills are shared by every
 * bot on it, so whoever may change its instructions may change them, and
 * nobody else. A team lead who isn't the agent's author can't, even for a bot
 * on their own team: "Make a copy for this bot" gives them one to change.
 *
 * The list replaces each bot's (`ai_team_member_skill`): every bot built on
 * the agent in this workspace, its work bot included. Never a loop's work bot
 * (built on the work-bot anchor) or a system teammate (its own agent; the
 * ai-members route keeps its skills). The writes go through the SERVICE
 * client, one bot at a time (replace_ai_member_skills, migration 305: whole,
 * at most five, under a lock on the bot): the rule here is the persona's,
 * which ai_team_member's RLS (team leads and admins) doesn't know.
 *
 * The answer names only the bots the caller can reach (the private-team rule,
 * as the editor lists them) and counts the rest, whether they changed or not:
 * a bot whose write fails is named in a 500 if the caller may know of it.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { personaKindOf, personaRule } from '@/lib/agents/editable-fields'
import { callerCanReachTeammate } from '@/lib/chat/teammate-access'
import { checkPinnableSkills, listAgentBots, writeBotSkills } from '@/lib/agents/agent-bots'

const listNames = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? 'an agent') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`

const privately = (count: number) => `${count} on ${count === 1 ? 'a private team' : 'private teams'}`

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth
  const { id } = await params

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('JSON body required')

  // The persona, as the caller may read it (RLS): another member's personal agent reads as missing.
  const { data: recipe, error: recipeError } = await supabase
    .from('recipe')
    .select('id, category, is_system, workspace_id, created_by')
    .eq('id', id)
    .maybeSingle()
  if (recipeError) return serverError(recipeError.message)
  const row = recipe as { category?: string; is_system?: boolean; workspace_id?: string | null; created_by?: string | null } | null
  if (!row || row.category !== 'agent') return notFound('Agent not found')
  const kind = personaKindOf(row, workspaceId)
  if (kind === 'anchor') return notFound('Agent not found')
  const rule = personaRule({ kind, createdBy: row.created_by ?? null }, { userId: user.id, role: (member as { role?: string | null }).role })
  if (!rule.editable) return forbidden(rule.reason)

  const service = getServiceClient()
  try {
    const check = await checkPinnableSkills(service, { workspaceId, ids: body.skill_recipe_ids })
    if (!check.ok) return apiError(check.error, { status: 400, code: check.code, details: { field: 'skill_recipe_ids' } })

    const bots = await listAgentBots(service, { workspaceId, agentId: id })
    if (bots.length === 0) {
      return apiError('Its skills live on its agent: give the persona an agent first.', { status: 409, code: 'AGENT_HAS_NO_BOT' })
    }
    // The bots the caller may know of: one on a private team they're not on
    // changes too, but is counted, never named.
    const known = new Set<string>()
    for (const bot of bots) {
      const reaches = await callerCanReachTeammate(service, {
        userId: user.id,
        workspaceId,
        teammate: { isSystem: bot.is_system === true, teamId: bot.team_id ?? null },
        memberId: member.id,
      })
      if (reaches) known.add(bot.id)
    }
    const nameOf = (botId: string) => bots.find((b) => b.id === botId)?.name ?? 'an agent'
    const unknown = (ids: string[]) => ids.filter((botId) => !known.has(botId)).length

    const written = await writeBotSkills(service, { botIds: bots.map((b) => b.id), skillIds: check.ids })
    if (written.failed.length > 0) {
      const failedIds = written.failed.map((f) => f.id)
      const hiddenFailed = unknown(failedIds)
      const named = failedIds.filter((botId) => known.has(botId)).map(nameOf)
      return apiError(`Its skills didn’t change for ${listNames(hiddenFailed > 0 ? [...named, privately(hiddenFailed)] : named)}.`, {
        status: 500,
        code: 'AGENT_SKILLS_PARTIAL',
        details: {
          changed: written.changed.filter((botId) => known.has(botId)).map((botId) => ({ id: botId, name: nameOf(botId) })),
          hidden_changed: unknown(written.changed),
          failed: written.failed.filter((f) => known.has(f.id)).map((f) => ({ id: f.id, name: nameOf(f.id), error: f.error })),
          hidden_failed: hiddenFailed,
        },
      })
    }
    return NextResponse.json({
      skill_recipe_ids: check.ids,
      bots: written.changed.filter((botId) => known.has(botId)),
      hidden_bots: unknown(written.changed),
    })
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not save the agent’s skills')
  }
}
