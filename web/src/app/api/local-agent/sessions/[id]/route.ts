/**
 * GET /api/local-agent/sessions/[id]?afterId=… — the session (including its
 * lastDeviceSeq, for the relay's gap-fill) plus up to 500 events after
 * `afterId`, in id order. Returns {session, events:[{id, at, source, runId, seq, kind, payload}], lastId}.
 */
import { NextResponse } from 'next/server'
import { notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { errorResponse, requireLocalAgentUser } from '@/lib/local-agent/http'
import { readEvents } from '@/lib/local-agent/transcript'

export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  const { id } = await ctx.params
  const params = new URL(request.url).searchParams
  const afterId = Number(params.get('afterId') ?? 0)
  const limit = Number(params.get('limit') ?? 500)
  try {
    const page = await readEvents(getServiceClient(), auth.user.id, id, {
      afterId: Number.isFinite(afterId) ? afterId : 0,
      limit: Number.isFinite(limit) ? limit : 500,
    })
    if (!page) return notFound('Local agent not found')
    return NextResponse.json(page)
  } catch (err) {
    return errorResponse(err, 'read session')
  }
}
