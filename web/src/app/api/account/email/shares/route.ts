/**
 * /api/account/email/shares (migration 646): share an email thread into team
 * chat, read live, store no mail (src/lib/email-share).
 *   GET  ?thread=<provider thread id>&account=<mailbox> | ?index=<index row id>
 *        → { shares: EmailShareChip[] } where the caller's OWN thread is
 *        shared now (the thread view's chips). Anyone else's thread: none.
 *   POST { threadId | indexId, accountId?, channelId, note? } → { share,
 *        label, message } the caller's own thread shared into a channel or DM
 *        they may post in: its message ids read live and frozen, and a
 *        message authored by them posted with it (their note, else "Shared an
 *        email"). Its notifications are asked for after the answer, as any
 *        message's; no agent turn and no chat_message loop is started by it.
 * Bearer callers are refused (src/lib/email-share/http.ts). Logs carry ids and
 * counts, never the mail.
 */
import { after, type NextRequest } from 'next/server'
import { badRequest } from '@/lib/api-errors'
import { createEmailShare, defaultEmailShareDeps, listThreadShares } from '@/lib/email-share/service'
import { noStore, shareCaller, shareFailure } from '@/lib/email-share/http'
import { requestTeamChatNotify } from '@/lib/team-chat/notify'

export async function GET(request: NextRequest) {
  const caller = await shareCaller(request)
  if (caller instanceof Response) return caller
  const params = request.nextUrl.searchParams
  const shares = await listThreadShares(defaultEmailShareDeps(), caller, {
    threadId: params.get('thread'),
    accountId: params.get('account'),
    indexId: params.get('index'),
  })
  return noStore({ shares })
}

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
  let result: Awaited<ReturnType<typeof createEmailShare>>
  try {
    result = await createEmailShare(defaultEmailShareDeps(), caller, {
      threadId: str(input.threadId),
      indexId: str(input.indexId),
      accountId: str(input.accountId),
      channelId: str(input.channelId) ?? '',
      note: input.note,
    })
  } catch (err) {
    // The error's name only, never its message (nothing of the mail or the note reaches a log).
    console.error('[email-share] share failed:', err instanceof Error ? err.name : 'unknown')
    return shareFailure({ ok: false, status: 500, code: 'failed', error: "Couldn't share it" })
  }
  if (!result.ok) {
    console.info(`[email-share] share refused code=${result.code}`)
    return shareFailure(result)
  }
  console.info(`[email-share] shared share=${result.shareId} channel=${result.message.channel_id} messages=${result.messageCount}`)
  const messageId = result.message.id
  after(() => requestTeamChatNotify(messageId))
  return noStore({ share: { id: result.shareId }, label: result.label, message: result.message }, { status: 201 })
}
