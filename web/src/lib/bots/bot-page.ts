'use client'

/**
 * A bot's page (docs/plans/bots-v4.md, "A bot's page"): one teammate's chat
 * and its work (TeammateChatPage), opened as a card in the chat (the `bot`
 * page kind), full screen. A narrow card shows the two as tabs, Work and Chat.
 *
 * `openBotPage(teammateId)` opens it from anywhere, over openTeammateChatTab
 * (the dashboard's TeammateChatTabBridge answers it, for a teammate its roster
 * holds). It returns whether the dashboard took it.
 *
 *   focus    the part a narrow card shows: 'work' by default, since opening
 *            a bot's page asks for its work (the bubble's "Open Triage's
 *            page", a bot opened with nothing new: open-teammate.ts), or
 *            'chat'. A page asked nothing (Open in Dial8's chat) shows its
 *            chat.
 *
 * The part rides beside the open, not in the card. A page mounted in a moment
 * hears an ask made up to BOT_PAGE_FOCUS_TTL_MS before (onBotPageFocus), and
 * one already mounted hears it at once. The page that applies an ask takes
 * it, so it's heard once. Only the bot's lists listen (TeammateChatPage): an
 * item always opens on the item.
 *
 * `openBotPageItem(teammateId, item)` (bots-v4.md "An item opens on its bot's
 * page", Phase 2) opens the page on one of its items: the item on the work
 * side, the conversation about it beside it, and its way back to the lists.
 * It's what useOpenWorkItem and openItem (open-teammate.ts) call for an item
 * with a teammate.
 *
 * Its header draws the face in its state (teammate-state.ts teammateBotState):
 * working while one of its runs runs; asleep while it's switched off, its
 * attempts are paused, or the AI usage limit stopped it: the shared source's
 * word whenever it holds an answer (crew-state.ts aiLimitedTeammates, what the
 * crew draws), so the page and its bot beside the chat agree; its own last
 * run (stoppedByAiLimit) only until then.
 */
import { AI_LIMIT_WINDOW_MS, isPausedFailure, settledAt } from '@/lib/work/presentation'
import type { WorkItem } from '@/lib/work/types'
import { openTeammateChatTab, type TeammateChatItem } from './teammate-chat-tab'

/**
 * How long a run stopped by the AI usage limit keeps its bot asleep: the
 * Agents page's "Loops are paused" banner keeps the same 48 hours.
 */
export const AI_LIMIT_SLEEP_HOURS = AI_LIMIT_WINDOW_MS / 3_600_000

type SettledRow = Pick<WorkItem, 'status' | 'error_message' | 'finished_at' | 'created_at'>

/** Whether the AI usage limit stopped this row (its last finished) within AI_LIMIT_SLEEP_HOURS. */
export function stoppedByAiLimit(last: SettledRow | null | undefined, now = Date.now()): boolean {
  if (!last || !isPausedFailure(last)) return false
  const at = Date.parse(settledAt(last))
  return Number.isFinite(at) && now - at <= AI_LIMIT_WINDOW_MS
}


/**
 * How long a bot's page keeps its read after its window leaves the screen (a
 * tab flipped, its card folded): a quick look away and back reloads
 * nothing.
 */
export const BOT_PAGE_LINGER_MS = 15_000

/** What a narrow window shows of a bot's page. */
export type BotPagePart = 'work' | 'chat'

/** How long an ask waits for its page to mount (the tab's window opening). */
export const BOT_PAGE_FOCUS_TTL_MS = 5_000

interface FocusAsk {
  teammateId: string
  part: BotPagePart
  at: number
}

let pending: FocusAsk | null = null
const listeners = new Set<(ask: FocusAsk) => void>()

/** Asks `teammateId`'s page to show `part` in a narrow window. */
function askFocus(teammateId: string, part: BotPagePart): void {
  const ask: FocusAsk = { teammateId, part, at: Date.now() }
  pending = ask
  for (const listener of [...listeners]) listener(ask)
}

/**
 * Calls `apply` with each part asked for `teammateId`'s page from now on, and
 * at once with one asked within BOT_PAGE_FOCUS_TTL_MS before (the page mounts
 * just after its tab opens). Applying an ask takes it: it isn't heard again.
 * Until the returned function runs.
 */
export function onBotPageFocus(teammateId: string, apply: (part: BotPagePart) => void): () => void {
  const listener = (ask: FocusAsk) => {
    if (ask.teammateId !== teammateId) return
    if (pending === ask) pending = null
    apply(ask.part)
  }
  listeners.add(listener)
  const waiting = pending
  if (waiting && waiting.teammateId === teammateId && Date.now() - waiting.at <= BOT_PAGE_FOCUS_TTL_MS) {
    pending = null
    apply(waiting.part)
  }
  return () => {
    listeners.delete(listener)
  }
}

export function openBotPage(
  teammateId: string,
  { focus = 'work' }: { focus?: BotPagePart } = {},
): boolean {
  if (!teammateId) return false
  const opened = openTeammateChatTab(teammateId, null)
  // Its page renders after this returns (the tab's state change), and hears the ask then.
  if (opened) askFocus(teammateId, focus)
  return opened
}

/**
 * `teammateId`'s page on one of its items (see above). Whether the dashboard
 * took it: false where it isn't mounted, or the roster doesn't hold the
 * teammate (deleted, or behind a private team you're not on), and the caller
 * opens the item over the Inbox instead.
 */
export function openBotPageItem(teammateId: string, item: TeammateChatItem): boolean {
  if (!teammateId || !item.itemId) return false
  return openTeammateChatTab(teammateId, item)
}

/** Tests only: no ask pending, nobody listening. */
export function __resetBotPageForTests(): void {
  pending = null
  listeners.clear()
}
