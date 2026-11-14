/**
 * /api/account/email/shares/[id] (migration 646): one shared thread.
 *   GET  ?view=card → EmailShareCardView: the card in chat (its state, and
 *        the newest shared message's sender, subject and first line, read
 *        live).
 *   GET  → EmailShareThreadView: the thread read-only, ONLY its frozen
 *        messages, read live from the owner's mailbox with the owner's token
 *        (from, to, cc, date, subject, the body sanitized, attachment names
 *        and sizes). Remote images and CSS urls are left out (counted in
 *        `blockedImages`) unless `?images=1`. 410 { code: 'revoked' } once
 *        un-shared, 410 { code: 'unavailable' } when the mailbox can't give
 *        it any more, 503 { code: 'busy' } when it can't answer now.
 *   DELETE → { ok } un-share: the owner's alone; access ends at once.
 * Every read is checked first (src/lib/email-share/service.ts shareAccess):
 * same workspace, the caller may read the share's channel, not revoked.
 * Anyone else: 404. Bearer callers are refused. Nothing is cached but a few
 * seconds of a card's lines in this process; the answer is never stored.
 */
import type { NextRequest } from 'next/server'
import { defaultEmailShareDeps, readShareCard, readSharedThread, revokeEmailShare } from '@/lib/email-share/service'
import { isShareFailure, noStore, shareCaller, shareError, shareFailure } from '@/lib/email-share/http'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const { id } = await params
  const deps = defaultEmailShareDeps()
  try {
    if (request.nextUrl.searchParams.get('view') === 'card') {
      const card = await readShareCard(deps, caller, id)
      return isShareFailure(card) ? shareFailure(card) : noStore(card)
    }
    const images = request.nextUrl.searchParams.get('images') === '1'
    const thread = await readSharedThread(deps, caller, id, { images })
    return isShareFailure(thread) ? shareFailure(thread) : noStore(thread)
  } catch (err) {
    return shareError(err, `read share=${id}`, "Couldn't open this email")
  }
}

export async function DELETE(request: NextRequest, { params }: Params) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const { id } = await params
  const result = await revokeEmailShare(defaultEmailShareDeps(), caller, id)
  if (!result.ok) return shareFailure(result)
  console.info(`[email-share] un-shared share=${id}`)
  return noStore({ ok: true })
}
