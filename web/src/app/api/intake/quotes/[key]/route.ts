import { getServiceClient } from '@/lib/supabase/service'
import { countWebQuotesSince, findIntakeKey, touchIntakeKey } from '@/lib/customers/intake-key'
import { corsHeaders, handleQuoteIntake } from '@/lib/customers/intake-handler'
import { receiveQuote, supabaseReceiveQuoteDeps } from '@/lib/customers/receive'
import { businessOwnerUserId } from '@/lib/customers/store'
import { takeIntakeTest } from '@/lib/website/intake-test'

export const dynamic = 'force-dynamic'

/**
 * POST /api/intake/quotes/<key>: a business website's quote form (roadmap
 * B1). Public: the key is the authentication. See
 * src/lib/customers/intake-handler.ts for the order of checks.
 */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const supabase = getServiceClient()
  return handleQuoteIntake(request, key, {
    findKey: (k) => findIntakeKey(supabase, k),
    // Whoever made the key hears its quotes, unless the business names its owner.
    ownerOf: async (k) => (await businessOwnerUserId(supabase, k.workspaceId)) ?? k.createdBy,
    countSince: (workspaceId, sinceIso) => countWebQuotesSince(supabase, workspaceId, sinceIso),
    receive: (args, quote) => receiveQuote(args, quote, supabaseReceiveQuoteDeps(supabase)),
    touchKey: (keyId) => touchIntakeKey(supabase, keyId),
    takeTest: (workspaceId, nonce) => takeIntakeTest(supabase, workspaceId, nonce),
  })
}

/** The browser's CORS preflight: allowed for a live key's listed origins (or any, when none are listed). */
export async function OPTIONS(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const origin = request.headers.get('origin')
  const found = await findIntakeKey(getServiceClient(), key).catch(() => null)
  return new Response(null, { status: found ? 204 : 404, headers: corsHeaders(origin, found) })
}
