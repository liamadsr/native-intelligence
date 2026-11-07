/**
 * POST /api/internal/chat/reply
 *
 * INTERNAL-ONLY. The chat-agent's reply-backup hook
 * (agents/chat-agent/hooks/reply-backup.ts) posts its own copy of a reply here
 * when the turn ends (or parks on a question), and this route writes it into
 * `chat_messages` as a provisional row the browser's persist replaces
 * (src/lib/chat/reply-backup.ts). It is what keeps a reply in the thread when
 * the page that asked for it died mid-turn.
 *
 * Auth (two gates, as the other internal chat routes):
 *   1. the chat family's internal secret (constant-time): the caller is our
 *      own eve runtime;
 *   2. a chat-run token whose HMAC verifies, one expired less than
 *      TURN_REPORT_TOKEN_GRACE_MS ago included (a turn's last step can finish
 *      after its token does; past the grace, 401). Tenancy is read from it,
 *      never the body, and the writer re-asserts it against the
 *      conversation's owner.
 * A device ask's token (its conversation row is deleted when the ask ends) and
 * a server principal's (a home turn writes its own reply) are answered 200
 * `skipped`: nothing here writes for them.
 *
 * Status codes: 200 written / duplicate / skipped / empty; 400 malformed body;
 * 401 secret or token rejected; 500 the write threw (the hook retries once).
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { badRequest, serverError, unauthorized } from '@/lib/api-errors'
import {
  TURN_REPORT_TOKEN_GRACE_MS,
  extractChatRunToken,
  extractInternalSecret,
  verifyChatRunToken,
  verifyInternalSecret,
} from '@/lib/chat/chat-run-token'
import { parseReplyBackupBody, persistReplyBackup } from '@/lib/chat/reply-backup'
import { chatRunBindingRefusal } from '@/lib/chat/surface-run-guard'
import { signalChatSessionActivity } from '@/lib/chat/idle-compaction-signal'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    console.error('[chat reply backup] internal secret rejected')
    return unauthorized('internal secret rejected')
  }
  const claims = verifyChatRunToken(extractChatRunToken(request), { allowExpired: true })
  if (!claims) return unauthorized('invalid run token')
  // A token past its expiry posts only within the grace; never longer.
  if (claims.exp <= Date.now() - TURN_REPORT_TOKEN_GRACE_MS) return unauthorized('run token expired too long ago')
  if (claims.surface || claims.server) {
    return NextResponse.json({ written: false, skipped: true })
  }
  // The claims must still bind to a live conversation of this user (expiry is
  // forgiven for attribution of finished work; the binding never is).
  const refused = await chatRunBindingRefusal(claims)
  if (refused) return refused

  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return badRequest('invalid JSON body')
  }
  const parsed = parseReplyBackupBody(raw)
  if (!parsed.ok) return badRequest(parsed.error)

  try {
    const result = await persistReplyBackup(getServiceClient(), claims, parsed.body)
    if (result.written) {
      // The browser wasn't there to write it first: say so (ids only), and
      // restart the conversation's idle-compaction timer as its persist would.
      console.info(
        '[chat reply backup]',
        JSON.stringify({
          conversationId: claims.conversationId,
          sessionId: parsed.body.sessionId,
          turnId: parsed.body.turnId,
          outcome: parsed.body.outcome,
        }),
      )
      signalChatSessionActivity({
        conversationId: claims.conversationId,
        workspaceId: claims.workspaceId,
        userId: claims.userId,
        source: 'turn',
      })
    }
    return NextResponse.json(result)
  } catch (err) {
    console.error('[chat reply backup] write failed:', err)
    return serverError('reply backup failed')
  }
}
