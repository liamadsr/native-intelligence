import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { listCreateMetaIssueTypes } from '@/lib/integrations/jira-api'
import { jiraErrorResponse, requireJiraToken } from '@/lib/tasks/jira-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/jira/issue-types?cloudId=<id>&projectId=<id>
 *
 * Server-side proxy for the destination picker's issue-type step — the one with
 * no Asana analogue at all, and the reason a Jira destination is a triple rather
 * than a pair: `POST /issue` cannot be built without an issue type.
 *
 * Resolved PER PROJECT, never cached across projects: in team-managed projects
 * the issue types are project-local copies, so "Task" in one project is a
 * different id from "Task" in the next.
 *
 * SUBTASKS ARE FILTERED OUT. A subtask create requires a `parent` and can never
 * be a top-level push target, so offering one would produce a destination whose
 * every push fails.
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
  const projectId = params.get('projectId')?.trim()
  if (!projectId) {
    return badRequest('`projectId` query param required (a Jira project id)')
  }

  const resolved = await requireJiraToken(workspaceId)
  if (resolved instanceof Response) return resolved

  try {
    const issueTypes = await listCreateMetaIssueTypes(resolved.token, cloudId, projectId)
    return NextResponse.json({
      issueTypes: issueTypes
        .filter((t) => t.subtask !== true)
        .map((t) => ({ id: t.id, name: t.name ?? t.id })),
    })
  } catch (err) {
    return jiraErrorResponse(err, 'list Jira issue types')
  }
}
