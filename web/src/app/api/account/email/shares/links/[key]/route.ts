/**
 * /api/account/email/shares/links/[key] (migration 646): one share link.
 *   GET  (key: the link's token) → ShareLinkPage, for its page
 *        (/mail/s/<token>): the owner's thread for its owner; for a teammate,
 *        the thread through a live share from this link in a chat they may
 *        read (the share reader and its checks); for anyone else, signed out
 *        included, only { state: 'outside' }. Remote images stay out unless
 *        `?images=1`. 503 { code: 'busy' } when the mailbox can't answer now.
 *   DELETE (key: the link's id) → { ok, revokedShares } the owner revokes it:
 *        it binds nothing from now on, and every share made from it ends.
 * Device tokens are refused. The token is never logged.
 */
import type { NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { defaultEmailShareDeps, resolveShareLink, revokeShareLink } from '@/lib/email-share/service'
import { noStore, refuseBearer, shareCaller, shareError, shareFailure } from '@/lib/email-share/http'

type Params = { params: Promise<{ key: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const refused = refuseBearer(request)
  if (refused) return refused
  const { key } = await params
  const auth = await requireUser()
  // Signed out: nothing of the mail, nothing about the link.
  if (auth instanceof Response) return noStore({ state: 'outside' })
  try {
    const images = request.nextUrl.searchParams.get('images') === '1'
    return noStore(await resolveShareLink(defaultEmailShareDeps(), { supabase: auth.supabase, userId: auth.user.id }, key, { images }))
  } catch (err) {
    return shareError(err, 'link page', "Couldn't open this email")
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const { key } = await params
  const result = await revokeShareLink(defaultEmailShareDeps(), caller, key)
  if (!result.ok) return shareFailure(result)
  console.info(`[email-share] link=${key} revoked shares=${result.revokedShares}`)
  return noStore({ ok: true, revokedShares: result.revokedShares })
}
