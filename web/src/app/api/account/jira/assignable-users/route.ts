import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { searchAssignableUsers } from '@/lib/integrations/jira-api'
import { jiraErrorResponse, requireJiraToken } from '@/lib/tasks/jira-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/jira/assignable-users?cloudId=&projectKey=&query=
 *
 * The compose panel's assignee picker. Scoped by PROJECT KEY rather than id
 * because `/user/assignable/search` takes the key — the one Jira endpoint in
 * this integration that does, which is why the key is carried in the destination
 * config and in the override shape alongside the id.
 *
 * `query` is optional: absent means "everyone assignable here", which is what
 * the picker shows before the user types.
 *
 * IDENTITY IS `accountId`, ALWAYS. `emailAddress` is nullable per each
 * Atlassian user's privacy setting while accountId is always populated, so email
 * is returned for display disambiguation only and every consumer must tolerate
 * null. Never key a selection on it.
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
  const projectKey = params.get('projectKey')?.trim()
  if (!projectKey) {
    return badRequest('`projectKey` query param required (a Jira project key like ENG)')
  }
  const query = params.get('query')?.trim()

  const resolved = await requireJiraToken(workspaceId)
  if (resolved instanceof Response) return resolved

  try {
    const users = await searchAssignableUsers(resolved.token, cloudId, projectKey, {
      ...(query ? { query } : {}),
    })
    return NextResponse.json({
      users: users.map((u) => ({
        account_id: u.accountId!,
        // displayName is what Jira's own pickers render and is always present;
        // the accountId fallback keeps a nameless row selectable rather than
        // blank.
        display_name: u.displayName ?? u.accountId!,
        email: u.emailAddress ?? null,
        active: u.active !== false,
      })),
    })
  } catch (err) {
    return jiraErrorResponse(err, 'list assignable Jira users')
  }
}
