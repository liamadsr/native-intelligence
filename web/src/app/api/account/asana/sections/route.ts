import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { listSections } from '@/lib/integrations/asana-api'
import { asanaErrorResponse, requireAsanaToken } from '@/lib/tasks/asana-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/asana/sections?project=<gid>
 *
 * Server-side proxy for the destination picker's last step: the chosen
 * project's sections (its board columns), which the user maps to the four
 * lifecycle buckets. A 401 from Asana surfaces as 400 `reconnect_required`.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const projectGid = new URL(request.url).searchParams.get('project')?.trim()
  if (!projectGid) {
    return badRequest('`project` query param required (an Asana project gid)')
  }

  const resolved = await requireAsanaToken(workspaceId)
  if (resolved instanceof Response) return resolved

  try {
    const sections = await listSections(resolved.token, projectGid)
    return NextResponse.json({
      sections: sections.map((s) => ({ gid: s.gid, name: s.name })),
    })
  } catch (err) {
    return asanaErrorResponse(err, 'list Asana sections')
  }
}
