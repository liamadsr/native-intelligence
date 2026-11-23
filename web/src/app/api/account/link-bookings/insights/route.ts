import { getServiceClient } from '@/lib/admin'
import { requireWorkspace } from '@/lib/api-auth'
import { handleInsights } from '@/lib/booking-links/bookings-api'

/** /api/account/link-bookings/insights — ?days=7|30|90 or from=&to=, tz=, link=: the caller's own link bookings counted. */
export async function GET(request: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  return handleInsights(
    request,
    { workspaceId: auth.workspaceId, userId: auth.user.id },
    { supabase: getServiceClient() },
  )
}
