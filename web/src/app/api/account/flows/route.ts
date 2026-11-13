/**
 * GET  /api/account/flows         — list flows in the current workspace
 * POST /api/account/flows         — create a new flow
 *
 * A flow is one trigger -> an ordered list of N actions (http_post |
 * run_skill), each with an optional condition. entity_status_change flows
 * are team-scoped; schedule / capture_processed flows are workspace-scoped
 * (team_id NULL). Per-action bearer tokens are encrypted server-side via
 * encryptCredential() before insert and are never returned by GET — clients
 * see `bearer_token_present` per action only.
 *
 * Every loop has a bot (bots-v3 Phase 3, flow-bot.ts): POST takes
 * `ai_team_member_id` (a teammate whose bot fronts it), `bot_new: true` (+
 * `bot_name`: always a new work agent for it), or `bot_character` (+
 * `bot_name`: a teammate wearing it, else a work bot made for it, named after
 * its character unless named), and with none picks the default
 * (the skill's holder, else Triage for a verdict skill, else a new work bot).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { lensStepRefusal } from '@/lib/flows/lens-guard'
import { badRequest, serverError } from '@/lib/api-errors'
import { findCallToolProblems } from '@/lib/flows/call-tool'
import { getServiceClient } from '@/lib/supabase/service'
import {
  defaultFlowBot,
  flowBotRefusal,
  parseFlowBotInput,
  resolveFlowBotChoice,
} from '@/lib/flows/flow-bot'
import { trackServerEvent } from '@/lib/posthog'
import { encryptCredentialOrNull } from '@/lib/crypto/credentials'
import {
  FLOW_BOT_EMBED,
  findMissingAgentIds,
  findMissingSkillIds,
  findTriggerActionMismatch,
  toPublicFlow,
  validateActions,
  validateCanvasLayout,
  validateTriggerConfig,
} from '@/lib/flows/queries'
import { nextRunAtOnWrite } from '@/lib/flows/next-run'
import { chatTriggerChannelProblem } from '@/lib/flows/event-triggers'
import type { FlowAction } from '@/lib/flows/types'

/**
 * Trigger types with a wired dispatcher (pr_status_changed: the GitHub
 * webhook, F1; email_received, chat_message and document_created: the
 * owner's own new mail, team chat messages and documents).
 */
const WIRED_TRIGGER_TYPES = new Set([
  'entity_status_change',
  'schedule',
  'capture_processed',
  'calendar_event',
  'pr_status_changed',
  'email_received',
  'chat_message',
  'document_created',
])

const FLOW_FIELDS = `
  id, workspace_id, team_id, name, description, enabled,
  trigger_type, trigger_config, actions,
  canvas_layout, created_by, created_at, updated_at, seed_key,
  ai_team_member_id, ${FLOW_BOT_EMBED}
`

export async function GET(_request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { data, error } = await supabase
    .from('flow')
    .select(FLOW_FIELDS)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })

  if (error) return serverError(error.message)

  const flows = (data || []).map((row) => toPublicFlow(row as Record<string, unknown>))
  return NextResponse.json({ flows })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return badRequest('JSON body required')

  const {
    name,
    description,
    team_id,
    enabled,
    trigger_type,
    trigger_config,
    actions,
    canvas_layout,
  } = body as Record<string, unknown>

  if (typeof name !== 'string' || !name.trim()) return badRequest('name is required')

  if (typeof trigger_type !== 'string' || !WIRED_TRIGGER_TYPES.has(trigger_type)) {
    return badRequest(
      `trigger_type must be one of ${[...WIRED_TRIGGER_TYPES].map((t) => `"${t}"`).join(', ')}`,
    )
  }
  // team_id is required ONLY for entity_status_change (team-scoped) flows;
  // schedule / capture_processed flows are workspace-scoped and store NULL.
  const isTeamScoped = trigger_type === 'entity_status_change'
  if (isTeamScoped && (typeof team_id !== 'string' || !team_id)) {
    return badRequest('team_id is required for entity_status_change flows')
  }

  const tcfg = validateTriggerConfig(trigger_type, trigger_config, { now: new Date() })
  if (tcfg instanceof Error) return badRequest(tcfg.message)
  // A chat loop's channel must be one its owner (the caller) can read.
  const channelProblem = await chatTriggerChannelProblem(getServiceClient(), { workspaceId, ownerUserId: user.id, triggerType: trigger_type, config: tcfg })
  if (channelProblem) return badRequest(channelProblem)

  // Validate the action list (config + condition per action). The bearer
  // token is supplied alongside each raw action and encrypted below — it is
  // never part of the validated/stored config.
  const validated = validateActions(actions)
  if (validated instanceof Error) return badRequest(validated.message)
  // The trigger/action cross-check (archive_capture needs a capture trigger), shared with chat's create_flow.
  const mismatch = findTriggerActionMismatch(trigger_type, validated)
  if (mismatch) return badRequest(`action ${mismatch.index + 1}: ${mismatch.message}`)

  if (isTeamScoped) {
    // Verify the team belongs to this workspace — prevent creating flows for
    // teams the caller can't access.
    const { data: team } = await supabase
      .from('team')
      .select('id')
      .eq('id', team_id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!team) return badRequest('team_id not found in workspace')
  }

  // run_skill actions must reference a skill visible to this workspace.
  const missingSkills = await findMissingSkillIds(supabase, workspaceId, validated)
  if (missingSkills.length > 0) {
    return badRequest(`skill_id "${missingSkills[0]}" not found in workspace`)
  }

  // run_agent actions must reference an agent visible to this workspace.
  const missingAgents = await findMissingAgentIds(supabase, workspaceId, validated)
  if (missingAgents.length > 0) {
    return badRequest(`agent_id "${missingAgents[0]}" not found in workspace`)
  }

  // A lens skill only after a call; the marketing lens only for owners and admins (F3).
  const lensRefusal = await lensStepRefusal(supabase, { workspaceId, userId: user.id, triggerType: trigger_type, actions: validated })
  if (lensRefusal) return badRequest(`action ${lensRefusal.index + 1}: ${lensRefusal.message}`)
  // F4: a call_tool's connection, tool and input, and a skill step's
  // connections, are the creator's own (they become the loop's owner).
  const connectorProblem = await findCallToolProblems(getServiceClient(), user.id, validated)
  if (connectorProblem) return badRequest(`action ${connectorProblem.index + 1}: ${connectorProblem.message}`, { field: connectorProblem.field })

  // Its bot: the one asked for, else the default. Resolved last, after every
  // other check, so a refused write never leaves a work bot behind.
  const botChoice = parseFlowBotInput(body as Record<string, unknown>)
  if (botChoice instanceof Error) return badRequest(botChoice.message, { field: 'ai_team_member_id' })
  const service = getServiceClient()
  const botArgs = {
    workspaceId,
    userId: user.id,
    flowTeamId: isTeamScoped ? (team_id as string) : null,
    seedKey: null,
  }
  const bot = botChoice
    ? await resolveFlowBotChoice(service, { ...botArgs, choice: botChoice })
    : await defaultFlowBot(service, { ...botArgs, actions: validated })
  if ('error' in bot) {
    return bot.status === 400 ? badRequest(bot.error, { field: 'ai_team_member_id' }) : serverError(bot.error)
  }

  // Re-attach the per-action bearer token (encrypted) by matching ids.
  const rawActions = Array.isArray(actions) ? (actions as Array<Record<string, unknown>>) : []
  const storedActions: FlowAction[] = validated.map((a, i) => {
    const raw = rawActions[i] ?? {}
    const plaintext = typeof raw.bearer_token === 'string' ? raw.bearer_token : null
    return {
      ...a,
      bearer_token_encrypted: encryptCredentialOrNull(plaintext),
    }
  })

  const { data, error } = await supabase
    .from('flow')
    .insert({
      workspace_id: workspaceId,
      team_id: isTeamScoped ? team_id : null,
      name: name.trim(),
      description: typeof description === 'string' ? description : null,
      enabled: typeof enabled === 'boolean' ? enabled : true,
      trigger_type,
      trigger_config: tcfg,
      actions: storedActions,
      canvas_layout: validateCanvasLayout(canvas_layout),
      created_by: user.id,
      ai_team_member_id: bot.teammateId,
      // Schedule flows are queued via next_run_at; the cron tick scans it.
      next_run_at: nextRunAtOnWrite(trigger_type, tcfg, new Date()),
    })
    .select(FLOW_FIELDS)
    .single()

  if (error || !data) {
    // Don't leave a work bot made for a loop that never landed.
    if (bot.created) await service.from('ai_team_member').delete().eq('id', bot.teammateId)
    const refusal = flowBotRefusal(error)
    return refusal ? badRequest(refusal, { field: 'ai_team_member_id' }) : serverError(error?.message ?? 'Insert failed')
  }

  trackServerEvent('workflow_created', { userId: user.id, workspaceId, email: user.email }, { flow_id: data.id })

  return NextResponse.json({ flow: toPublicFlow(data as Record<string, unknown>) }, { status: 201 })
}
