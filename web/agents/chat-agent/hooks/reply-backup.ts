/**
 * reply-backup — the SERVER writes every main-chat reply too, so a reply
 * survives the page that asked for it.
 *
 * The browser persists a turn only when it ends (eve-persist). When the page
 * dies mid-turn (2026-10-19: a WebKit crash and a silent reload four seconds
 * after Liam spoke), eve still finishes the turn and its tools still run, but
 * nothing writes it to chat_messages, so the thread never shows it. This hook
 * keeps the reply as eve streams it (../lib/reply-backup.ts, in durable state:
 * a turn's steps can run in different processes) and, whenever a person could
 * be looking at it, posts it to POST /api/internal/chat/reply:
 *
 *   turn.completed / turn.failed / turn.cancelled — the turn ended;
 *   turn.waiting { on: 'input' }                  — it parked on a question or
 *                                                   an approval (a person must
 *                                                   act; the page may be gone).
 *
 * The route writes it under the id the browser renders (the transport sends
 * it as `x-chat-reply-id`) as a PROVISIONAL row, and the browser's own persist
 * replaces a provisional row, so when the page is alive its copy is what the
 * thread keeps; when it isn't, this one is (src/lib/chat/reply-backup.ts).
 * Each post carries the whole reply so far, so a later one (the answer to a
 * parked question) replaces the earlier.
 *
 * Only a send that names its reply is backed up: a device ask, a
 * server-written home turn (home-turn-server.ts writes its own) and an older
 * client name none, and nothing is posted for them.
 *
 * Never throws (a throw on a failure event would escalate to session.failed)
 * and bounded: two attempts of REPLY_BACKUP_TIMEOUT_MS. A backup that still
 * fails is logged and dropped: the browser's persist remains the main path.
 *
 * Not re-exported by the helper subagents: their turns are not chat messages
 * (the parent's action.result carries what they did).
 */
import { defineHook } from 'eve/hooks'
import { defineState } from 'eve/context'
import { postReplyBackup, replyIdFromAuth, runTokenFromAuth } from '../lib/spec-client.js'
import { emptyReplyBackup, foldReplyBackup, hasReplyContent, saneReplyBackup, type ReplyBackupState } from '../lib/reply-backup.js'

/** Attempts per backup post (a retryable failure is tried once more). */
export const REPLY_BACKUP_ATTEMPTS = 2
const RETRY_DELAY_MS = 300

const backup = defineState<ReplyBackupState>('chat-agent.reply-backup', emptyReplyBackup)

type HookCtx = { session: { id: string; auth: Parameters<typeof replyIdFromAuth>[0] } }
type Outcome = 'completed' | 'failed' | 'cancelled' | 'waiting'

function replyIdOf(ctx: HookCtx): string {
  try {
    return replyIdFromAuth(ctx.session.auth)
  } catch {
    return ''
  }
}

function fold(event: unknown, ctx: HookCtx): void {
  try {
    const replyId = replyIdOf(ctx)
    backup.update((raw) => foldReplyBackup(saneReplyBackup(raw), replyId || null, event))
  } catch (err) {
    console.error(`[chat-agent] reply backup fold failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Post the reply kept so far. Kept as is afterwards: a parked reply's answer continues it. */
async function flush(event: unknown, ctx: HookCtx, outcome: Outcome): Promise<void> {
  try {
    const state = saneReplyBackup(backup.get())
    if (!state.replyId || !hasReplyContent(state)) return
    const runToken = runTokenFromAuth(ctx.session.auth)
    if (!runToken) return // No token, no conversation to write into.
    const turnId = (event as { data?: { turnId?: unknown } }).data?.turnId
    const body = {
      replyId: state.replyId,
      sessionId: ctx.session.id,
      turnId: typeof turnId === 'string' ? turnId : null,
      outcome,
      events: state.events,
    }
    for (let attempt = 1; attempt <= REPLY_BACKUP_ATTEMPTS; attempt++) {
      const res = await postReplyBackup(runToken, body)
      if (res.ok || !res.retryable) return
      if (attempt < REPLY_BACKUP_ATTEMPTS) await sleep(RETRY_DELAY_MS)
    }
    console.error(`[chat-agent] reply backup for ${ctx.session.id}/${body.turnId ?? '-'} not delivered`)
  } catch (err) {
    console.error(`[chat-agent] reply backup flush failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function end(event: unknown, ctx: HookCtx, outcome: Outcome): Promise<void> {
  fold(event, ctx)
  await flush(event, ctx, outcome)
}

export default defineHook({
  events: {
    async 'reasoning.appended'(event, ctx) {
      fold(event, ctx)
    },
    async 'message.appended'(event, ctx) {
      fold(event, ctx)
    },
    async 'message.completed'(event, ctx) {
      fold(event, ctx)
    },
    async 'actions.requested'(event, ctx) {
      fold(event, ctx)
    },
    async 'action.result'(event, ctx) {
      fold(event, ctx)
    },
    async 'input.requested'(event, ctx) {
      fold(event, ctx)
    },
    async 'step.failed'(event, ctx) {
      fold(event, ctx)
    },
    async 'session.failed'(event, ctx) {
      fold(event, ctx)
    },
    async 'turn.waiting'(event, ctx) {
      // Only a park a person must answer: a wait on background tasks ends in a
      // turn.completed that posts the whole reply anyway.
      if ((event as { data?: { on?: unknown } }).data?.on !== 'input') return
      await flush(event, ctx, 'waiting')
    },
    async 'turn.completed'(event, ctx) {
      await end(event, ctx, 'completed')
    },
    async 'turn.failed'(event, ctx) {
      await end(event, ctx, 'failed')
    },
    async 'turn.cancelled'(event, ctx) {
      await end(event, ctx, 'cancelled')
    },
  },
})
