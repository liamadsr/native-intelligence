/**
 * PATCH /api/account/workspace/agent-autonomy/teammates/[id] — a teammate's
 * role, autonomy and what it may change on its own, from Settings → Autonomy
 * (plan Part 5 row 9) and the one agent editor (bots-v4 B1, decision 12).
 *
 * Body: `{ role?: WorkRole | null, autonomy?: 'off' | 'propose' | 'attempt',
 * allowed_side_effects?: ['read'] | ['read', 'internal-write'] }`.
 * Owner/admin only. These columns decide what work a teammate is handed and
 * what it may do on its own, which is a workspace policy, so the team-scoped
 * ai-members route (where a team lead may edit) does not take them.
 *
 * `allowed_side_effects` is the editor's choice (decision 12): "Read only" or
 * "Read, and change Native Intelligence records" (internal writes, what Attempt mode
 * grants), exactly one of the two (parseBounds). Sending, publishing and every
 * other outside write is never set here. It bounds the bot in its chat, its
 * main-chat conversations and its unattended work (narrowToTeammate); a run a
 * person starts keeps that person's profile.
 *
 * 'attempt' means "may make a first pass on its own", which needs drafting:
 * setting it adds 'internal-write' to the teammate's classes when missing
 * (mayAttempt, role-routing.ts). Choosing "Read only" for a teammate set to
 * attempt is allowed: Settings shows it as "Set to attempt, but may not write
 * drafts", and the editor says so before you save.
 *
 * System teammates (the loops) hold no role and are not routable: 409
 * SYSTEM_TEAMMATE, as the ai-members routes answer; a work bot is 409 WORK_BOT
 * (it reads and proposes, whatever is asked). The write goes through the
 * session client, so ai_team_member's own RLS (admins and team leads) holds too.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { AGENT_AUTONOMY_MODES, type AgentAutonomyMode } from '@/lib/work/agent-autonomy-policy'
import { isWorkRole, type WorkRole } from '@/lib/work/roles'
import { parseBounds } from '@/lib/agents/editable-fields'

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth
  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace admins can change a teammate’s role or autonomy')
  }

  let body: { role?: unknown; autonomy?: unknown; allowed_side_effects?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return badRequest('Invalid JSON body')
  }
  const update: { role?: WorkRole | null; autonomy?: AgentAutonomyMode; allowed_side_effects?: string[] } = {}
  if (body.role !== undefined) {
    if (body.role !== null && !isWorkRole(body.role)) return badRequest('role must be a work role or null')
    update.role = body.role
  }
  if (body.autonomy !== undefined) {
    if (typeof body.autonomy !== 'string' || !(AGENT_AUTONOMY_MODES as readonly string[]).includes(body.autonomy)) {
      return badRequest(`autonomy must be one of ${AGENT_AUTONOMY_MODES.join(', ')}`)
    }
    update.autonomy = body.autonomy as AgentAutonomyMode
  }
  if (body.allowed_side_effects !== undefined) {
    const classes = parseBounds(body.allowed_side_effects)
    if (!classes) {
      return badRequest('allowed_side_effects must be ["read"] or ["read", "internal-write"]: outside writes are never set here', {
        field: 'allowed_side_effects',
      })
    }
    update.allowed_side_effects = classes
  }
  if (update.role === undefined && update.autonomy === undefined && update.allowed_side_effects === undefined) {
    return badRequest('Nothing to change')
  }

  const { data: row, error: readErr } = await supabase
    .from('ai_team_member')
    .select('id, is_system, fronts_only, allowed_side_effects')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (readErr) return serverError(readErr.message)
  if (!row) return notFound('Teammate not found')
  const current = row as { id: string; is_system: boolean; fronts_only?: boolean | null; allowed_side_effects: string[] | null }
  if (current.is_system) {
    return apiError('System teammates have no role or autonomy to set', { status: 409, code: 'SYSTEM_TEAMMATE' })
  }
  // A work bot (bots-v3 Phase 3) speaks for loops and takes no work: no role
  // (its CHECK refuses one), nothing for autonomy to gate, and its limits stay
  // read and propose (a custom agent's work bot too: bots-v4 decision 12).
  if (current.fronts_only === true) {
    return apiError('This agent has no role, autonomy or limits to set: it reads and proposes changes for you to approve', {
      status: 409,
      code: 'WORK_BOT',
    })
  }
  if (update.autonomy === 'attempt') {
    const classes = update.allowed_side_effects ?? (Array.isArray(current.allowed_side_effects) ? current.allowed_side_effects : [])
    if (!classes.includes('internal-write')) update.allowed_side_effects = [...classes, 'internal-write']
  }

  const { data: updated, error: writeErr } = await supabase
    .from('ai_team_member')
    .update(update)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id, name, role, autonomy, allowed_side_effects')
  if (writeErr) return serverError(writeErr.message)
  if (!updated || updated.length === 0) return notFound('Teammate not found')
  return NextResponse.json({ teammate: updated[0] })
}
