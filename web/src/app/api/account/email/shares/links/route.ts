/**
 * POST /api/account/email/shares/links (migration 646) { threadId | indexId,
 * accountId? } → { link: { id }, url, reused } Copy link: the caller's OWN
 * thread's share link (`<app>/mail/s/<token>`), its message ids read live and
 * frozen now; an open link for the same messages is handed back again. The
 * link grants nothing on its own: pasted by its owner into a team chat
 * message, it becomes a share there (src/lib/email-share/bind.ts). Device
 * tokens are refused (src/lib/email-share/http.ts). Logs carry ids only.
 */
import type { NextRequest } from 'next/server'
import { badRequest } from '@/lib/api-errors'
import { createShareLink, defaultEmailShareDeps } from '@/lib/email-share/service'
import { noStore, shareCaller, shareError, shareFailure } from '@/lib/email-share/http'

export async function POST(request: NextRequest) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
  try {
    const result = await createShareLink(defaultEmailShareDeps(), caller, {
      threadId: str(input.threadId),
      indexId: str(input.indexId),
      accountId: str(input.accountId),
    })
    if (!result.ok) return shareFailure(result)
    console.info(`[email-share] link=${result.linkId} ${result.reused ? 'reused' : 'made'}`)
    return noStore({ link: { id: result.linkId }, url: result.url, reused: result.reused }, { status: result.reused ? 200 : 201 })
  } catch (err) {
    return shareError(err, 'link', "Couldn't make a link")
  }
}
