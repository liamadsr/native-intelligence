/**
 * POST { workspace_id }: the Join button on /join/team. Joins a workspace
 * that lists the caller's verified email domain, as `member` (never more),
 * with the shared member setup (joined_via 'domain') and the workspace
 * cookie. Refused when the address isn't verified, the workspace no longer
 * lists the domain, or the person left or was removed from it.
 *
 * requireUser, not requireWorkspace: the person is not in this workspace yet.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { joinByDomain } from '@/lib/workspace-join/domain-offer'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  let workspaceId: unknown
  try {
    workspaceId = ((await request.json()) as { workspace_id?: unknown })?.workspace_id
  } catch {
    return badRequest('Invalid JSON')
  }
  if (typeof workspaceId !== 'string' || !UUID.test(workspaceId)) return badRequest('workspace_id is required')

  const result = await joinByDomain(getServiceClient(), user, workspaceId)
  if (!result.ok) {
    return apiError(result.message, { status: result.status, code: result.status === 403 ? 'FORBIDDEN' : 'INTERNAL' })
  }
  return NextResponse.json({
    workspace_id: result.workspaceId,
    ...(result.alreadyMember ? { already_member: true } : {}),
  })
}
