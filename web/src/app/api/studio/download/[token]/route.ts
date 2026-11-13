/**
 * /api/studio/download/<token>: a finished Studio export, downloaded through a short-lived link the person asked for
 * (POST /api/account/studio/jobs/<id>/link). It needs no session, so it lives outside /api/account (whose proxy wants
 * one): the desktop app opens it in the person's own browser, which may not be signed in. The token is the check
 * (src/lib/studio/server/download-links.ts).
 */
import { getServiceClient } from '@/lib/admin'
import { serveDownloadLink } from '@/lib/studio/server/download-links'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type Params = { params: Promise<{ token: string }> }

async function handle(request: Request, { params }: Params): Promise<Response> {
  return serveDownloadLink(getServiceClient(), (await params).token, request)
}

export { handle as GET, handle as HEAD }
