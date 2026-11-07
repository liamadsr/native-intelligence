import { requireWorkspaceMember } from '@/lib/api-auth'
import { listAccessibleResources } from '@/lib/integrations/jira-api'
import { jiraErrorResponse, requireJiraToken } from '@/lib/tasks/jira-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/jira/sites
 *
 * Server-side proxy for the destination picker's FIRST step: every Atlassian
 * site the connected account authorized.
 *
 * This is the one Jira read that has no cloudId, because it is how a cloudId is
 * discovered — `GET /oauth/token/accessible-resources` is account-scoped and
 * every later call is built from the `id` it returns. An Atlassian account can
 * hold several sites, so the user picks; we never assume 1:1.
 *
 * `url` is returned for display and for building `/browse/KEY` permalinks only.
 * Atlassian's guidance is that `id` is the API identity, and a site can be
 * renamed out from under a stored url.
 *
 * The token never leaves the server. A 401 from Jira surfaces as 400
 * `reconnect_required`.
 */
export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const resolved = await requireJiraToken(workspaceId)
  if (resolved instanceof Response) return resolved

  try {
    const sites = await listAccessibleResources(resolved.token)
    return NextResponse.json({
      sites: sites.map((s) => ({ id: s.id, name: s.name ?? null, url: s.url ?? null })),
    })
  } catch (err) {
    return jiraErrorResponse(err, 'list Jira sites')
  }
}
