import { getServiceClient } from '@/lib/supabase/service'
import { handleGetOffer } from '@/lib/time-offers/public'

export const dynamic = 'force-dynamic'

/**
 * GET /api/public/time-offers/<token>: a time offer's page data (availability
 * phase 3a): the host's name, the title, the times still open, the expiry and
 * the offer's state. Public: outside the proxy's matcher. Two indexed reads,
 * no calendar call. See src/lib/time-offers/public.ts.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return handleGetOffer(token, { supabase: getServiceClient() })
}
