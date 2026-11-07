/**
 * POST /api/account/workspace/merge/preflight
 *
 * The plan for merging another workspace (the source) into the current one
 * (the destination), read-only: blockers (a busy source, drift on either
 * side), who gains access to what, the per-team own/fold choice and what it
 * does to identifiers and states, labels, integrations, every collision,
 * per-table counts, and the plan to confirm. Body:
 *
 *   { source_workspace_id: uuid, destination_workspace_id: uuid, plan?: { teams: [...] } }
 *
 * `destination_workspace_id` is the workspace the dialog is open in; it must
 * be the one this request resolves to (a stale cookie or another tab's switch
 * would otherwise plan a merge into a different workspace). `plan` is
 * optional: the person's edited team choices from an earlier preflight;
 * omitted, the defaults are proposed (every team arrives as its own). The
 * route authenticates (a signed-in owner of both workspaces, never a device
 * token) and calls the `merge_workspace_preflight` RPC (migration 402) with
 * the SERVICE client, passing the actor: the RPC is granted to service_role
 * only, and its gate re-checks both memberships inside the transaction.
 */
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { gateMerge, refuseDeviceToken } from '@/lib/workspace-merge/auth'
import { mergeRpcErrorResponse } from '@/lib/workspace-merge/errors'
import { NextResponse } from 'next/server'

export async function POST(req: Request) {
  const device = refuseDeviceToken(req)
  if (device) return device
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { user, workspaceId: destinationWorkspaceId, member } = auth

  let body: { source_workspace_id?: unknown; destination_workspace_id?: unknown; plan?: unknown } | null = null
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (body?.plan !== undefined && (body.plan === null || typeof body.plan !== 'object' || Array.isArray(body.plan))) {
    return badRequest('plan must be an object')
  }

  const service = getServiceClient()
  const gate = await gateMerge({
    service,
    userId: user.id,
    destinationWorkspaceId,
    destinationRole: member.role,
    claimedDestinationId: body?.destination_workspace_id,
    sourceWorkspaceId: body?.source_workspace_id,
  })
  if (gate instanceof Response) return gate

  const { data, error } = await service.rpc('merge_workspace_preflight', {
    p_source: gate.sourceWorkspaceId,
    p_destination: destinationWorkspaceId,
    p_actor: user.id,
    p_plan: (body?.plan as Record<string, unknown> | undefined) ?? null,
  })
  if (error) return mergeRpcErrorResponse('merge_workspace_preflight', error)
  return NextResponse.json(data)
}
