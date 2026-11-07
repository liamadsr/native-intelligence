import { requireWorkspaceMember } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/supabase/service'
import { ignoreLink } from '@/lib/agent-links/store'
import { linkRefusal } from '@/lib/agent-links/refusals'

/** POST → { ok: true }: the person asked says no. The requester sees only that it wasn't accepted. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  const result = await ignoreLink(getServiceClient(), { linkId: id, userId: auth.user.id })
  if (!result.ok) return linkRefusal(result.reason)
  return Response.json({ ok: true })
}
