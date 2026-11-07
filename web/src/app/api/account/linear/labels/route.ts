import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { listTeamLabels } from '@/lib/integrations/linear-api'
import { linearErrorResponse, requireLinearToken } from '@/lib/tasks/linear-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/linear/labels?teamId=<id>
 *
 * The compose panel's label multiselect. Returns the team's own labels AND the
 * workspace-level ones in one list, because that is how Linear models them: a
 * label's `team` is nullable and a null one is available everywhere. There is no
 * second call to make.
 *
 * GROUP LABELS ARE EXCLUDED — a group ("Type", "Area") is a container whose
 * children are the applicable labels, and its own id in `labelIds` is rejected.
 * The exclusion lives in the transport so no caller can forget it; each returned
 * label carries `scope` so the panel can still show which are shared.
 *
 * `teamId` is REQUIRED here (unlike the members route, where it is optional):
 * label scope is a fact about a team, and a workspace-wide label list would
 * offer labels that cannot be applied to the issue being composed.
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
    const labels = await listTeamLabels(resolved.token, teamId)
    return NextResponse.json({
      labels: labels.map((label) => ({
        id: label.id,
        name: label.name ?? label.id,
        color: label.color ?? null,
        // 'workspace' = usable on every team (Linear's null-team label);
        // 'team' = scoped to the one being composed against.
        scope: label.team?.id ? 'team' : 'workspace',
      })),
    })
  } catch (err) {
    return linearErrorResponse(err, 'list Linear labels')
  }
}
