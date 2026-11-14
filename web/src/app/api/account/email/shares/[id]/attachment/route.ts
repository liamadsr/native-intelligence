/**
 * GET /api/account/email/shares/[id]/attachment?message=<id>&key=<key>
 * (migration 646): one attachment of one of a share's frozen messages,
 * streamed from the owner's mailbox and never written anywhere (no cache, no
 * storage). Checked as every share read is (src/lib/email-share/service.ts):
 * the caller may read the share's channel and it is not revoked; the message
 * is one the share froze; the key is one the mailbox lists on that message
 * now. A forged key, another message's, or a message outside the share: 404.
 * Always a download (never drawn on our origin), never sniffed.
 */
import type { NextRequest } from 'next/server'
import { defaultEmailShareDeps, readSharedAttachment } from '@/lib/email-share/service'
import { contentDisposition, downloadType, isShareFailure, shareCaller, shareFailure } from '@/lib/email-share/http'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const { id } = await params
  const messageId = request.nextUrl.searchParams.get('message') ?? ''
  const key = request.nextUrl.searchParams.get('key') ?? ''
  try {
    const file = await readSharedAttachment(defaultEmailShareDeps(), caller, id, messageId, key)
    if (isShareFailure(file)) return shareFailure(file)
    const headers: Record<string, string> = {
      'Content-Type': downloadType(file.mimeType),
      'Content-Disposition': contentDisposition(file.name),
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    }
    if (file.size !== null && file.body instanceof Uint8Array) headers['Content-Length'] = String(file.body.byteLength)
    console.info(`[email-share] attachment share=${id}`)
    return new Response(file.body as BodyInit, { status: 200, headers })
  } catch (err) {
    console.error(`[email-share] attachment share=${id} failed:`, err instanceof Error ? err.name : 'unknown')
    return shareFailure({ ok: false, status: 500, code: 'failed', error: "Couldn't download that file" })
  }
}
