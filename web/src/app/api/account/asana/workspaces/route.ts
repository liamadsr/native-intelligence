import { requireWorkspaceMember } from '@/lib/api-auth'
import { listWorkspaces } from '@/lib/integrations/asana-api'
import { asanaErrorResponse, requireAsanaToken } from '@/lib/tasks/asana-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/asana/workspaces
 *
 * Server-side proxy for the destination picker's first step: every Asana
 * workspace/organization the connected account can see. Uses the workspace's
 * connected Asana token (never the browser's — the token never leaves the
 * server). A 401 from Asana surfaces as 400 `reconnect_required`.
 */
export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const resolved = await requireAsanaToken(workspaceId)
  if (resolved instanceof Response) return resolved

  try {
    const workspaces = await listWorkspaces(resolved.token)
    return NextResponse.json({
      workspaces: workspaces.map((w) => ({ gid: w.gid, name: w.name })),
    })
  } catch (err) {
    return asanaErrorResponse(err, 'list Asana workspaces')
  }
}
