/**
 * GET/PATCH /api/account/workspace/agent-autonomy — the settings surface for
 * agent autonomy (plan Part 5 row 9; follow-up §B.4 PR 5).
 *
 * GET (any member): the workspace's policy (`workspace.settings.agent_autonomy`,
 * normalised; attempts are on by default), whether the caller may edit, the teammates the caller can see (RLS: a private
 * team's stay hidden) with their role, autonomy and classes, and each role's
 * default teammate and breaker state.
 *
 * PATCH (owner/admin): `{ policy }`, any subset of the mode and the numbers.
 * The page writes the mode only as its kill switch: 'off', or back to
 * 'attempt'. Validated strictly (a bad number is a 400, never a silent
 * 'propose'), merged over the stored policy; the stored per-role resumes are
 * kept (Resume is its own route). Two transitions do more than store the blob:
 *   - into 'attempt' (switching back on from Off): the workspace's role
 *     teammates are created first, for every role no teammate holds yet
 *     (seed_role_teammates, migration 318). If that fails, the mode is not
 *     stored. A workspace that never left the default needs no seed here: the
 *     auto-attempt gate creates its role teammates on first need
 *     (ensureRoleTeammates, role-routing.ts).
 *   - into 'off': the kill switch's cancel fan-out (`workspace/autonomy.off`)
 *     stops the unattended runs already going: attempts, and delegations once
 *     they exist. A person's own runs are theirs to stop.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { requestWorkspaceAutonomyOff } from '@/lib/agent-run/cancel-workspace-runs'
import { resolveAgentAutonomyPolicyFromSettings } from '@/lib/work/agent-autonomy-policy'
import {
  AUTONOMY_OFF_ORIGINS,
  mergeAgentAutonomyPolicy,
  validateAgentAutonomyPatch,
  writeAgentAutonomyPolicy,
} from '@/lib/work/agent-autonomy-settings'
import { loadAgentRoster } from '@/lib/work/agent-roster'
import { ATTEMPTABLE_WORK_ROLES, WORK_ROLES } from '@/lib/work/roles'

const isManager = (role: string | undefined) => role === 'owner' || role === 'admin'

export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth

  const { data, error } = await supabase.from('workspace').select('settings').eq('id', workspaceId).maybeSingle()
  if (error) return serverError(error.message)
  const policy = resolveAgentAutonomyPolicyFromSettings((data as { settings?: unknown } | null)?.settings ?? {})

  const roster = await loadAgentRoster({
    session: supabase,
    service: getServiceClient(),
    workspaceIds: [workspaceId],
    now: new Date(),
  })
  if (roster.error) return serverError('Could not read the teammates')
  // System teammates and work bots (fronts_only) have no role or autonomy to set.
  const teammates = roster.roster.filter((m) => !m.is_system && !m.fronts_only)

  // Each role's default is its oldest holder (role-routing.ts); the roster is
  // oldest first. The breaker is the role's, carried on each holder.
  const roles = WORK_ROLES.map((role) => {
    const holders = teammates.filter((m) => m.role === role)
    return {
      role,
      attemptable: ATTEMPTABLE_WORK_ROLES.includes(role),
      default_teammate_id: holders[0]?.id ?? null,
      breaker: holders.find((m) => m.breaker)?.breaker ?? null,
      resumed_at: policy.role_breaker_resumed_at[role] ?? null,
    }
  })

  return NextResponse.json({
    workspace_id: workspaceId,
    policy,
    can_edit: isManager(member.role as string | undefined),
    teammates: teammates.map((m) => ({
      id: m.id,
      name: m.name,
      avatar_url: m.avatar_url,
      team_id: m.team_id,
      role: m.role,
      autonomy: m.autonomy,
      allowed_side_effects: m.allowed_side_effects,
    })),
    roles,
  })
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { user, workspaceId, member } = auth
  if (!isManager(member.role as string | undefined)) {
    return forbidden('Only workspace admins can change agent autonomy')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const valid = validateAgentAutonomyPatch((body as { policy?: unknown } | null)?.policy)
  if (!valid.ok) return badRequest(valid.error)

  const service = getServiceClient()

  // Seeding before the write: a workspace never sits at 'attempt' without the
  // chance to have its role teammates. Reading the stored mode first costs one
  // read; the write below re-reads inside writeAgentAutonomyPolicy.
  let seeded = 0
  if (valid.patch.mode === 'attempt') {
    const { data: ws, error: readErr } = await service.from('workspace').select('settings').eq('id', workspaceId).maybeSingle()
    if (readErr) return serverError(readErr.message)
    const stored = resolveAgentAutonomyPolicyFromSettings((ws as { settings?: unknown } | null)?.settings ?? {})
    if (stored.mode !== 'attempt') {
      const { data: count, error: seedErr } = await service.rpc('seed_role_teammates', {
        p_workspace_id: workspaceId,
        p_created_by: user.id,
      })
      if (seedErr) {
        console.error('[agent-autonomy] seeding role teammates failed:', workspaceId, seedErr.message)
        return serverError('Could not create the role teammates, so attempts were not switched on')
      }
      seeded = typeof count === 'number' ? count : 0
    }
  }

  const written = await writeAgentAutonomyPolicy(service, workspaceId, (current) =>
    mergeAgentAutonomyPolicy(current, valid.patch),
  )
  if ('error' in written) return serverError(written.error)

  // Into 'off': stop what is already running unattended. The mode is stored
  // either way; a failed send is reported so the page can say so.
  let stopped: 'requested' | 'failed' | null = null
  if (written.policy.mode === 'off' && written.previous.mode !== 'off') {
    try {
      await requestWorkspaceAutonomyOff({ workspaceId, origins: AUTONOMY_OFF_ORIGINS })
      stopped = 'requested'
    } catch (err) {
      console.error('[agent-autonomy] autonomy.off send failed:', workspaceId, err instanceof Error ? err.message : err)
      stopped = 'failed'
    }
  }

  return NextResponse.json({ policy: written.policy, seeded, stopped })
}
