/**
 * GET ?message=<id>&key=<key>: one attachment of a company's team-shared
 * thread (migration 680). The thread must be one the database lists for this
 * reader, the message one the thread holds now, the key one the message lists
 * (the provider checks it, with the share size cap). Streamed live from the
 * owner's mailbox, never stored; always a download. Else 404 (or 410 when the
 * mailbox is gone). People only.
 */
import type { NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { contentDisposition, downloadType, shareCaller, shareError, shareFailure } from '@/lib/email-share/http'
import { readCompanyTeamAttachment } from '@/lib/email-share/company-team'
import { EMAIL_SHARE_UNAVAILABLE_TEXT } from '@/lib/email-share/types'

type Params = { params: Promise<{ id: string; threadId: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const { id, threadId } = await params
  const messageId = request.nextUrl.searchParams.get('message') ?? ''
  const key = request.nextUrl.searchParams.get('key') ?? ''
  try {
    const result = await readCompanyTeamAttachment(getServiceClient(), { companyId: id, threadIndexId: threadId, messageId, key }, { userId: caller.userId, workspaceId: caller.workspaceId })
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
    return new Response(file.body as BodyInit, { status: 200, headers })
  } catch (err) {
    return shareError(err, `company-team attachment thread=${threadId}`, "Couldn't download that file")
  }
}
