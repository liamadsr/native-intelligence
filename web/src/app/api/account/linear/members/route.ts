import { requireWorkspaceMember } from '@/lib/api-auth'
import { listAssignableUsers } from '@/lib/integrations/linear-api'
import { linearErrorResponse, requireLinearToken } from '@/lib/tasks/linear-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/linear/members?teamId=<optional>&query=<optional>
 *
 * The compose panel's assignee picker. BOTH params are optional and the pair
 * selects one of three query shapes inside listAssignableUsers — see its
 * docblock for why a typed query goes workspace-wide while a bare open goes
 * through `Team.members`.
 *
 * `teamId` is optional rather than required because the panel opens before a
 * team is necessarily chosen (the config may already name one, or the user may
 * be mid-change), and an empty picker at that moment is worse than a
 * workspace-wide one.
 *
 * Guests and app/bot actors are filtered out in the transport, not here:
 * Linear's `UserFilter` carries no comparator for either, so the filter is
 * client-side by necessity and belongs next to the query that made it necessary.
 *
 * A rejected token surfaces as 400 `reconnect_required`.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const params = new URL(request.url).searchParams
  const teamId = params.get('teamId')?.trim()
  const query = params.get('query')?.trim()

  const resolved = await requireLinearToken(workspaceId)
  if (resolved instanceof Response) return resolved

  try {
    const users = await listAssignableUsers(resolved.token, {
      ...(teamId ? { teamId } : {}),
      ...(query ? { query } : {}),
    })
    return NextResponse.json({
      members: users.map((u) => ({
        id: u.id,
        // displayName is the nickname Linear's own UI shows; `name` is the full
        // name and is the better fallback when a workspace doesn't use nicknames.
        name: u.displayName ?? u.name ?? u.id,
        full_name: u.name ?? null,
        email: u.email ?? null,
        avatar_url: u.avatarUrl ?? null,
      })),
    })
  } catch (err) {
    return linearErrorResponse(err, 'list Linear members')
  }
}
