/**
 * POST /api/internal/capture-feed/sessions/[id]/audio
 *   { producer, take, offsetMs, durationMs, bytes, contentType }
 * → { outcome, upload, expiresAt } a producer asks to upload one take of the
 * session's sound (src/lib/capture-feed/contract.ts; migration 650).
 * 'granted' with a one-time upload to the path the database chose; anything
 * else means drop the file ('stored': it is in already). While the source's
 * audio switch is off (TEAM_CALL_AUDIO for a call) every ask is
 * 'not_wanted', so a file made before the switch went off is dropped too.
 *
 * Server only: the feed's secret. 503 when the database or Storage can't be
 * written (ask again).
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { AudioGrantSchema } from '@/lib/capture-feed/contract'
import { feedRequest, feedRetryLater } from '@/lib/capture-feed/route'
import { CAPTURE_FEED_SOURCES } from '@/lib/capture-feed/sources'
import { grantAudio } from '@/lib/capture-feed/audio'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const body = await feedRequest(request, AudioGrantSchema)
  if (body instanceof Response) return body
  const { id } = await params
  if (!isUuid(id)) return notFound()
  const session = id.toLowerCase()
  // Only one source kind today; a second one with its own switch is checked by its session's kind in 650.
  if (!Object.values(CAPTURE_FEED_SOURCES).some((source) => source.audio())) {
    console.info(`[capture-feed] session=${session} take=${body.take} audio=not_wanted (switch off)`)
    return NextResponse.json({ outcome: 'not_wanted', upload: null, expiresAt: null })
  }
  try {
    const granted = await grantAudio(getServiceClient(), session, body.producer, body)
    console.info(`[capture-feed] session=${session} take=${body.take} audio=${granted.outcome} bytes=${body.bytes} duration_ms=${body.durationMs}`)
    return NextResponse.json(granted)
  } catch (err) {
    console.error(`[capture-feed] session=${session} audio grant failed:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown')
    return feedRetryLater()
  }
}
