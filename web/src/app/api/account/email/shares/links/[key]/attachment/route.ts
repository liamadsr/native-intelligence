/**
 * GET /api/account/email/shares/links/[key]/attachment?message=<id>&part=<key>
 * (migration 646): one attachment of one of a share link's frozen messages,
 * for the link's page, with the page's own checks
 * (src/lib/email-share/service.ts readLinkAttachment): the owner from their
 * mailbox; a teammate through a share from this link in a chat they can read;
 * in the LINK's workspace, whichever one their session has active. Anyone
 * else: 404. Streamed from the mailbox, never written anywhere; always a
 * download, never sniffed. Device tokens are refused; the token is never
 * logged.
 */
import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { defaultEmailShareDeps, readLinkAttachment } from '@/lib/email-share/service'
import { contentDisposition, downloadType, isShareFailure, refuseBearer, shareError, shareFailure } from '@/lib/email-share/http'

type Params = { params: Promise<{ key: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const refused = refuseBearer(request)
  if (refused) return refused
  const { key: token } = await params
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const messageId = request.nextUrl.searchParams.get('message') ?? ''
  const part = request.nextUrl.searchParams.get('part') ?? ''
  try {
    const file = await readLinkAttachment(defaultEmailShareDeps(), { supabase: auth.supabase, userId: auth.user.id }, token, messageId, part)
    if (isShareFailure(file)) return shareFailure(file)
    const headers: Record<string, string> = {
      'Content-Type': downloadType(file.mimeType),
      'Content-Disposition': contentDisposition(file.name),
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Referrer-Policy': 'no-referrer',
    }
    if (file.body instanceof Uint8Array) headers['Content-Length'] = String(file.body.byteLength)
    return new Response(file.body as BodyInit, { status: 200, headers })
  } catch (err) {
    return shareError(err, 'link attachment', "Couldn't download that file")
  }
}
