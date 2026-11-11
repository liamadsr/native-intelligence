import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { handleSetHosts } from '@/lib/booking-links/account'
import { appOrigin } from '@/lib/twilio/config'

/**
 * PUT /api/account/booking-links/<id>/hosts { hosts: [user id, …], host_mode? } → { link }:
 * a booking link's hosts, in order (availability phase 4a). Hosts are
 * members; one who doesn't share their availability can only add themselves.
 */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { id } = await params
  return handleSetHosts(request, id, { workspaceId: auth.workspaceId, userId: auth.user.id }, { supabase: getServiceClient(), origin: appOrigin() })
}
