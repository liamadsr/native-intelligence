import { getServiceClient } from '@/lib/admin'
import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest, forbidden, notMember, serverError } from '@/lib/api-errors'
import { WORKSPACE_COOKIE, getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { requestTeamCallEjections } from '@/lib/team-calls/eject'

/**
 * POST /api/account/workspace/leave
 *
 * Removes the current user from a workspace. The target workspace is taken
 * from the request body (`workspace_id`) so the profile page can leave any
 * workspace the user belongs to, not just the active one. Membership is
 * verified server-side against that specific workspace, and only the caller's
 * own member row is ever deleted.
 *
 * Only non-owner members may call this — owners must transfer ownership first,
 * or delete the workspace.
 *
 * The delete runs on the SERVICE client. RLS lets only an owner delete a
 * member row (`member_delete`: get_member_role(workspace_id) = 'owner'), and
 * only a non-owner may leave, so on the caller's session the delete matched
 * nothing and Leave answered ok while the user stayed a member. The policy is
 * not widened: this route checks what it needs (the caller's own row, in this
 * workspace, not an owner's) and the delete is pinned to exactly that row, a
 * non-owner one, so a promotion racing the click is never deleted. Nothing
 * deleted is an error, never ok.
 *
 * What a member's departure takes with it is the schema's, the same as when an
 * owner removes them (migration 320): their own rows go (team_member, cards,
 * the work ledger, notifications, pending invites they sent), and what they
 * wrote stays. Their comments keep the name and avatar they had; their
 * document drafts are kept for their user and are theirs again if they rejoin.
 * Who created, owns or applied a record (an action's assignee, a document's
 * author, who applied a suggestion…) is set null. Their MCP tokens stop
 * reaching the workspace at the next request (lib/mcp/auth.ts re-checks
 * membership).
 *
 * If the user leaves their currently-active workspace, the workspace cookie is
 * cleared so the session falls through to the next available workspace (or the
 * empty state if there are none).
 */
export async function POST(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const body = await request.json().catch(() => ({}))
  const workspaceId =
    body && typeof body.workspace_id === 'string' ? body.workspace_id : null
  if (!workspaceId) return badRequest('workspace_id is required')

  // Resolve the caller's OWN membership in THIS workspace — never anyone else's.
  const { data: member, error: readError } = await supabase
    .from('member')
    .select('id, role')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle<{ id: string; role: string | null }>()

  if (readError) return serverError(readError.message)
  if (!member) return notMember()

  if (member.role === 'owner') {
    return forbidden(
      'Owners cannot leave a workspace — transfer ownership first, or delete the workspace',
    )
  }

  const { data: deleted, error } = await getServiceClient()
    .from('member')
    .delete()
    .eq('id', member.id)
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .neq('role', 'owner')
    .select('id')

  if (error) return serverError(error.message)
  if (!deleted || deleted.length === 0) {
    return apiError("You weren't removed from this workspace. Reload the page and try again.", {
      status: 409,
      code: 'NOT_LEFT',
    })
  }

  // Out of any call of the workspace now (the database queued it; this drains it at once).
  await requestTeamCallEjections()

  // If the user left their active workspace, clear the cookie so the next
  // request resolves a different workspace (or the empty state if none remain).
  const activeWorkspaceId = await getCurrentWorkspaceId()
  if (activeWorkspaceId === workspaceId) {
    const cookieStore = await cookies()
    cookieStore.delete(WORKSPACE_COOKIE)
  }

  return NextResponse.json({ ok: true })
}
