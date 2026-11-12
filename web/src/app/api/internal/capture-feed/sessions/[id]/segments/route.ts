/**
 * POST /api/internal/capture-feed/sessions/[id]/segments { producer, segments }
 * → { outcome, accepted, duplicate, dropped, transcriptLength } final
 * segments into the session's capture (src/lib/capture-feed/contract.ts).
 * Each key is taken once (a retry's repeats are duplicates); a segment said
 * after the session ended, by a speaker the roster has not named, or by a
 * meeting guest who has not said go to this round's notes is dropped. What
 * is taken is appended to the capture's transcript in the order it was said,
 * then the feed's hook runs (src/lib/capture-feed/hooks.ts: phase 2's live
 * turns attach there).
 *
 * Server only: the feed's secret. 404 for no such session; 409 once the
 * capture is locked (stop sending); 503 when the database can't take it
 * (send the same batch again).
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { apiError, notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { SegmentsSchema } from '@/lib/capture-feed/contract'
import { afterFeedAppended } from '@/lib/capture-feed/hooks'
import { feedRequest, feedRetryLater } from '@/lib/capture-feed/route'
import { appendSegments } from '@/lib/capture-feed/store'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const body = await feedRequest(request, SegmentsSchema)
  if (body instanceof Response) return body
  const { id } = await params
  if (!isUuid(id)) return notFound()
  const sessionId = id.toLowerCase()
  const svc = getServiceClient()
  let result: Awaited<ReturnType<typeof appendSegments>>
  try {
    result = await appendSegments(svc, sessionId, body.producer, body.segments)
  } catch (err) {
    console.error(`[capture-feed] session=${sessionId} append failed:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown')
    return feedRetryLater()
  }
  console.info(
    `[capture-feed] session=${sessionId} outcome=${result.outcome} accepted=${result.accepted} duplicate=${result.duplicate} dropped=${result.dropped}`,
  )
  if (result.outcome === 'unknown') return notFound('No such session')
  if (result.outcome === 'taken') return apiError('This session is another producer’s', { status: 409, code: 'FEED_TAKEN' })
  if (result.outcome === 'locked') return apiError('The capture is finished', { status: 409, code: 'FEED_LOCKED' })
  if (result.captureId) await afterFeedAppended(svc, { sessionId, captureId: result.captureId, accepted: result.accepted, transcriptLength: result.transcriptLength })
  return NextResponse.json(result)
}
