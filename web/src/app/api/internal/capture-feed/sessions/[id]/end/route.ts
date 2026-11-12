/**
 * POST /api/internal/capture-feed/sessions/[id]/end { producer, reason? }
 * → { ended } the producer stopped feeding this session for good
 * (src/lib/capture-feed/contract.ts). A producer that is only restarting
 * says nothing: the session waits for it (and the sweeper marks it lost if
 * it is gone too long). Ending one already ended, or another producer's,
 * changes nothing.
 *
 * Server only: the feed's secret. 503 when the database can't be written.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { EndSchema } from '@/lib/capture-feed/contract'
import { feedRequest, feedRetryLater } from '@/lib/capture-feed/route'
import { endFeed } from '@/lib/capture-feed/store'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const body = await feedRequest(request, EndSchema)
  if (body instanceof Response) return body
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const ended = await endFeed(getServiceClient(), id.toLowerCase(), body.producer, body.reason)
    console.info(`[capture-feed] session=${id.toLowerCase()} producer=${body.producer.id} ended=${ended}`)
    return NextResponse.json({ ended })
  } catch (err) {
    console.error(`[capture-feed] session=${id.toLowerCase()} end failed:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown')
    return feedRetryLater()
  }
}
