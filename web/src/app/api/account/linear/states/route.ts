import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { listTeamStates } from '@/lib/integrations/linear-api'
import { deriveLinearStateMap } from '@/lib/tasks/lifecycle'
import { linearErrorResponse, requireLinearToken } from '@/lib/tasks/linear-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/linear/states?teamId=<id>
 *
 * One team's workflow states, plus the bucket→state map they DERIVE to.
 *
 * There is no Jira-style bucket→status picker for Linear and this route is why:
 * `WorkflowState.type` is a stable 7-value enum, so the mapping is a fact about
 * the team rather than a preference, and the settings UI shows it read-only. The
 * derived map is returned alongside the raw states so the UI can render exactly
 * what a push would do — including the empty buckets, which is where the honest
 * warning lives ("this team has no canceled state, so canceled actions won't be
 * echoed").
 *
 * The derivation is EXPORTED FROM lifecycle.ts and re-run server-side by the
 * settings PATCH when a destination is saved, so what this route shows and what
 * gets persisted are the same function of the same input — never two
 * implementations that can drift.
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
    const states = await listTeamStates(resolved.token, teamId)
    return NextResponse.json({
      states: states.map((s) => ({
        id: s.id,
        name: s.name ?? s.id,
        type: s.type ?? null,
        position: typeof s.position === 'number' ? s.position : null,
      })),
      stateMap: deriveLinearStateMap(states),
    })
  } catch (err) {
    return linearErrorResponse(err, 'list Linear workflow states')
  }
}
