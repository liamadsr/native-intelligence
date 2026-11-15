import { findFormByLink, formReadDeps } from '@/lib/forms/deps'
import { handleFormRead } from '@/lib/forms/public'
import { formCorsHeaders } from '@/lib/forms/submit'
import { getServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/**
 * GET /api/intake/forms/<key>/challenge: a fresh bot-check challenge for an
 * open form, `{ token, difficulty }` (src/lib/forms/challenge.ts). It writes
 * nothing and costs one HMAC, so it takes no ledger entry; a members or
 * invited form answers only someone who may submit to it, as its POST does.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  return handleFormRead(request, key, 'challenge', formReadDeps(getServiceClient()))
}

/** The browser's CORS preflight, as the form's own. */
export async function OPTIONS(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const found = await findFormByLink(getServiceClient(), key).catch(() => null)
  return new Response(null, { status: found ? 204 : 404, headers: formCorsHeaders(request.headers.get('origin'), found) })
}
