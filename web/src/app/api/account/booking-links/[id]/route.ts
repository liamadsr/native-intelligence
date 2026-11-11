import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { handleDeleteLink, handleGetLink, handlePatchLink } from '@/lib/booking-links/account'
import { appOrigin } from '@/lib/twilio/config'

/**
 * /api/account/booking-links/<id> — one booking link (availability phase 4a).
 *
 *   GET → { link }
 *   PATCH { …any field of POST /api/account/booking-links but team } → { link }
 *   DELETE → { link }: turned off (its page stops taking bookings; its bookings stay)
 *
 * Its owner, or the workspace's owner or an admin, edits it.
 */
type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { id } = await params
  return handleGetLink(id, { workspaceId: auth.workspaceId, userId: auth.user.id }, { supabase: getServiceClient(), origin: appOrigin() })
}

export async function PATCH(request: Request, { params }: Params) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { id } = await params
  return handlePatchLink(request, id, { workspaceId: auth.workspaceId, userId: auth.user.id }, { supabase: getServiceClient(), origin: appOrigin() })
}

export async function DELETE(_request: Request, { params }: Params) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { id } = await params
  return handleDeleteLink(id, { workspaceId: auth.workspaceId, userId: auth.user.id }, { supabase: getServiceClient(), origin: appOrigin() })
}
