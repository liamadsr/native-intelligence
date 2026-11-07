import type { UIMessage } from '@ai-sdk/react'
import { OPENED_CARD_ID_PREFIX } from '@/lib/chat-cards/opened-card'
import { applyChatRetention, MIN_TRIMMED_MESSAGES } from './message-retention'

function isStoredMessage(v: unknown): v is UIMessage {
  const m = v as Partial<UIMessage> | null
  return !!m && typeof m === 'object' && typeof m.id === 'string' && Array.isArray(m.parts)
}

/**
 * The thread a chat restored from this device's storage should show once its
 * conversation's rows have been read — or null to keep the one it has.
 *
 * The stored thread is a copy of the conversation, and a copy that falls
 * behind: a tab writes it back only when its panel snapshots or flushes, and
 * that write can be refused (a full storage bucket, silently) or never happen
 * (the app closing without a page-hide). The rows are written as each turn
 * completes, so they hold every message the copy does, and whatever came after.
 *
 * So the rows win when they CONTAIN the copy — every message it holds, by id —
 * and carry a message it lacks. Which missing messages count depends on the
 * copy: one retention has cut from the front (MIN_TRIMMED_MESSAGES or more)
 * lacks the older rows by design, so only a row past where it starts is news;
 * a shorter copy was never cut, so every row it lacks is — a copy that started
 * over from empty (a catch-up that couldn't run, then the chat went on) gets
 * its earlier history back. A copy holding a message the rows don't (a turn
 * the save never reached) keeps what it has: catching up must never lose a
 * message. A page the person opened that the rows lack is not such a turn
 * (never a message to the agent, never drawn in the chat): a copy whose only
 * messages of its own are pages still takes the rows, each of its pages put
 * back where it sat (withOwnPages). Otherwise one unsaved page held the thread
 * on its stored copy for good, every newer message missing (DEV, 2026-10-20:
 * a home thread 37 messages long against 45 rows). The result is bounded like
 * every live thread (applyChatRetention).
 *
 * The pages the person opened (lib/chat-cards/opened-card.ts) come back even
 * then: a copy holding a message of its own (a turn that never reached the
 * rows) would otherwise keep every page it lacks out for good, the cards
 * note and the page openers with them (recoverOpenedCards).
 *
 * `partial`: the rows are the thread's newest page, not all of it (the read
 * said `hasMore`). When the copy holds the page's oldest row, its messages
 * from before that row are older than the page, not messages of its own: a
 * copy at the retention cap read against a page of the same size lacks its
 * oldest row once one new row lands, and that row held the copy for good
 * (PROD 2026-10-31: a 616-message home thread never took a home turn on
 * focus). A copy that doesn't reach back to the page's start keeps every
 * message it lacks as its own: an unsaved turn before a row it shares stays.
 */
export function caughtUpThread(local: readonly UIMessage[], rows: unknown, opts: { partial?: boolean } = {}): UIMessage[] | null {
  if (!Array.isArray(rows)) return null
  const server = rows.filter(isStoredMessage)
  const localIds = new Set(local.map((m) => m.id))
  // A trimmed copy starts at the first row it shares (-1: it shares none).
  const start = local.length < MIN_TRIMMED_MESSAGES ? 0 : server.findIndex((m) => localIds.has(m.id))
  const serverIds = new Set(server.map((m) => m.id))
  // The part of the copy the rows reach: all of it, or, against a page whose oldest row it holds, from that row on.
  const pageStart = opts.partial && server.length > 0 ? local.findIndex((m) => m.id === server[0].id) : -1
  const reached = pageStart > 0 ? local.slice(pageStart) : local
  // The copy's own messages (the rows lack them): pages it opened hold nothing back, a turn does.
  const ownPages = new Set(reached.filter((m) => !serverIds.has(m.id)).map((m) => m.id))
  const ownTurn = [...ownPages].some((id) => !id.startsWith(OPENED_CARD_ID_PREFIX))
  if (!ownTurn && server.length > reached.length - ownPages.size && server.slice(start).some((m) => !localIds.has(m.id))) {
    return applyChatRetention(ownPages.size ? withOwnPages(server, local, ownPages) : server)
  }
  return start < 0 ? null : recoverOpenedCards(local, server, start)
}

/**
 * The rows, with the pages only the copy holds (`own`, by id) put back where
 * they sat in it: after the nearest earlier message of the copy the thread
 * holds, else before the nearest later one, else at the end. In the copy's
 * order, so its pages keep theirs.
 */
function withOwnPages(server: readonly UIMessage[], local: readonly UIMessage[], own: ReadonlySet<string>): UIMessage[] {
  const thread = [...server]
  for (let i = 0; i < local.length; i++) {
    const page = local[i]
    if (!own.has(page.id)) continue
    // Earlier messages of the copy already in the thread (shared, or put back just before).
    let at = -1
    for (let j = i - 1; j >= 0 && at < 0; j--) at = thread.findIndex((m) => m.id === local[j].id)
    if (at >= 0) {
      thread.splice(at + 1, 0, page)
      continue
    }
    let before = -1
    for (let j = i + 1; j < local.length && before < 0; j++) if (!own.has(local[j].id)) before = thread.findIndex((m) => m.id === local[j].id)
    if (before >= 0) thread.splice(before, 0, page)
    else thread.push(page)
  }
  return thread
}

/**
 * The opened pages the rows hold and the copy lacks, put in the copy where
 * they sit among the rows: after the nearest earlier row the copy has too,
 * else before the nearest later one, else at the end. Every message of the
 * copy stays, in its order. Rows a trimmed copy starts after (`start`) are
 * left out by design. Null when there are none.
 */
function recoverOpenedCards(local: readonly UIMessage[], server: UIMessage[], start: number): UIMessage[] | null {
  const localIds = new Set(local.map((m) => m.id))
  const missing = new Set(server.slice(start).filter((m) => m.id.startsWith(OPENED_CARD_ID_PREFIX) && !localIds.has(m.id)).map((m) => m.id))
  if (!missing.size) return null
  const thread = [...local]
  for (let i = start; i < server.length; i++) {
    const row = server[i]
    if (!missing.has(row.id)) continue
    // Earlier rows already in the thread (shared, or recovered just before).
    let at = -1
    for (let j = i - 1; j >= start && at < 0; j--) at = thread.findIndex((m) => m.id === server[j].id)
    if (at >= 0) {
      thread.splice(at + 1, 0, row)
      continue
    }
    let before = -1
    for (let j = i + 1; j < server.length && before < 0; j++) if (!missing.has(server[j].id)) before = thread.findIndex((m) => m.id === server[j].id)
    if (before >= 0) thread.splice(before, 0, row)
    else thread.push(row)
  }
  return applyChatRetention(thread)
}
