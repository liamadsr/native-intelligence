/**
 * POST /api/internal/capture-feed/sessions/[id]/audio/stored { producer, take }
 * → { outcome, expiresAt } the producer's upload of that take is done
 * (src/lib/capture-feed/contract.ts; migration 650). 'stored' once Storage
 * has the object (650 reads Storage's own row): the producer may delete its
 * copy. 'missing': upload it again (ask for a new grant first).
 *
 * Server only: the feed's secret. 503 when the database can't be written.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { notFound } from '@/lib/api-errors'
import { isUuid } from '@/lib/team-chat/types'
import { AudioStoredSchema } from '@/lib/capture-feed/contract'
import { feedRequest, feedRetryLater } from '@/lib/capture-feed/route'
import { audioStored } from '@/lib/capture-feed/audio'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function POST(request: Request, { params }: Params) {
  const body = await feedRequest(request, AudioStoredSchema)
  if (body instanceof Response) return body
  const { id } = await params
  if (!isUuid(id)) return notFound()
  const session = id.toLowerCase()
  try {
    const stored = await audioStored(getServiceClient(), session, body.producer, body.take)
    console.info(`[capture-feed] session=${session} take=${body.take} audio_stored=${stored.outcome}`)
    return NextResponse.json(stored)
  } catch (err) {
    console.error(`[capture-feed] session=${session} audio stored failed:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown')
    return feedRetryLater()
  }
}
