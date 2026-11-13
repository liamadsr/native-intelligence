/**
 * POST /api/internal/capture-feed/start { source: { kind, ref }, producer }
 * → { outcome, session } a producer begins a source's feed, or takes it up
 * again (src/lib/capture-feed/contract.ts). The session is the source's
 * current round's, made once; its capture is the source's one capture, made
 * the first time. 'busy': another producer heartbeats it; 'not_wanted': the
 * source wants no feed now (a call ended, its notes off), or this server
 * takes none of its kind.
 *
 * After the answer, the source's own follow-up (a meeting's call capture
 * takes its calendar event: src/lib/capture-feed/sources.ts).
 *
 * Server only: the feed's secret (src/lib/capture-feed/auth.ts). 404 while
 * the feed is off here; 503 when the database can't be written (send it
 * again).
 */
import { NextResponse, after } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { StartSchema } from '@/lib/capture-feed/contract'
import { feedRequest, feedRetryLater } from '@/lib/capture-feed/route'
import { CAPTURE_FEED_SOURCES } from '@/lib/capture-feed/sources'
import { startFeed } from '@/lib/capture-feed/store'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const body = await feedRequest(request, StartSchema)
  if (body instanceof Response) return body
  const source = CAPTURE_FEED_SOURCES[body.source.kind]
  if (!source.enabled()) return NextResponse.json({ outcome: 'not_wanted', session: null })
  try {
    const svc = getServiceClient()
    const title = await source.title(svc, body.source.ref)
    const started = await startFeed(svc, { source: body.source, producer: body.producer, title })
    console.info(`[capture-feed] source=${body.source.kind}:${body.source.ref} producer=${body.producer.id} outcome=${started.outcome} session=${started.session?.id ?? '-'}`)
    const captureId = started.session?.captureId
    if (captureId && source.afterStart) {
      const work = () => source.afterStart!(svc, captureId).catch(() => undefined)
      // After the answer: the producer waits on it before it hears anyone.
      try {
        after(work)
      } catch {
        void work()
      }
    }
    return NextResponse.json(started)
  } catch (err) {
    console.error(`[capture-feed] source=${body.source.kind}:${body.source.ref} start failed:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown')
    return feedRetryLater()
  }
}
