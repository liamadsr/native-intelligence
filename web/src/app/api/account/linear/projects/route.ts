import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { listTeamProjects } from '@/lib/integrations/linear-api'
import { linearErrorResponse, requireLinearToken } from '@/lib/tasks/linear-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/linear/projects?teamId=<id>
 *
 * Server-side proxy for the destination picker's OPTIONAL project step.
 *
 * Optional is the operative word and the structural difference from the Jira
 * sibling: a Linear issue belongs to a TEAM and may have no project at all, so
 * this refines a destination that is already complete rather than completing it.
 * The picker offers a "no project" choice and the push omits `projectId`.
 *
 * Scoped THROUGH the chosen team, since a project the team can't see is not a
 * legal destination for its issues.
 *
 * A rejected token surfaces as 400 `reconnect_required`.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const teamId = new URL(request.url).searchParams.get('teamId')?.trim()
  if (!teamId) {
    return badRequest('`teamId` query param required (a Linear team id)')
  }

  const resolved = await requireLinearToken(workspaceId)
  if (resolved instanceof Response) return resolved

  try {
    const projects = await listTeamProjects(resolved.token, teamId)
    return NextResponse.json({
      projects: projects.map((p) => ({ id: p.id, name: p.name ?? p.id })),
    })
  } catch (err) {
    return linearErrorResponse(err, 'list Linear projects')
  }
}
