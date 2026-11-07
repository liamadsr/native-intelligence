import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { setOutsideLinksAllowed } from '@/lib/agent-links/outside'
import { outsideLinksAllowed } from '@/lib/agent-links/store'

/**
 * The workspace admin's switch for agent links outside the workspace
 * (decision 5; workspace.settings.outside_agent_links, on when missing).
 *
 * GET (any member)       → { allowed, canEdit }
 * PATCH (owner or admin) { allowed: boolean } → { allowed, ended }
 *   Off ends every outside link answering from, or asked from, this
 *   workspace, for both people; `ended` says how many. Links between members
 *   of the workspace aren't touched: those stay up to each member.
 */
const isManager = (role: unknown) => role === 'owner' || role === 'admin'

export async function GET() {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth
  const { data, error } = await supabase.from('workspace').select('settings').eq('id', workspaceId).maybeSingle()
  if (error) return serverError(error.message)
  return Response.json({
    allowed: outsideLinksAllowed((data as { settings?: unknown } | null)?.settings),
    canEdit: isManager(member.role),
  })
}

export async function PATCH(req: Request) {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { user, workspaceId, member } = auth
  if (!isManager(member.role)) return forbidden('Only workspace admins can change this')

  let body: { allowed?: unknown }
  try {
    body = (await req.json()) as { allowed?: unknown }
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (typeof body.allowed !== 'boolean') return badRequest('allowed must be true or false')

  const result = await setOutsideLinksAllowed(getServiceClient(), { workspaceId, allowed: body.allowed, byUserId: user.id })
  if ('error' in result) return serverError(result.error)
  return Response.json({ allowed: body.allowed, ended: result.ended })
}
