/**
 * GET /api/account/agent-editor — what the one agent editor reads
 * (docs/plans/bots-v4.md, Phase B1).
 *
 *   ?agent=<id>     the Personas page: the agent (this workspace's own, or a
 *                   built-in one), with every bot built on it.
 *   ?teammate=<id>  a bot's Customize: the bot and its agent, with the other
 *                   bots on it. A system teammate or a loop's work bot is
 *                   built on an identity anchor, no agent of its own: it
 *                   comes alone, with `agent` null.
 *
 * Who may read what:
 *   - what kind of persona it is (a workspace agent, a built-in one or an
 *     anchor) on the service client, so a bot on an agent the caller can't
 *     read is still that agent's bot;
 *   - the agent itself through the caller's own client (RLS): another
 *     member's personal agent and the anchors read as missing (a 404 for
 *     ?agent=; for ?teammate=, the bot with its agent hidden);
 *   - the bots on the service client, each through the private-team rule
 *     (callerCanReachTeammate): a bot the caller can't reach is counted in
 *     `hidden_bots` (saving the agent changes it too) and never named;
 *   - a bot asked for that the caller can't reach is a 404, as the chat's
 *     mint answers.
 * The caller's role and the teams they lead come back, so the editor draws
 * each field by the same rules the write routes check (editable-fields.ts).
 * Each bot's voice (Phase B2) comes back with it, and the workspace's faces
 * carry the voices their teammates chose, so the voice picker can say who
 * else uses one.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { LIBRARY_ITEM_FIELDS } from '@/lib/library/queries'
import { callerCanReachTeammate } from '@/lib/chat/teammate-access'
import { loadWorkspaceFaces } from '@/lib/bots/workspace-faces'
import { asVoiceId } from '@/lib/bots/voice-id'
import { SYSTEM_TEAMMATE_BLURBS, type SystemTeammateKey } from '@/lib/work/system-teammates'
import { botKindOf, personaKindOf, type BotKind, type PersonaRecipeFacts } from '@/lib/agents/editable-fields'
import {
  AGENT_BOT_COLUMNS,
  leadTeamIds,
  listAgentBots,
  manageableTeams,
  skillIdsByBot,
  type AgentBotRow,
} from '@/lib/agents/agent-bots'
import type { AgentEditorData, EditorAgent, EditorBot } from '@/lib/agents/editor-model'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Loops a loop's bot names in its "about", at most. */
const ABOUT_LOOPS = 4

async function aboutFor(service: SupabaseClient, workspaceId: string, bot: AgentBotRow, kind: BotKind): Promise<string | null> {
  if (kind === 'system_teammate') {
    const key = bot.system_key as SystemTeammateKey | null
    return key && key in SYSTEM_TEAMMATE_BLURBS ? SYSTEM_TEAMMATE_BLURBS[key] : null
  }
  if (kind !== 'loop_work_bot') return null
  const { data } = await service
    .from('flow')
    .select('name, created_at')
    .eq('workspace_id', workspaceId)
    .eq('ai_team_member_id', bot.id)
    .order('created_at', { ascending: true })
  const names = ((data ?? []) as Array<{ name: string | null }>).map((f) => f.name?.trim() || 'Untitled loop')
  if (names.length === 0) return 'Speaks for no loop right now.'
  const shown = names.slice(0, ABOUT_LOOPS)
  const more = names.length - shown.length
  return `Speaks for ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
}

export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth

  const query = new URL(request.url).searchParams
  const agentParam = query.get('agent')
  const teammateParam = query.get('teammate')
  if (!agentParam === !teammateParam) return badRequest('Ask for one agent or one teammate')

  const service = getServiceClient()
  const role = (member as { role?: string | null }).role ?? null
  const reaches = (bot: AgentBotRow) =>
    callerCanReachTeammate(service, {
      userId: user.id,
      workspaceId,
      teammate: { isSystem: bot.is_system === true, teamId: bot.team_id ?? null },
      memberId: member.id,
    })

  try {
    let asked: AgentBotRow | null = null
    let agentId = agentParam
    if (teammateParam) {
      const { data, error } = await service
        .from('ai_team_member')
        .select(AGENT_BOT_COLUMNS)
        .eq('id', teammateParam)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (error) return serverError(error.message)
      const row = data as AgentBotRow | null
      if (!row || !(await reaches(row))) return notFound('Agent not found')
      asked = row
      agentId = row.agent_recipe_id
    }

    // What the persona is, read on the service client: a bot on an agent the
    // caller can't read (another member's personal agent, from before a
    // personal agent had no bot) is still that agent's bot, never a loop's.
    // Only these facts come from it; what the agent says comes from the
    // caller's own read below.
    const { data: facts, error: factsError } = await service
      .from('recipe')
      .select('id, category, is_system, workspace_id')
      .eq('id', agentId as string)
      .maybeSingle()
    if (factsError) return serverError(factsError.message)
    const personaKind = personaKindOf(facts as PersonaRecipeFacts | null, workspaceId)
    if (agentParam && personaKind === 'anchor') return notFound('Agent not found')

    // The persona, as the caller may read it (RLS): another member's personal
    // agent reads as missing, so its bot opens with its agent hidden.
    let agent: EditorAgent | null = null
    if (personaKind !== 'anchor') {
      const { data: recipe, error: recipeError } = await supabase
        .from('recipe')
        .select(`${LIBRARY_ITEM_FIELDS}, workspace_id`)
        .eq('id', agentId as string)
        .eq('category', 'agent')
        .maybeSingle()
      if (recipeError) return serverError(recipeError.message)
      if (recipe) agent = { ...(recipe as unknown as Omit<EditorAgent, 'kind'>), kind: personaKind } as EditorAgent
      else if (agentParam) return notFound('Agent not found')
    }

    // Its bots: every one built on the agent. A bot on an anchor, or on an
    // agent the caller can't read, comes alone (an anchor's other teammates
    // are every loop's bot, or other workspaces').
    const all: AgentBotRow[] = agent ? await listAgentBots(service, { workspaceId, agentId: agent.id }) : asked ? [asked] : []
    // A system teammate asked for by id is its own agent's only bot.
    if (asked && !all.some((b) => b.id === asked!.id)) all.unshift(asked)

    const visible: AgentBotRow[] = []
    let hidden = 0
    for (const bot of all) {
      if (await reaches(bot)) visible.push(bot)
      else hidden += 1
    }

    const [skills, teams, leads, faces, teamNames] = await Promise.all([
      skillIdsByBot(
        service,
        visible.map((b) => b.id),
      ),
      manageableTeams(service, { workspaceId, memberId: member.id, role }),
      leadTeamIds(service, member.id),
      loadWorkspaceFaces({ session: supabase, service, workspaceId }),
      (async () => {
        const ids = [...new Set(visible.map((b) => b.team_id).filter((id): id is string => !!id))]
        if (ids.length === 0) return new Map<string, string>()
        const { data } = await service.from('team').select('id, name').eq('workspace_id', workspaceId).in('id', ids)
        return new Map(((data ?? []) as Array<{ id: string; name: string | null }>).map((t) => [t.id, t.name?.trim() || 'Untitled team']))
      })(),
    ])

    const bots: EditorBot[] = await Promise.all(
      visible.map(async (bot) => {
        const kind = botKindOf(bot, personaKind)
        return {
          id: bot.id,
          name: bot.name,
          team_id: bot.team_id,
          team_name: bot.team_id ? (teamNames.get(bot.team_id) ?? null) : null,
          bot_character: bot.bot_character,
          voice: asVoiceId(bot.voice),
          is_system: bot.is_system === true,
          system_key: bot.system_key ?? null,
          fronts_only: bot.fronts_only === true,
          role: bot.role ?? null,
          autonomy: bot.autonomy ?? null,
          allowed_side_effects: Array.isArray(bot.allowed_side_effects) ? bot.allowed_side_effects : ['read'],
          skill_ids: skills.get(bot.id) ?? [],
          kind,
          about: await aboutFor(service, workspaceId, bot, kind),
        }
      }),
    )

    const body: AgentEditorData = {
      agent,
      bots,
      hidden_bots: hidden,
      focus: asked?.id ?? bots[0]?.id ?? null,
      caller: { user_id: user.id, role, lead_team_ids: leads },
      teams,
      workspace_faces: faces,
    }
    return NextResponse.json(body)
  } catch (err) {
    return serverError(err instanceof Error ? err.message : 'Could not read the agent')
  }
}
