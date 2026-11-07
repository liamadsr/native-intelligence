/**
 * POST /api/local-agent/sessions/[id]/messages — the person messages a local agent.
 *
 * Body: {text, policy?: 'steer' | 'queue', requestId?} (default queue; a
 * retried requestId returns the first message). Inserts the
 * message and its `inbound` transcript event and rings the doorbell; an
 * interrupted session goes back to queued and resumes (`requeued: true`).
 * Returns {messageId, requeued}; 409 when the session ended.
 */
import { NextResponse } from 'next/server'
import { badRequest } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { errorResponse, readJsonBody, requireLocalAgentUser } from '@/lib/local-agent/http'
import { crossSiteRefusal } from '@/lib/security/same-origin'
import { addMessage } from '@/lib/local-agent/store'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const crossSite = crossSiteRefusal(request)
  if (crossSite) return crossSite
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  const { id } = await ctx.params
  const body = await readJsonBody(request)
  if (body instanceof Response) return body
  // A retried send (the same requestId) returns the first message.
  const requestId = body.requestId
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(requestId))) {
    return badRequest('requestId must be a short id')
  }
  try {
    const result = await addMessage(getServiceClient(), {
      userId: auth.user.id,
      sessionId: id,
      author: 'person',
      text: body.text as string,
      policy: body.policy === undefined ? 'queue' : (body.policy as 'steer' | 'queue'),
      ...(requestId ? { idempotencyKey: `person:${requestId}` } : {}),
    })
    return NextResponse.json(result)
  } catch (err) {
    return errorResponse(err, 'message')
  }
}
