/**
 * GET /api/account/drive/mail-files: the files attached to mail in the
 * person's OWN mailboxes linked to this workspace, read live from Gmail or
 * Graph, for Drive's "Email attachments" filter (docs/plans/drive-files.md,
 * phase 2). Nothing is stored (the 10-15 rule behind migration 344).
 *
 *   ?q=        words, passed to the provider's own search
 *   ?cursor=   the last answer's cursor
 *
 * → { files: MailFile[], cursor: string | null, mailboxes: number }
 *
 * Each file opens through the owner's attachment route, which reads it again
 * from the same mailbox (lib/drive/mail-files.ts).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { listMailFiles } from '@/lib/drive/mail-files'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const params = request.nextUrl.searchParams
  const q = (params.get('q') ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  const page = await listMailFiles(auth.user.id, auth.workspaceId, { q, cursor: params.get('cursor') })
  return NextResponse.json(page, { headers: { 'Cache-Control': 'no-store' } })
}
