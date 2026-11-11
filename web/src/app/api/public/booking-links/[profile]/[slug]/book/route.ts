import { getServiceClient } from '@/lib/supabase/service'
import { handleBookLink } from '@/lib/booking-links/public'

export const dynamic = 'force-dynamic'

/**
 * POST /api/public/booking-links/<profile>/<slug>/book: a guest books a time
 * on a booking link (availability phase 4a). Body: { start, name, email?,
 * phone?, answers?, note?, time_zone?, website (honeypot) }. Public: outside
 * the proxy's matcher. See src/lib/booking-links/public.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ profile: string; slug: string }> }) {
  const { profile, slug } = await params
  return handleBookLink(request, profile, slug, { supabase: getServiceClient() })
}
