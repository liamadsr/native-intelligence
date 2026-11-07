import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { dedupeProjectStatuses, listProjectStatuses } from '@/lib/integrations/jira-api'
import { jiraErrorResponse, requireJiraToken } from '@/lib/tasks/jira-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/jira/statuses?cloudId=<id>&projectId=<id>
 *
 * Server-side proxy for the destination picker's LAST step: the statuses a
 * project's workflows can reach, which the user maps to the four lifecycle
 * buckets. The Jira counterpart of Asana's section list.
 *
 * `GET /project/{id}/statuses` returns statuses grouped BY ISSUE TYPE, because
 * in a company-managed project each issue type may carry its own workflow. The
 * mapping UI wants ONE flat list, so the groups are folded and de-duplicated by
 * status id (first-seen order, which is the first issue type's workflow order —
 * far more useful for a mapping UI than alphabetical).
 *
 * `category` (the statusCategory key: new / indeterminate / done) rides along
 * because it is the STABLE, non-localizable enum the echo falls back to when a
 * bucket has no explicit mapping — so the UI can show what will happen by
 * default rather than making the user guess.
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
    const groups = await listProjectStatuses(resolved.token, cloudId, projectId)
    return NextResponse.json({ statuses: dedupeProjectStatuses(groups) })
  } catch (err) {
    return jiraErrorResponse(err, 'list Jira statuses')
  }
}
