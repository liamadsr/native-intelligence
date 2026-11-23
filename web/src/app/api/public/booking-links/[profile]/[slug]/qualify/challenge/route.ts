import { getServiceClient } from '@/lib/supabase/service'
import { handleQualifyChallenge } from '@/lib/booking-links/form-gate'
import { liveLinkAt } from '@/lib/booking-links/public'

export const dynamic = 'force-dynamic'

/** GET /api/public/booking-links/<profile>/<slug>/qualify/challenge: the bot check of the form in front of a booking link. */
export async function GET(request: Request, { params }: { params: Promise<{ profile: string; slug: string }> }) {
  const { profile, slug } = await params
  const supabase = getServiceClient()
  return handleQualifyChallenge(request, profile, slug, { supabase, liveLink: (p, s) => liveLinkAt(supabase, p, s) })
}
