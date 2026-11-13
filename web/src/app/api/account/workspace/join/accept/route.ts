/**
 * POST { token }: join a workspace through its shareable link (/join/<token>).
 *
 * The signed-in person becomes a `member` (never more) with the same setup
 * an accepted invite gets (src/lib/workspace-join/add-member.ts), and the
 * workspace becomes their active one. Someone already in it just lands
 * there. A link that is off, reset or unknown answers 410 LINK_CLOSED.
 *
 * requireUser, not requireWorkspace: the person is not in this workspace yet
 * (and the target is the link's, never the cookie's).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { joinWorkspace } from '@/lib/workspace-join/add-member'
import { findOpenJoinLink } from '@/lib/workspace-join/settings'
import { JOIN_LINK_CLOSED_MESSAGE, isJoinTokenShape } from '@/lib/workspace-join/token'

export async function POST(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  let token: unknown
  try {
    token = ((await request.json()) as { token?: unknown })?.token
  } catch {
    return badRequest('Invalid JSON')
  }
  if (!isJoinTokenShape(token)) return linkClosed()

  const service = getServiceClient()
  const link = await findOpenJoinLink(service, token)
  if (!link) return linkClosed()

  const result = await joinWorkspace({
    service,
    user,
    workspaceId: link.workspaceId,
    role: 'member',
    via: 'link',
    activate: 'always',
  })
  if (!result.ok) {
    console.error('[workspace-join] link join failed:', result.error)
    return serverError('Could not join the workspace')
  }
  return NextResponse.json({
    workspace_id: link.workspaceId,
    ...(result.alreadyMember ? { already_member: true } : {}),
  })
}

function linkClosed() {
  return apiError(JOIN_LINK_CLOSED_MESSAGE, { status: 410, code: 'LINK_CLOSED' })
}
