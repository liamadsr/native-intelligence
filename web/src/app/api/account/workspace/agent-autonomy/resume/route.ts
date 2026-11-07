/**
 * POST /api/account/workspace/agent-autonomy/resume — "Resume role" (plan Part 5
 * row 9): the manual reset of a role's circuit breaker.
 *
 * Body `{ role, workspace_id }`. Writes `agent_autonomy.role_breaker_resumed_at[role]
 * = now`, so the breaker counts only the role's attempts after this moment
 * (role-breaker.ts): a paused role attempts again on its next item. Owner/admin
 * only, like every autonomy write.
 *
 * `workspace_id` must be the workspace the request resolves to. The Agents
 * page spans workspaces and names the row's workspace in `x-workspace-id`, and
 * the resolver falls back to the caller's first membership when that header
 * names a workspace they are not in, so without this check a stale header
 * could resume a role in the wrong workspace.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { writeAgentAutonomyPolicy } from '@/lib/work/agent-autonomy-settings'
import { ATTEMPTABLE_WORK_ROLES, isWorkRole } from '@/lib/work/roles'

export async function POST(request: NextRequest): Promise<Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { workspaceId, member } = auth
  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace admins can resume a role')
  }

  let body: { role?: unknown; workspace_id?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (!isWorkRole(body.role) || !ATTEMPTABLE_WORK_ROLES.includes(body.role)) {
    return badRequest(`role must be one of ${ATTEMPTABLE_WORK_ROLES.join(', ')}`)
  }
  if (body.workspace_id !== workspaceId) {
    return apiError('workspace_id does not match the workspace this request is for', {
      status: 400,
      code: 'WORKSPACE_MISMATCH',
    })
  }
  const role = body.role

  const resumedAt = new Date().toISOString()
  const written = await writeAgentAutonomyPolicy(getServiceClient(), workspaceId, (current) => ({
    ...current,
    role_breaker_resumed_at: { ...current.role_breaker_resumed_at, [role]: resumedAt },
  }))
  if ('error' in written) return serverError(written.error)
  return NextResponse.json({ role, resumed_at: resumedAt })
}
