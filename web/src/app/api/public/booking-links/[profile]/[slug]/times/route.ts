import { getServiceClient } from '@/lib/supabase/service'
import { handleLinkTimes } from '@/lib/booking-links/public'

export const dynamic = 'force-dynamic'

/**
 * GET /api/public/booking-links/<profile>/<slug>/times?from=YYYY-MM-DD&days=7&tz=Zone:
 * a booking link's open times (availability phase 4a), as instants. 503
 * UNAVAILABLE when a host's calendar can't be read. Public: outside the
 * proxy's matcher. See src/lib/booking-links/public.ts.
 */
export async function GET(request: Request, { params }: { params: Promise<{ profile: string; slug: string }> }) {
  const { profile, slug } = await params
  return handleLinkTimes(request, profile, slug, { supabase: getServiceClient() })
}
