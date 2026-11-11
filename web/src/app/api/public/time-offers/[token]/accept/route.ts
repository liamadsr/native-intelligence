import { getServiceClient } from '@/lib/supabase/service'
import { handleAcceptOffer } from '@/lib/time-offers/public'

export const dynamic = 'force-dynamic'

/**
 * POST /api/public/time-offers/<token>/accept: the guest picks one of the
 * offered times (availability phase 3a). Body: { start, name, email?, note?,
 * time_zone?, website (honeypot) }. Public: outside the proxy's matcher. See
 * src/lib/time-offers/public.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return handleAcceptOffer(request, token, { supabase: getServiceClient() })
}
