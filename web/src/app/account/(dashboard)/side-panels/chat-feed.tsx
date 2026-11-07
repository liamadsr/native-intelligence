'use client'

/**
 * What the side panel reads of the main chat: its newest plan, its quick
 * helpers (the newest reply's `helpers` call), its conversation and whether a
 * reply is running (the Context card reads the size again once one ends); and how
 * a panel toggle holds the chat's scroll in place (registerChatScrollHold). The chat
 * publishes them here (ChatFeedPublisher, rendered by ChatPanel) and the panel
 * subscribes, so the panel lives in the shell, outside ChatPanel, and opening
 * or closing it never re-renders the chat.
 *
 * Flat cost: the plan and the batch are read once per message (cached by
 * their parts arrays, chat-widgets-model.ts) and published only when what the
 * panel draws of them changes (planKey, batchKey), so a streamed token that
 * changes nothing wakes nothing.
 */
import { memo, useEffect, useMemo, useSyncExternalStore } from 'react'
import type { UIMessage } from 'ai'
import { registerChatScrollHold } from './side-panel-store'
import {
  newestThreadPlan,
  planKey,
  quickHelperBatch,
  type QuickHelperBatch,
  type ThreadPlan,
} from '../chat/chat-widgets-model'

export interface ChatFeed {
  plan: ThreadPlan | null
  quick: QuickHelperBatch | null
  conversationId: string | null
  /** A reply is on its way or running (useChat's submitted / streaming). */
  busy: boolean
}

const EMPTY: ChatFeed = { plan: null, quick: null, conversationId: null, busy: false }

let feed: ChatFeed = EMPTY
const listeners = new Set<() => void>()

export function getChatFeed(): ChatFeed {
  return feed
}

function getServerChatFeed(): ChatFeed {
  return EMPTY
}

export function subscribeChatFeed(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishChatFeed(next: ChatFeed): void {
  if (next.plan === feed.plan && next.quick === feed.quick && next.conversationId === feed.conversationId && next.busy === feed.busy) return
  feed = next
  for (const listener of listeners) listener()
}

export function useChatFeed(): ChatFeed {
  return useSyncExternalStore(subscribeChatFeed, getChatFeed, getServerChatFeed)
}

/** Test seam. */
export function resetChatFeed(): void {
  feed = EMPTY
}

/** A batch's identity, so an unchanged batch keeps its reference across streamed renders. */
export function batchKey(batch: QuickHelperBatch | null): string {
  if (!batch) return ''
  const rows = batch.rows.map((r) => [r.status, r.label, r.result?.length ?? 0].join(':')).join('\n')
  return [batch.callId, batch.running ? 'r' : 'd', batch.headline, rows].join('|')
}

/**
 * The main chat's side of the feed: renders nothing. `enabled` false (a bot's
 * page full screen, any chat but the main one): the panel hears nothing of it.
 */
export const ChatFeedPublisher = memo(function ChatFeedPublisher({
  messages,
  conversationId,
  busy = false,
  enabled,
  holdScroll,
}: {
  messages: readonly UIMessage[]
  conversationId: string | null
  /** A reply is on its way or running. */
  busy?: boolean
  enabled: boolean
  /** The chat's way to stop following its bottom (use-stick-to-bottom's stopScroll): a panel toggle holds a chat scrolled up in place. */
  holdScroll?: () => void
}) {
  const rawPlan = enabled ? newestThreadPlan(messages) : null
  const pKey = planKey(rawPlan)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- pKey is what the panel reads of the plan
  const plan = useMemo(() => rawPlan, [pKey])
  const rawBatch = enabled ? quickHelperBatch(messages) : null
  const bKey = batchKey(rawBatch)
  // eslint-disable-next-line react-hooks/exhaustive-deps -- bKey is what the panel reads of the batch
  const quick = useMemo(() => rawBatch, [bKey])
  const id = enabled ? conversationId : null
  const running = enabled && busy
  useEffect(() => {
    publishChatFeed({ plan, quick, conversationId: id, busy: running })
  }, [plan, quick, id, running])
  // Gone (the chat unmounted): the panel hears it went.
  useEffect(() => () => publishChatFeed(EMPTY), [])
  useEffect(() => (holdScroll ? registerChatScrollHold(holdScroll) : undefined), [holdScroll])
  return null
})
