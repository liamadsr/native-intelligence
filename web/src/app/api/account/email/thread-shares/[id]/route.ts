/**
 * /api/account/email/thread-shares/[id] (migration 673): one email thread
 * shared with a PERSON by an @-mention (decision 1).
 *   GET  → the thread read-only, ONLY its frozen messages, read live from the
 *        OWNER's mailbox with the owner's token (the same sanitized shape the
 *        channel share returns: { subject, messages, missing, blockedImages }).
 *        Remote images and CSS urls are left out (counted in `blockedImages`)
 *        unless `?images=1`. The grantee the share names, or the owner, reads;
 *        ANYONE ELSE gets 404 (never 403). 410 { code: 'unavailable' } when the
 *        owner's mailbox can't give it any more; 503 { code: 'busy' } when it
 *        can't answer now.
 *   DELETE → { ok } un-share: the owner's alone (a non-owner gets 404); access
 *        ends at once.
 * Bearer callers are refused (shared mail opens in the app). Nothing of the
 * mail is stored, cached beyond the provider layer, or logged.
 */
import type { NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { noStore, shareCaller, shareError, shareFailure } from '@/lib/email-share/http'
import { readSharedEmailThreadForMember, revokeEmailThreadShare } from '@/lib/email-share/member-share'
import { EMAIL_SHARE_UNAVAILABLE_TEXT } from '@/lib/email-share/types'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const { id } = await params
  const images = request.nextUrl.searchParams.get('images') === '1'
  try {
    const result = await readSharedEmailThreadForMember(getServiceClient(), {
      shareId: id,
      callerUserId: caller.userId,
      workspaceId: caller.workspaceId,
      images,
    })
    if (result.state === 'not_found') return shareFailure({ ok: false, status: 404, code: 'not_found', error: 'Not found' })
    if (result.state === 'unavailable') return shareFailure({ ok: false, status: 410, code: 'unavailable', error: EMAIL_SHARE_UNAVAILABLE_TEXT })
    return noStore(result.thread)
  } catch (err) {
    return shareError(err, `read thread-share=${id}`, "Couldn't open this email")
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const { id } = await params
  const result = await revokeEmailThreadShare(getServiceClient(), { shareId: id, ownerUserId: caller.userId, workspaceId: caller.workspaceId })
  if (!result.ok) return shareFailure({ ok: false, status: result.status, code: result.status === 404 ? 'not_found' : 'failed', error: result.status === 404 ? 'Not found' : "Couldn't un-share it" })
  console.info(`[email-thread-share] un-shared share=${id}`)
  return noStore({ ok: true })
}
