import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { handleListBookings } from '@/lib/booking-links/bookings-api'

/**
 * /api/account/link-bookings — the caller's own booking-link bookings
 * (Settings › Availability › Bookings): ?view=upcoming|past|cancelled&q=&link=&offset=.
 * Only bookings they organize or attend (src/lib/booking-links/bookings.ts).
 */
export async function GET(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  return handleListBookings(
    request,
    { workspaceId: auth.workspaceId, userId: auth.user.id },
    { supabase: getServiceClient() },
  )
}
