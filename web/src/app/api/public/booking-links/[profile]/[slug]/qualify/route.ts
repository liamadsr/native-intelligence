import { getServiceClient } from '@/lib/supabase/service'
import { handleQualify } from '@/lib/booking-links/form-gate'
import { liveLinkAt } from '@/lib/booking-links/public'

export const dynamic = 'force-dynamic'

/**
 * POST /api/public/booking-links/<profile>/<slug>/qualify: a guest's answers
 * to the form in front of a booking link (booking insights, phase 4). The
 * forms intake writes them to the form's table as its own page would; then
 * the link's rule says whether they go on to book (a pass) or not (a polite
 * line). Public: outside the proxy's matcher. See src/lib/booking-links/form-gate.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ profile: string; slug: string }> }) {
  const { profile, slug } = await params
  const supabase = getServiceClient()
  return handleQualify(request, profile, slug, { supabase, liveLink: (p, s) => liveLinkAt(supabase, p, s) })
}
