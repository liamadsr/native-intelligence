import { findFormByLink, formReadDeps, formSubmitDeps } from '@/lib/forms/deps'
import { handleFormRead } from '@/lib/forms/public'
import { formCorsHeaders, handleFormSubmit } from '@/lib/forms/submit'
import { getServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

/**
 * POST /api/intake/forms/<key>: a submission to a form (forms phases 1 and
 * 3). Public: the key (or a personal link's secret) opens the form, and all
 * it can do is add one row through the form's own fields. See
 * src/lib/forms/submit.ts for the order of checks.
 */
export async function POST(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  return handleFormSubmit(request, key, formSubmitDeps(getServiceClient()))
}

/**
 * GET /api/intake/forms/<key>: what a page needs to draw the form, and
 * nothing of the workspace (src/lib/forms/public.ts). A members or invited
 * form answers only someone who may submit to it.
 */
export async function GET(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  return handleFormRead(request, key, 'shape', formReadDeps(getServiceClient()))
}

/** The browser's CORS preflight: allowed for a public form's listed origins (or any, when none are listed). */
export async function OPTIONS(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params
  const found = await findFormByLink(getServiceClient(), key).catch(() => null)
  return new Response(null, { status: found ? 204 : 404, headers: formCorsHeaders(request.headers.get('origin'), found) })
}
