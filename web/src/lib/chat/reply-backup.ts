/**
 * The reply backup, server half: write the chat-agent's own copy of a reply
 * into `chat_messages` (POST /api/internal/chat/reply).
 *
 * The browser used to be the only writer of an eve chat turn, and only at the
 * turn's end (eve-persist). A page that died mid-turn lost the turn from
 * history, though eve finished it and its tools ran (2026-10-19). Now:
 *
 *   - the transport saves the person's message the moment it is sent
 *     (eve-chat-transport.ts persistUserMessageNow), and names the reply it
 *     will render (`x-chat-reply-id`) on the send;
 *   - the chat-agent's reply-backup hook (agents/chat-agent/hooks/reply-backup.ts)
 *     keeps the reply's events as eve streams them and posts them here when
 *     the turn ends (or parks on a question);
 *   - this module reduces them with the browser's own reducer
 *     (reduceEveTurnParts, ./eve-turn-parts.ts) and writes the result under the
 *     reply's id as a PROVISIONAL row (persistEveMessage `provisional`).
 *
 * The browser's own persist of the same reply replaces a provisional row
 * (persistEveMessage), so when the page is alive its copy is the one kept, and
 * when it isn't, this one is. Either way the reply lands once: the row is
 * keyed on (conversation, ui_message_id).
 *
 * Tenancy comes only from the verified run token (the route's), never the
 * body; persistEveMessage re-asserts it against the conversation's owner. The
 * knowledge hook fires when THIS write inserted the row (as persistEveTurn
 * does for the browser's), so it fires once per reply whoever writes first.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { HandleMessageStreamEvent } from 'eve/client'
import { inngest } from '@/lib/inngest/client'
import { isBotConversation, type ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { persistEveMessage, type EveMessageResult } from '@/lib/chat/eve-message-writer'
import { reduceEveTurnParts } from '@/lib/chat/eve-turn-parts'

/** How a backed-up reply's turn stood when the hook posted it. */
export type ReplyBackupOutcome = 'completed' | 'failed' | 'cancelled' | 'waiting'
const OUTCOMES: readonly ReplyBackupOutcome[] = ['completed', 'failed', 'cancelled', 'waiting']

/** The kept events the reducer reads (agents/chat-agent/lib/reply-backup.ts keeps no others). */
const KEPT_EVENT_TYPES = new Set([
  'reasoning.appended',
  'message.appended',
  'message.completed',
  'actions.requested',
  'action.result',
  'input.requested',
  'step.failed',
  'turn.failed',
  'turn.completed',
  'turn.cancelled',
  'session.failed',
])

/** A reply id as the transport mints it (the chat-agent channel admits no other). */
const REPLY_ID_PATTERN = /^[\x21-\x7e]{1,200}$/

export interface ReplyBackupBody {
  /** The id the browser renders the reply under (its `start` chunk's messageId). */
  replyId: string
  /** The eve session and turn, for the log line only. */
  sessionId: string | null
  turnId: string | null
  outcome: ReplyBackupOutcome
  events: HandleMessageStreamEvent[]
}

export interface ReplyBackupResult {
  written: boolean
  replaced: boolean
  activityFired: boolean
  /** 'empty': the events reduce to no parts, so nothing was written. */
  reason?: EveMessageResult['reason'] | 'empty'
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/**
 * Whether one kept event has the shape the reducer reads without throwing.
 * The hook only ever sends these; anything else is a malformed body.
 */
function isKeptEvent(v: unknown): boolean {
  const e = rec(v)
  if (!e || typeof e.type !== 'string' || !KEPT_EVENT_TYPES.has(e.type)) return false
  const data = rec(e.data)
  switch (e.type) {
    case 'actions.requested':
      return !!data && Array.isArray(data.actions) && data.actions.every((a) => typeof rec(a)?.callId === 'string')
    case 'action.result': {
      const r = rec(data?.result)
      return !!r && typeof r.callId === 'string'
    }
    case 'input.requested':
      return !!data && Array.isArray(data.requests) && data.requests.every((q) => typeof rec(q)?.requestId === 'string')
    case 'reasoning.appended':
    case 'message.appended':
    case 'step.failed':
    case 'turn.failed':
      return !!data
    default:
      return true
  }
}

/** Parse + shape-check a backup body; `{ ok: false, error }` is a 400. */
export function parseReplyBackupBody(raw: unknown): { ok: true; body: ReplyBackupBody } | { ok: false; error: string } {
  const b = rec(raw)
  if (!b) return { ok: false, error: 'invalid body' }
  if (typeof b.replyId !== 'string' || !REPLY_ID_PATTERN.test(b.replyId)) return { ok: false, error: 'invalid replyId' }
  if (typeof b.outcome !== 'string' || !(OUTCOMES as readonly string[]).includes(b.outcome)) {
    return { ok: false, error: 'invalid outcome' }
  }
  if (!Array.isArray(b.events) || !b.events.every(isKeptEvent)) return { ok: false, error: 'invalid events' }
  return {
    ok: true,
    body: {
      replyId: b.replyId,
      sessionId: typeof b.sessionId === 'string' ? b.sessionId : null,
      turnId: typeof b.turnId === 'string' ? b.turnId : null,
      outcome: b.outcome as ReplyBackupOutcome,
      events: b.events as HandleMessageStreamEvent[],
    },
  }
}

/**
 * Reduce the backed-up reply and write it as a provisional row in the token's
 * conversation. Total: a persistence miss is a result, never a throw (the
 * route answers 500 only if this throws anyway).
 */
export async function persistReplyBackup(
  supabase: SupabaseClient,
  claims: ChatRunTokenClaims,
  body: ReplyBackupBody,
): Promise<ReplyBackupResult> {
  const parts = reduceEveTurnParts(body.replyId, body.events)
  // Nothing a message would show (the turn stopped before any output): the
  // browser writes no bubble for it either.
  if (parts.length === 0) return { written: false, replaced: false, activityFired: false, reason: 'empty' }

  const result = await persistEveMessage(supabase, {
    conversationId: claims.conversationId,
    userId: claims.userId,
    workspaceId: claims.workspaceId,
    role: 'assistant',
    parts,
    messageId: body.replyId,
    provisional: true,
  })

  // The knowledge hook, once per reply: only when this write inserted the row
  // (persistEveTurn's rule, including a bot's own thread never feeding claims).
  // A guest's thread (guest access) never feeds the owner's claims either.
  const activityFired = result.conversationActivityFired && (!claims.teammateId || isBotConversation(claims)) && !claims.guestId
  if (activityFired) {
    try {
      await inngest.send({
        name: 'conversation/activity',
        data: { workspaceId: claims.workspaceId, userId: claims.userId, conversationId: claims.conversationId },
      })
    } catch {
      // Knowledge extraction is best-effort; never fail the write for it.
    }
  }

  return {
    written: result.written,
    replaced: result.replaced === true,
    activityFired,
    ...(result.reason ? { reason: result.reason } : {}),
  }
}
