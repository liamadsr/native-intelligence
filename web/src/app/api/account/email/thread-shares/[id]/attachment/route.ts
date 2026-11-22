/**
 * GET /api/account/email/thread-shares/[id]/attachment?message=<id>&key=<key>
 * (migration 673): one attachment of one of a thread-share's frozen messages,
 * for the grantee the share names, or the owner. Streamed live from the
 * OWNER's mailbox with the owner's token and never written anywhere (no cache,
 * no storage). The query params are named as the channel share's attachment
 * route names them (`message`, `key`).
 *
 * Checked on the server, all required (member-share.ts
 * readSharedEmailAttachmentForMember): the share exists in the caller's
 * current workspace, is not revoked, and the caller is its grantee or its
 * owner; the message is one the share FROZE (exact id match, else 404); the
 * owner is still a member and their mailbox connects (else the "unavailable"
 * the thread read gives, 410); the key is one the message lists now (the
 * provider verifies it; never an arbitrary id on trust) and the file is under
 * the share cap. Anything else: 404 (never 403). Bearer/agent callers are
 * refused exactly as the sibling thread-share routes do. Always a download
 * (never drawn on our origin), never sniffed. Fails closed on any error.
 */
import type { NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { contentDisposition, downloadType, shareCaller, shareError, shareFailure } from '@/lib/email-share/http'
import { readSharedEmailAttachmentForMember } from '@/lib/email-share/member-share'
import { EMAIL_SHARE_UNAVAILABLE_TEXT } from '@/lib/email-share/types'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const { id } = await params
  const messageId = request.nextUrl.searchParams.get('message') ?? ''
  const key = request.nextUrl.searchParams.get('key') ?? ''
  try {
    const result = await readSharedEmailAttachmentForMember(getServiceClient(), {
      shareId: id,
      messageId,
      key,
      callerUserId: caller.userId,
      workspaceId: caller.workspaceId,
    })
    if (result.state === 'not_found') return shareFailure({ ok: false, status: 404, code: 'not_found', error: 'Not found' })
    if (result.state === 'unavailable') return shareFailure({ ok: false, status: 410, code: 'unavailable', error: EMAIL_SHARE_UNAVAILABLE_TEXT })
    const { file } = result
    const headers: Record<string, string> = {
      'Content-Type': downloadType(file.mimeType),
      'Content-Disposition': contentDisposition(file.name),
      'Cache-Control': 'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
    }
    if (file.size !== null && file.body instanceof Uint8Array) headers['Content-Length'] = String(file.body.byteLength)
    console.info(`[email-thread-share] attachment share=${id}`)
    return new Response(file.body as BodyInit, { status: 200, headers })
  } catch (err) {
    return shareError(err, `attachment thread-share=${id}`, "Couldn't download that file")
  }
}
