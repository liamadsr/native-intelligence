/**
 * GET /api/account/email/threads/[threadId]/attachment?message=<id>&name=<file name>
 *
 * One attachment of one of the person's own messages, read live from their
 * mailbox (readEmailAttachment: the mailboxes this workspace may read, up to
 * ATTACHMENT_READ_MAX_BYTES) and never written anywhere. Always a download:
 * never drawn on our origin, never sniffed, the same headers a shared
 * thread's attachment gets (shares/[id]/attachment).
 */
import type { NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { readEmailAttachment } from '@/lib/email/email-read-service'
import { contentDisposition } from '@/lib/email-share/http'

export const maxDuration = 30

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth

  const messageId = request.nextUrl.searchParams.get('message') ?? ''
  const name = request.nextUrl.searchParams.get('name') ?? ''
  if (!messageId || !name || messageId.length > 512 || name.length > 512) return badRequest('message and name are required')

  try {
    const file = await readEmailAttachment(user.id, messageId, name, workspaceId)
    if (!file) return notFound("Couldn't find that attachment, or it is too large to download here")
    return new Response(file.bytes as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': contentDisposition(file.fileName),
        'Content-Length': String(file.bytes.byteLength),
        'Cache-Control': 'no-store, private',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      },
    })
  } catch (err) {
    console.error('[email] attachment download failed:', err instanceof Error ? err.message : 'unknown error')
    return serverError("Couldn't download that file")
  }
}
