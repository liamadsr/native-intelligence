import { getServiceClient } from '@/lib/supabase/service'
import { handleRescheduleBooking } from '@/lib/time-offers/public'

export const dynamic = 'force-dynamic'

/**
 * POST /api/public/bookings/<token>/reschedule: the guest moves their meeting
 * to one of its open times (availability phase 3a). Body: { start }. The
 * calendar event moves with the attendees told; at most 3 moves. Public:
 * outside the proxy's matcher. See src/lib/time-offers/public.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return handleRescheduleBooking(request, token, { supabase: getServiceClient() })
}
