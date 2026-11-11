import { getServiceClient } from '@/lib/supabase/service'
import { handleBookingTimes } from '@/lib/time-offers/public'

export const dynamic = 'force-dynamic'

/**
 * GET /api/public/bookings/<token>/times: the host's open times the guest's
 * meeting can move to, the same length, over the next 14 days (availability
 * phase 3a). Reads the host's calendar (kept a minute per booking). Public:
 * outside the proxy's matcher. See src/lib/time-offers/public.ts.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return handleBookingTimes(token, { supabase: getServiceClient() })
}
