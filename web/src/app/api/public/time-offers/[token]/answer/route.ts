import { getServiceClient } from '@/lib/supabase/service'
import { handleAnswerPoll } from '@/lib/time-offers/public'

export const dynamic = 'force-dynamic'

/**
 * POST /api/public/time-offers/<token>/answer: a poll's guest marks every
 * time that works for them, or none (availability phase 5). Body: { works:
 * [start…], none?, note?, website (honeypot) }. Public: outside the proxy's
 * matcher. See src/lib/time-offers/public.ts.
 */
export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return handleAnswerPoll(request, token, { supabase: getServiceClient() })
}
