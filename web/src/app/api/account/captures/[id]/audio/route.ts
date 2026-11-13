/**
 * GET /api/account/captures/[id]/audio
 *   → { files: [{ id, part, state, durationMs, expiresAt, deletedAt }] } the
 *     capture's sound files (migration 650; a call heard by the recorder),
 *     for someone who may read the capture: its own RLS decides, read as
 *     them. 'ready' plays, and says the day it will be deleted; 'deleted'
 *     says the day it was; 'saving' while it is on its way. 404 for anyone
 *     who may not read the capture.
 * GET /api/account/captures/[id]/audio?file=<id>&as=play|download
 *   → { url, expiresIn } a link to one kept file, signed as them (Storage's
 *     read policy checks them again), lasting an hour; `as=download` names
 *     the file so the browser saves it. 404 when it is not kept (any more).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { isUuid } from '@/lib/team-chat/types'
import { CAPTURE_AUDIO_LINK_TTL_SECONDS, captureAudioFor, captureAudioLink } from '@/lib/capture-feed/audio'

export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  const captureId = id.toLowerCase()
  const file = request.nextUrl.searchParams.get('file')
  try {
    if (file !== null) {
      if (!isUuid(file)) return notFound()
      const as = request.nextUrl.searchParams.get('as') === 'download' ? 'download' : 'play'
      const url = await captureAudioLink(auth.supabase, getServiceClient(), captureId, file.toLowerCase(), as)
      if (!url) return notFound()
      return NextResponse.json({ url, expiresIn: CAPTURE_AUDIO_LINK_TTL_SECONDS })
    }
    const files = await captureAudioFor(auth.supabase, getServiceClient(), captureId)
    if (!files) return notFound()
    return NextResponse.json({ files })
  } catch (err) {
    console.error(`[capture-audio] capture=${captureId} read failed:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown')
    return serverError('The call audio could not be read')
  }
}
