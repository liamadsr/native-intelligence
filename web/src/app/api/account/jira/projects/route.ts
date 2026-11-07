import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { searchProjects } from '@/lib/integrations/jira-api'
import { jiraErrorResponse, requireJiraToken } from '@/lib/tasks/jira-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/jira/projects?cloudId=<id>&query=<optional>
 *
 * Server-side proxy for the destination picker's project step.
 *
 * ONE endpoint for both browse and search, unlike the Asana sibling's
 * list/typeahead split: `GET /project/search` matches on project NAME OR KEY and
 * returns the plain first page when `query` is omitted, so search-as-you-type
 * and "show me something before I type" are the same call.
 *
 * Paging past the first page is deliberately not exposed: typing is the intended
 * way to reach a project deep in the list.
 *
 * A 401 from Jira surfaces as 400 `reconnect_required`.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const params = new URL(request.url).searchParams
  const cloudId = params.get('cloudId')?.trim()
  if (!cloudId) {
    return badRequest('`cloudId` query param required (an Atlassian site id)')
  }
  // A whitespace-only query is NO query, not an empty one: `query=` on the
  // Jira URL is a different request from omitting it, and the browse case is
  // what the picker wants when the search box is blank.
  const query = params.get('query')?.trim() || undefined

  const resolved = await requireJiraToken(workspaceId)
  if (resolved instanceof Response) return resolved

  try {
    const { projects } = await searchProjects(resolved.token, cloudId, { query })
    return NextResponse.json({
      projects: projects.map((p) => ({ id: p.id, key: p.key, name: p.name ?? p.key })),
    })
  } catch (err) {
    return jiraErrorResponse(err, 'list Jira projects')
  }
}
