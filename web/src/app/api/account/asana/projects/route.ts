import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { listProjects, typeaheadProjects } from '@/lib/integrations/asana-api'
import { asanaErrorResponse, requireAsanaToken } from '@/lib/tasks/asana-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/asana/projects?workspace=<gid>&query=<optional>
 *
 * Server-side proxy for the destination picker's project step.
 *
 * With `query` → Asana's TYPEAHEAD, which is recency-ordered per user and
 * returns a single page: the right shape for search-as-you-type (the project
 * you touched an hour ago beats the alphabetically-first one). Without it →
 * the first page of the plain project list, so the picker has something to show
 * before the user types. Paging past that first page is deliberately not
 * exposed: typing is the intended way to reach a project deep in the list.
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
    const projects = query
      ? await typeaheadProjects(resolved.token, asanaWorkspaceGid, query)
      : (await listProjects(resolved.token, asanaWorkspaceGid)).projects

    return NextResponse.json({
      projects: projects.map((p) => ({ gid: p.gid, name: p.name })),
    })
  } catch (err) {
    return asanaErrorResponse(err, 'list Asana projects')
  }
}
