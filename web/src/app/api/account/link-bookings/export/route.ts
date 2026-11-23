import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { handleExport } from '@/lib/booking-links/bookings-api'

/** /api/account/link-bookings/export — the insights range's bookings (the caller's own) as CSV. */
export async function GET(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  return handleExport(
    request,
    { workspaceId: auth.workspaceId, userId: auth.user.id },
    { supabase: getServiceClient() },
  )
}
