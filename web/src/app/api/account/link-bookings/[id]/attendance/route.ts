import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { handleMarkAttendance } from '@/lib/booking-links/bookings-api'

/** /api/account/link-bookings/<id>/attendance — PATCH { attendance: 'attended' | 'no_show' | null } on a started, confirmed booking of the caller's. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { id } = await params
  return handleMarkAttendance(
    request,
    id,
    { workspaceId: auth.workspaceId, userId: auth.user.id },
    { supabase: getServiceClient() },
  )
}
