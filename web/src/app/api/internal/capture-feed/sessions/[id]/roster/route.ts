/**
 * POST /api/internal/capture-feed/sessions/[id]/roster { producer, events }
 * → { results: [{ key, outcome }] } who joined and left
 * (src/lib/capture-feed/contract.ts). A speaker key's first event says who
 * it is: a member of the workspace who may read the call's conversation, a
 * guest of this meeting, or an outside name (and email); anyone else is
 * refused. Each person is one participant row of the capture, with a label
 * unique in it (their name), and joined and left times; a member's row is
 * attested (the voice on that track is theirs), so their own commitments can
 * be filed as theirs.
 *
 * Server only: the feed's secret. 404 for no such session; 409 once the
 * capture is locked; 503 when the database can't be written.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { apiError, notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { RosterSchema } from '@/lib/capture-feed/contract'
import { feedRequest, feedRetryLater } from '@/lib/capture-feed/route'
import { applyRoster } from '@/lib/capture-feed/store'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const body = await feedRequest(request, RosterSchema)
  if (body instanceof Response) return body
  const { id } = await params
  if (!isUuid(id)) return notFound()
  const sessionId = id.toLowerCase()
  let results: Awaited<ReturnType<typeof applyRoster>>
  try {
    results = await applyRoster(getServiceClient(), sessionId, body.producer, body.events)
  } catch (err) {
    console.error(`[capture-feed] session=${sessionId} roster failed:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown')
    return feedRetryLater()
  }
  const counts = new Map<string, number>()
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1)
  console.info(`[capture-feed] session=${sessionId} roster ${[...counts].map(([k, n]) => `${k}=${n}`).join(' ')}`)
  if (results.length > 0 && results.every((r) => r.outcome === 'unknown')) return notFound('No such session')
  if (results.length > 0 && results.every((r) => r.outcome === 'taken')) return apiError('This session is another producer’s', { status: 409, code: 'FEED_TAKEN' })
  if (results.length > 0 && results.every((r) => r.outcome === 'locked')) return apiError('The capture is finished', { status: 409, code: 'FEED_LOCKED' })
  return NextResponse.json({ results })
}
