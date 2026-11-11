import { getServiceClient } from '@/lib/supabase/service'
import { handleLegacySlug } from '@/lib/booking-links/public'
import { handleBookingLinkPost, supabaseBookingLinkDeps } from '@/lib/customers/booking-link'

export const dynamic = 'force-dynamic'

/**
 * GET /api/public/book/<slug>: an old booking address as the booking link it
 * is now (availability phase 4a): { profile, slug } of the business's job
 * link, for /book/<profile>/<slug>. See src/lib/booking-links/public.ts.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return handleLegacySlug(slug, { supabase: getServiceClient() })
}

/**
 * POST /api/public/book/<slug>: a customer asking for a slot on the
 * business's booking page (roadmap B4). Public: outside the proxy's matcher.
 * See src/lib/customers/booking-link.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return handleBookingLinkPost(request, slug, supabaseBookingLinkDeps(getServiceClient()))
}
