/**
 * POST /api/local-agent/messages/[id]/ack — the Mac delivered a message (or couldn't).
 *
 * Body: {ok, error?}. Sets delivered, or failed with the error. Idempotent.
 * Returns {changed, status}.
 */
import { NextResponse } from 'next/server'
import { badRequest } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { ackMessage } from '@/lib/local-agent/device'
import { errorResponse, readJsonBody, requireLocalAgentUser } from '@/lib/local-agent/http'
import { crossSiteRefusal } from '@/lib/security/same-origin'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const crossSite = crossSiteRefusal(request)
  if (crossSite) return crossSite
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  const { id } = await ctx.params
  const body = await readJsonBody(request)
  if (body instanceof Response) return body
  if (typeof body.ok !== 'boolean') return badRequest('ok must be a boolean')
  try {
    const result = await ackMessage(getServiceClient(), auth.user.id, id, {
      ok: body.ok,
      error: typeof body.error === 'string' ? body.error : null,
    })
    return NextResponse.json(result)
  } catch (err) {
    return errorResponse(err, 'message ack')
  }
}
