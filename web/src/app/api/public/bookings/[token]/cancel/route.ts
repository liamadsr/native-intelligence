import { getServiceClient } from '@/lib/supabase/service'
import { handleCancelBooking } from '@/lib/time-offers/public'

export const dynamic = 'force-dynamic'

/**
 * POST /api/public/bookings/<token>/cancel: the guest cancels their booked
 * meeting (availability phase 3a): the calendar event is deleted with the
 * attendees told, and the host's time is free again. Public: outside the
 * proxy's matcher. See src/lib/time-offers/public.ts.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return handleCancelBooking(token, { supabase: getServiceClient() })
}
