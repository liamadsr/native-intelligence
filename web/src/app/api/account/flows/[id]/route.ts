/**
 * GET    /api/account/flows/[id]  — read one flow
 * PATCH  /api/account/flows/[id]  — update fields (per-action tokens rotated only if provided)
 * DELETE /api/account/flows/[id]  — delete
 *
 * PATCH changes a loop's bot (bots-v3 Phase 3, flow-bot.ts) with
 * `ai_team_member_id` (a teammate), `bot_new: true` (+ `bot_name`: always a new
 * work agent) or `bot_character` (+ `bot_name`: a work bot made for it). It can't clear it: a loop always has a bot. A work bot the
 * loop stops naming (a re-pick, or DELETE) is deleted when nothing else needs
 * it (retireWorkBotIfUnused): no other loop, no chat thread, no memory, no run.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { lensStepRefusal } from '@/lib/flows/lens-guard'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { canonicalJson, classifyStepEdit, flowOwnership, isRiskyFlow } from '@/lib/flows/flow-approvals'
import { createFlowTools } from '@/lib/ai/tools/flows'
import { getServiceClient } from '@/lib/supabase/service'
import { findCallToolProblems } from '@/lib/flows/call-tool'
import { flowBotRefusal, parseFlowBotInput, resolveFlowBotChoice, retireWorkBotIfUnused, runAsUserFor } from '@/lib/flows/flow-bot'
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
import { nextRunAtOnEnable, nextRunAtOnWrite } from '@/lib/flows/next-run'
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

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  const { data } = await supabase
    .from('flow')
    .select(FLOW_FIELDS)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!data) return notFound('Flow not found')
  // Who owns it, for the editor's read-only state (F1): a non-owner sees the
  // trigger and steps read-only, with "Take over this flow".
  const ownership = await flowOwnership(getServiceClient(), {
    workspaceId,
    flowId: id,
    ownerId: ((data as Record<string, unknown>).created_by as string | null) ?? null,
    viewerId: user.id,
  })
  return NextResponse.json({ flow: { ...toPublicFlow(data as Record<string, unknown>), ...ownership } })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return badRequest('JSON body required')

  const updates: Record<string, unknown> = {}

  if (typeof body.name === 'string') updates.name = body.name.trim()
  if (typeof body.description === 'string' || body.description === null) {
    updates.description = body.description
  }
  if (typeof body.enabled === 'boolean') updates.enabled = body.enabled

  if (
    body.trigger_type !== undefined &&
    (typeof body.trigger_type !== 'string' || !WIRED_TRIGGER_TYPES.has(body.trigger_type))
  ) {
    return badRequest(
      `trigger_type must be one of ${[...WIRED_TRIGGER_TYPES].map((t) => `"${t}"`).join(', ')}`,
    )
  }

  // Trigger changes (and re-enables) need the current row: the config shape
  // is validated against the EFFECTIVE trigger type, and schedule flows keep
  // next_run_at in sync with their config.
  const touchesTrigger = body.trigger_type !== undefined || body.trigger_config !== undefined
  if (touchesTrigger || body.enabled === true) {
    const { data: existing } = await supabase
      .from('flow')
      .select('trigger_type, trigger_config, team_id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!existing) return notFound('Flow not found')

    const currentType = existing.trigger_type as string
    const nextType = typeof body.trigger_type === 'string' ? body.trigger_type : currentType

    if (touchesTrigger) {
      // Resolve the config to validate: the provided one; the stored one when
      // only re-asserting the same type; or a synthesized empty object when
      // switching to capture_processed (its config carries no fields).
      let rawCfg = body.trigger_config
      if (rawCfg === undefined) {
        if (nextType !== currentType && nextType !== 'capture_processed') {
          return badRequest('trigger_config is required when changing trigger_type')
        }
        rawCfg = nextType === currentType ? existing.trigger_config : {}
      }
      // A once time in the past is refused unless it is the stored one unchanged (a re-save from the editor).
      const tcfg = validateTriggerConfig(nextType, rawCfg, { now: new Date(), storedConfig: nextType === currentType ? existing.trigger_config : undefined })
      if (tcfg instanceof Error) return badRequest(tcfg.message)
      updates.trigger_type = nextType
      updates.trigger_config = tcfg

      if (nextType === 'entity_status_change') {
        // Team-scoped: keep the existing team or accept a provided one.
        const teamId =
          typeof body.team_id === 'string' && body.team_id
            ? body.team_id
            : (existing.team_id as string | null)
        if (!teamId) return badRequest('team_id is required for entity_status_change flows')
        if (teamId !== existing.team_id) {
          const { data: team } = await supabase
            .from('team')
            .select('id')
            .eq('id', teamId)
            .eq('workspace_id', workspaceId)
            .maybeSingle()
          if (!team) return badRequest('team_id not found in workspace')
        }
        updates.team_id = teamId
        updates.next_run_at = null
      } else {
        // Workspace-scoped triggers store team_id NULL.
        updates.team_id = null
        updates.next_run_at = nextRunAtOnWrite(nextType, tcfg, new Date())
      }
    } else if (body.enabled === true) {
      // Re-enabling: a schedule recomputes so a stale past-due next_run_at
      // doesn't make the tick fire it immediately; a calendar flow's slot is
      // nulled for the tick's re-anchor pass (nextRunAtOnEnable).
      const nextRun = nextRunAtOnEnable(currentType, existing.trigger_config, new Date())
      if (nextRun !== undefined) updates.next_run_at = nextRun
    }
  }

  // actions: full replacement of the ordered list, with per-action token
  // merge by stable id. A token string rotates that action's token; null
  // clears it; an omitted token carries forward the existing ciphertext for
  // the action with the same id. This requires stable ids to round-trip.
  if (body.actions !== undefined) {
    const validated = validateActions(body.actions)
    if (validated instanceof Error) return badRequest(validated.message)

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

    // Load existing actions so we can preserve unrotated tokens.
    const { data: existing } = await supabase
      .from('flow')
      .select('actions')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!existing) return notFound('Flow not found')
    const existingActions = Array.isArray(existing.actions)
      ? (existing.actions as Array<Record<string, unknown>>)
      : []
    const existingTokenById = new Map<string, string | null>()
    for (const a of existingActions) {
      if (typeof a.id === 'string') {
        existingTokenById.set(
          a.id,
          typeof a.bearer_token_encrypted === 'string' ? a.bearer_token_encrypted : null,
        )
      }
    }

    const rawActions = body.actions as Array<Record<string, unknown>>
    const merged: FlowAction[] = validated.map((a, i) => {
      const raw = rawActions[i] ?? {}
      let token: string | null
      if (Object.prototype.hasOwnProperty.call(raw, 'bearer_token')) {
        // Explicit rotate (string) or clear (null).
        token = typeof raw.bearer_token === 'string'
          ? encryptCredentialOrNull(raw.bearer_token)
          : null
      } else {
        // Omitted — carry forward existing token matched by id.
        token = existingTokenById.get(a.id) ?? null
      }
      return { ...a, bearer_token_encrypted: token }
    })
    updates.actions = merged
  }

  // The trigger/action cross-check (archive_capture needs a capture trigger),
  // shared with chat's update_flow: the EFFECTIVE trigger against the
  // EFFECTIVE actions, whichever side this write changes. A write that touches
  // neither (a rename, on/off, positions) is never refused for it.
  if (body.actions !== undefined || touchesTrigger) {
    let effectiveType = updates.trigger_type as string | undefined
    let effectiveActions = updates.actions as Array<{ type?: unknown }> | undefined
    if (effectiveType === undefined || effectiveActions === undefined) {
      const { data: row } = await supabase
        .from('flow')
        .select('trigger_type, actions')
        .eq('id', id)
        .eq('workspace_id', workspaceId)
        .maybeSingle()
      if (!row) return notFound('Flow not found')
      effectiveType ??= row.trigger_type as string
      effectiveActions ??= Array.isArray(row.actions) ? (row.actions as Array<{ type?: unknown }>) : []
    }
    const mismatch = findTriggerActionMismatch(effectiveType, effectiveActions)
    if (mismatch) return badRequest(`action ${mismatch.index + 1}: ${mismatch.message}`)
    // A lens skill only after a call; the marketing lens only for owners and admins (F3).
    // The loop runs as its OWNER (F1: fixed at creation), so it's the owner's
    // role that decides, whoever is saving it.
    const { data: ownerRow } = await supabase.from('flow').select('created_by').eq('id', id).eq('workspace_id', workspaceId).maybeSingle()
    const ownerId = ((ownerRow as { created_by?: string | null } | null)?.created_by as string | null) ?? user.id
    const lensRefusal = await lensStepRefusal(supabase, { workspaceId, userId: ownerId, triggerType: effectiveType, actions: effectiveActions as FlowAction[] })
    if (lensRefusal) return badRequest(`action ${lensRefusal.index + 1}: ${lensRefusal.message}`)
  }

  // canvas_layout: UI-only node positions. Sanitized to a safe shape; never
  // affects matching or the runner.
  if (body.canvas_layout !== undefined) {
    updates.canvas_layout = validateCanvasLayout(body.canvas_layout)
  }

  // The owner is fixed (F1, the same rule as chat's update_flow): dispatch
  // fires run AS created_by (usage, tool identity, document authorship), so
  // nobody's save re-stamps it, and only the owner changes WHAT runs (steps)
  // or WHEN (trigger) — otherwise member B could make A's loop read A's data
  // or bill A's plan. A non-owner may rename it, change its agent and switch
  // it off; "Take over this flow" (POST ./takeover) asks the owner for it.
  // The editor always sends the trigger and steps, so this compares them with
  // what is stored, normalized the same way (flow-approvals.ts).
  const { data: owned } = await supabase
    .from('flow')
    .select('created_by, enabled, team_id, trigger_type, trigger_config, actions')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!owned) return notFound('Flow not found')
  const ownerId = (owned.created_by as string | null) ?? null
  const isOwner = ownerId === user.id
  const storedActions = (Array.isArray(owned.actions) ? owned.actions : []) as FlowAction[]
  const effectiveActions = (updates.actions as FlowAction[] | undefined) ?? storedActions
  if (!isOwner) {
    let triggerChanged = false
    if (touchesTrigger) {
      const storedTrigger = validateTriggerConfig(owned.trigger_type as string, owned.trigger_config)
      triggerChanged =
        updates.trigger_type !== owned.trigger_type ||
        canonicalJson(updates.trigger_config) !== canonicalJson(storedTrigger instanceof Error ? owned.trigger_config : storedTrigger) ||
        (updates.team_id !== undefined && updates.team_id !== owned.team_id)
    }
    const tokenTouched =
      Array.isArray(body.actions) && (body.actions as Array<Record<string, unknown>>).some((a) => a && Object.prototype.hasOwnProperty.call(a, 'bearer_token'))
    const stepEdit = body.actions !== undefined ? classifyStepEdit(storedActions, effectiveActions, tokenTouched) : 'none'
    if (triggerChanged || stepEdit !== 'none') {
      return apiError(
        'Only this flow’s owner can change its trigger or steps: it runs as them, with their data and connections. Use “Take over this flow” to ask them for it.',
        { status: 403, code: 'NOT_FLOW_OWNER' },
      )
    }
  }
  // A chat loop's channel must be one its OWNER can read (it runs as them).
  if (touchesTrigger && typeof updates.trigger_type === 'string') {
    const channelProblem = await chatTriggerChannelProblem(getServiceClient(), {
      workspaceId,
      ownerUserId: ownerId ?? user.id,
      triggerType: updates.trigger_type,
      config: updates.trigger_config,
    })
    if (channelProblem) return badRequest(channelProblem)
  }
  // F4: a call_tool's connection, tool and input, and a skill step's
  // connections, are the loop owner's own.
  if (body.actions !== undefined) {
    const connectorProblem = await findCallToolProblems(getServiceClient(), ownerId, effectiveActions)
    if (connectorProblem) return badRequest(`action ${connectorProblem.index + 1}: ${connectorProblem.message}`, { field: connectorProblem.field })
  }
  // A non-owner can't switch a RISKY loop on alone (F1): it is saved off and
  // the owner gets the switch-on card (raised below through update_flow).
  const ownerCard = !isOwner && body.enabled === true && owned.enabled !== true && isRiskyFlow(effectiveActions)
  if (ownerCard) updates.enabled = false

  // Its bot. Resolved last, after every other check, so a refused write never
  // leaves a work bot behind.
  const botChoice = parseFlowBotInput(body as Record<string, unknown>)
  if (botChoice instanceof Error) return badRequest(botChoice.message, { field: 'ai_team_member_id' })
  let madeBotId: string | null = null
  let previousBotId: string | null = null
  const service = botChoice ? getServiceClient() : null
  if (botChoice && service) {
    const { data: current } = await supabase
      .from('flow')
      .select('name, team_id, seed_key, created_by, ai_team_member_id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!current) return notFound('Flow not found')
    previousBotId = (current.ai_team_member_id as string | null) ?? null
    // The run-as member after this write: a work bot's team must suit them too
    // (the trigger checks it), and only an action or trigger change re-stamps it.
    const runAsUserId = await runAsUserFor(service, {
      workspaceId,
      createdBy: (updates.created_by as string | undefined) ?? (current.created_by as string | null),
    })
    const bot = await resolveFlowBotChoice(service, {
      workspaceId,
      userId: user.id,
      choice: botChoice,
      flowTeamId: (updates.team_id as string | null | undefined) ?? (current.team_id as string | null),
      seedKey: (current.seed_key as string | null) ?? null,
      runAsUserId,
    })
    if ('error' in bot) {
      return bot.status === 400 ? badRequest(bot.error, { field: 'ai_team_member_id' }) : serverError(bot.error)
    }
    updates.ai_team_member_id = bot.teammateId
    if (bot.created) madeBotId = bot.teammateId
  }

  if (Object.keys(updates).length === 0) return badRequest('No fields to update')

  const { data, error } = await supabase
    .from('flow')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select(FLOW_FIELDS)
    .single()

  if (error || !data) {
    // Don't leave a work bot made for a change that never landed.
    if (madeBotId && service) await service.from('ai_team_member').delete().eq('id', madeBotId)
    const refusal = flowBotRefusal(error)
    return refusal ? badRequest(refusal, { field: 'ai_team_member_id' }) : serverError(error?.message ?? 'Update failed')
  }

  // The work bot this loop no longer names: gone when nothing else needs it.
  if (service && previousBotId && previousBotId !== updates.ai_team_member_id) {
    await retireWorkBotIfUnused(service, { workspaceId, teammateId: previousBotId })
  }

  // The owner's switch-on card for a risky loop a non-owner switched on: the
  // same card chat raises (update_flow: the click is the person's yes).
  if (ownerCard) {
    const tools = createFlowTools(user.id, getServiceClient(), workspaceId)
    const raised = (await tools.update_flow.execute!(
      { flow_id: id, enabled: true, confirmed_with_user: true } as never,
      { toolCallId: `flow-patch-${id}`, messages: [] } as never,
    )) as { awaiting_approval?: boolean; card_for?: string; owner?: { name?: string | null } }
    return NextResponse.json({
      flow: toPublicFlow(data as Record<string, unknown>),
      awaiting_owner: raised.awaiting_approval ? (raised.card_for ?? raised.owner?.name ?? 'the owner') : null,
    })
  }

  return NextResponse.json({ flow: toPublicFlow(data as Record<string, unknown>) })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const { data: deleted, error } = await supabase
    .from('flow')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('ai_team_member_id')

  if (error) return serverError(error.message)
  // Its work bot goes with it when nothing else needs it (retireWorkBotIfUnused).
  const botId = ((deleted ?? []) as Array<{ ai_team_member_id: string | null }>)[0]?.ai_team_member_id ?? null
  if (botId) await retireWorkBotIfUnused(getServiceClient(), { workspaceId, teammateId: botId })
  return NextResponse.json({ ok: true })
}
