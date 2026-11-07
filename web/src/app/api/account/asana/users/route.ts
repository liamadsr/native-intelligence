import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { listWorkspaceUsers, typeaheadUsers } from '@/lib/integrations/asana-api'
import { asanaErrorResponse, requireAsanaToken } from '@/lib/tasks/asana-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/asana/users?workspace=<gid>&query=<optional>
 *
 * The compose panel's assignee picker, with the same two-mode shape as the
 * projects picker next door and for the same reason — but the tradeoff here is
 * sharper and worth stating.
 *
 * With `query` → Asana's TYPEAHEAD, which its own docs describe as optimized for
 * speed over completeness. Good for filter-as-you-type, NOT authoritative: a
 * user it fails to surface still exists. Without `query` → the first page of the
 * real `/users` listing, which IS authoritative and is what the picker shows
 * before anyone types.
 *
 * IDENTITY IS THE `gid`. `email` must be requested explicitly (Asana returns the
 * compact form otherwise) and can still be null for guests or restricted-
 * visibility members, so it is display-only and every consumer tolerates null.
 *
 * A 401 from Asana surfaces as 400 `reconnect_required`.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const params = new URL(request.url).searchParams
  const asanaWorkspaceGid = params.get('workspace')?.trim()
  if (!asanaWorkspaceGid) {
    return badRequest('`workspace` query param required (an Asana workspace gid)')
  }
  const query = params.get('query')?.trim()

  const resolved = await requireAsanaToken(workspaceId)
  if (resolved instanceof Response) return resolved

  try {
    const users = query
      ? await typeaheadUsers(resolved.token, asanaWorkspaceGid, query)
      : (await listWorkspaceUsers(resolved.token, asanaWorkspaceGid)).users

    return NextResponse.json({
      users: users
        // A user with no gid cannot be assigned to anything, so it is dropped
        // rather than rendered as an unselectable row.
        .filter((u) => typeof u.gid === 'string' && u.gid.length > 0)
        .map((u) => ({ gid: u.gid, name: u.name ?? u.gid, email: u.email ?? null })),
    })
  } catch (err) {
    return asanaErrorResponse(err, 'list Asana users')
  }
}
