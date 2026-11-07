import { requireWorkspaceMember } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/supabase/service'
import { endLink } from '@/lib/agent-links/store'
import { linkRefusal } from '@/lib/agent-links/refusals'

/**
 * DELETE → { ok: true }: Disconnect (either person, on an active link) or
 * withdraw (the requester, on a request). Both halves lose "their agent";
 * open exchanges close.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  const result = await endLink(getServiceClient(), { linkId: id, userId: auth.user.id })
  if (!result.ok) return linkRefusal(result.reason)
  return Response.json({ ok: true })
}
