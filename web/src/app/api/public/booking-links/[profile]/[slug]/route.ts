import { getServiceClient } from '@/lib/supabase/service'
import { handleGetLink } from '@/lib/booking-links/public'

export const dynamic = 'force-dynamic'

/**
 * GET /api/public/booking-links/<profile>/<slug>: a booking link's page data
 * (availability phase 4a): title, description, length, hosts' names,
 * questions, zone, video or place, how the guest is reached. Public: outside
 * the proxy's matcher. See src/lib/booking-links/public.ts.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ profile: string; slug: string }> }) {
  const { profile, slug } = await params
  return handleGetLink(profile, slug, { supabase: getServiceClient() })
}
