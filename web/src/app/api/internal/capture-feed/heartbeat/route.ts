/**
 * POST /api/internal/capture-feed/heartbeat { producer, sessions }
 * → { sessions: [{ id, keep, reason }] } the producer is running these
 * (src/lib/capture-feed/contract.ts). keep: go on (and a session the sweeper
 * had marked lost is live again); keep false: stop, after delivering what it
 * still holds (`reason`: the notes went off, the call ended, the 3-hour bound,
 * or the session is not this producer's).
 *
 * Server only: the feed's secret. 503 when the database can't be written.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { HeartbeatSchema } from '@/lib/capture-feed/contract'
import { feedRequest, feedRetryLater } from '@/lib/capture-feed/route'
import { heartbeatFeeds } from '@/lib/capture-feed/store'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const body = await feedRequest(request, HeartbeatSchema)
  if (body instanceof Response) return body
  try {
    const sessions = await heartbeatFeeds(getServiceClient(), body.producer, body.sessions.map((s) => s.toLowerCase()))
    const stopped = sessions.filter((s) => !s.keep)
    if (stopped.length > 0) console.info(`[capture-feed] producer=${body.producer.id} stop=${stopped.map((s) => `${s.id}:${s.reason ?? '-'}`).join(',')}`)
    return NextResponse.json({ sessions })
  } catch (err) {
    console.error(`[capture-feed] producer=${body.producer.id} heartbeat failed:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown')
    return feedRetryLater()
  }
}
