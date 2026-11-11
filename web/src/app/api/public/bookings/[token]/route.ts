import { getServiceClient } from '@/lib/supabase/service'
import { handleGetBooking } from '@/lib/time-offers/public'

export const dynamic = 'force-dynamic'

/**
 * GET /api/public/bookings/<token>: a booked meeting as its guest's manage
 * page reads it (availability phase 3a). Public: outside the proxy's matcher.
 * One indexed read. See src/lib/time-offers/public.ts.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return handleGetBooking(token, { supabase: getServiceClient() })
}
