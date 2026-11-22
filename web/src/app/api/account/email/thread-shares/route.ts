/**
 * /api/account/email/thread-shares (migration 673): email threads shared with
 * a PERSON by an @-mention (decision 1).
 *   GET ?thread=<email_thread_index id> → { shareId } the caller's OWN active
 *        share id for that thread index row, IF they are a grantee (so a chip
 *        that only knows the mention's email_thread id can find its share).
 *        404 when they are not a grantee (never confirms a share exists to
 *        someone it does not reach).
 * Bearer callers are refused (shared mail opens in the app).
 */
import type { NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { badRequest } from '@/lib/api-errors'
import { noStore, shareCaller, shareFailure } from '@/lib/email-share/http'
import { findMemberShareId } from '@/lib/email-share/member-share'

export async function GET(request: NextRequest) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const threadIndexId = request.nextUrl.searchParams.get('thread')
  if (!threadIndexId) return badRequest('Pass a thread index id')
  const shareId = await findMemberShareId(getServiceClient(), {
    threadIndexId,
    callerUserId: caller.userId,
    workspaceId: caller.workspaceId,
  })
  if (!shareId) return shareFailure({ ok: false, status: 404, code: 'not_found', error: 'Not found' })
  return noStore({ shareId })
}
