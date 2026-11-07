import { getServiceClient } from '@/lib/supabase/service'
import { handleBookingLinkPost, supabaseBookingLinkDeps } from '@/lib/customers/booking-link'

export const dynamic = 'force-dynamic'

/**
 * POST /api/public/book/<slug>: a customer asking for a slot on the
 * business's booking page (roadmap B4). Public: outside the proxy's matcher.
 * See src/lib/customers/booking-link.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  return handleBookingLinkPost(request, slug, supabaseBookingLinkDeps(getServiceClient()))
}
