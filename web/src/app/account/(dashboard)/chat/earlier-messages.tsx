'use client'

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { UIMessage } from '@ai-sdk/react'
import { Button } from '@/components/ui/button'
import { HISTORY_PAGE_SIZE } from '@/lib/chat/history-page'
import { lastMessageTime } from '@/lib/chat/message-time'
import { isOpenedCardMessage } from '@/lib/chat-cards/opened-card'
import { ChatMessageList } from './chat-message-list'

/**
 * Earlier messages, a page at a time (A3: a home thread lives for months, so
 * opening one loads only its newest page; GET /api/account/chat-history/[id]
 * with `?limit=&before=`, src/lib/chat/history-page.ts).
 *
 * The pages read here are DISPLAY ONLY: they never join the chat's live
 * `useChat` thread, so they are never sent, never snapshotted into the tab's
 * storage and never trimmed by the live retention cap (message-retention.ts).
 * eve holds the conversation's history server-side, so the model needs none
 * of them.
 *
 * Armed when the chat's open read said older messages remain (`hasMore`), or
 * when the thread it holds is a whole page long (a restored tab, which never
 * asked). Scrolling to the top of the thread loads the page before its oldest
 * message (an IntersectionObserver on a sentinel, px rootMargin only), and a
 * button does the same. A page with nothing new ends it.
 */

const NO_MESSAGES: UIMessage[] = []

/**
 * The time of the last earlier message the pages DRAW (not one the live thread
 * holds, not an opened page): the live list's `dayBefore`, so a day running
 * across the seam gets one line, not two. Null when none says one.
 */
export function earlierDayBefore(older: readonly UIMessage[], liveIds: ReadonlySet<string>): number | null {
  return lastMessageTime(older.filter((m) => !liveIds.has(m.id) && !isOpenedCardMessage(m)))
}

/** One page before `before`, or null on a failed read. */
export async function fetchEarlierPage(
  conversationId: string,
  before: string,
  limit: number = HISTORY_PAGE_SIZE,
): Promise<{ messages: UIMessage[]; hasMore: boolean } | null> {
  try {
    const res = await fetch(
      `/api/account/chat-history/${encodeURIComponent(conversationId)}?limit=${limit}&before=${encodeURIComponent(before)}`,
    )
    if (!res.ok) return null
    const data = (await res.json()) as { messages?: unknown; hasMore?: unknown }
    const messages = Array.isArray(data.messages)
      ? data.messages.filter((m): m is UIMessage => !!m && typeof m === 'object' && typeof (m as UIMessage).id === 'string' && Array.isArray((m as UIMessage).parts))
      : []
    return { messages, hasMore: data.hasMore === true }
  } catch {
    return null
  }
}

export interface EarlierMessagesState {
  /** Older messages read so far, oldest first (never in the live thread). */
  older: UIMessage[]
  /** Whether more may remain before them. */
  canLoad: boolean
  loading: boolean
  load: () => void
  /** The chat's open read of `conversationId` answered: whether older messages remain. */
  arm: (conversationId: string, hasMore: boolean) => void
}

/**
 * The panel's earlier-messages state for `conversationId` (another
 * conversation starts from nothing). `firstMessageId` is the oldest message the live thread holds; the
 * first page is read before it, each next one before the oldest page's first.
 */
export function useEarlierMessages(opts: {
  conversationId: string | null
  firstMessageId: string | null
  liveCount: number
  /**
   * The live thread itself: when retention trims its head (message-retention.ts)
   * while earlier pages are showing, the trimmed messages join those pages, so
   * no gap opens between them and the thread.
   */
  live?: readonly UIMessage[]
}): EarlierMessagesState {
  const { conversationId, firstMessageId, liveCount, live } = opts
  const [state, setState] = useState<{ conversationId: string | null; older: UIMessage[]; armed: boolean | null; done: boolean; loading: boolean }>({
    conversationId,
    older: NO_MESSAGES,
    armed: null,
    done: false,
    loading: false,
  })
  // The state is one conversation's: another (a load, New chat, the first save
  // of a new one) starts from nothing, until it is armed or a page is read.
  const current = state.conversationId === conversationId ? state : { conversationId, older: NO_MESSAGES, armed: null, done: false, loading: false }

  // Unknown (a restored tab never asked): a whole page held means there may be more.
  const armed = current.armed ?? liveCount >= HISTORY_PAGE_SIZE
  const cursor = current.older[0]?.id ?? firstMessageId
  const canLoad = !!conversationId && !!cursor && armed && !current.done

  // Retention trimmed the live thread's head (its first message is now one it
  // held further down): those messages move to the end of the earlier pages.
  // With no earlier page showing there is no gap to fill: the next page is
  // read before the live thread's new first message anyway.
  const prevLiveRef = useRef<{ conversationId: string | null; live: readonly UIMessage[] } | null>(null)
  useEffect(() => {
    const prev = prevLiveRef.current
    prevLiveRef.current = live ? { conversationId, live } : null
    if (!live || !prev || prev.conversationId !== conversationId) return
    const firstNow = live[0]?.id
    if (!firstNow || prev.live[0]?.id === firstNow) return
    const at = prev.live.findIndex((m) => m.id === firstNow)
    if (at <= 0) return
    const trimmed = prev.live.slice(0, at)
    setState((s) => {
      if (s.conversationId !== conversationId || s.older.length === 0) return s
      const have = new Set(s.older.map((m) => m.id))
      const add = trimmed.filter((m) => !have.has(m.id))
      return add.length ? { ...s, older: [...s.older, ...add] } : s
    })
  }, [conversationId, live])

  const ref = useRef({ current, firstMessageId, canLoad })
  useLayoutEffect(() => {
    ref.current = { current, firstMessageId, canLoad }
  })

  const load = useCallback(() => {
    const { current: s, firstMessageId: first, canLoad: may } = ref.current
    const before = s.older[0]?.id ?? first
    if (!may || !s.conversationId || !before || s.loading) return
    const forConversation = s.conversationId
    setState((prev) =>
      prev.conversationId === forConversation
        ? { ...prev, loading: true }
        : { conversationId: forConversation, older: NO_MESSAGES, armed: s.armed, done: false, loading: true },
    )
    void fetchEarlierPage(forConversation, before).then((page) => {
      setState((prev) => {
        if (prev.conversationId !== forConversation) return prev
        if (!page) return { ...prev, loading: false }
        const have = new Set(prev.older.map((m) => m.id))
        const fresh = page.messages.filter((m) => !have.has(m.id))
        return { ...prev, loading: false, older: [...fresh, ...prev.older], done: !page.hasMore || fresh.length === 0 }
      })
    })
  }, [])

  // Keyed by the conversation the read was of: the panel binds to it a render
  // later, and this state is then already its.
  const arm = useCallback((forConversation: string, hasMore: boolean) => {
    setState((prev) =>
      prev.conversationId === forConversation
        ? { ...prev, armed: hasMore }
        : { conversationId: forConversation, older: NO_MESSAGES, armed: hasMore, done: false, loading: false },
    )
  }, [])

  const older = current.older
  const loading = current.loading
  return useMemo(() => ({ older, canLoad, loading, load, arm }), [older, canLoad, loading, load, arm])
}

/**
 * The earlier pages, above the live thread: a sentinel that loads the next
 * page when the top of the thread scrolls into view, and the pages read so
 * far. Keeps the reader's place when a page lands above them.
 */
export function EarlierMessages({
  earlier,
  liveIds,
  userAvatarUrl,
  userInitials,
}: {
  earlier: EarlierMessagesState
  /** The live thread's ids: a page never repeats one. */
  liveIds: ReadonlySet<string>
  userAvatarUrl: string | null
  userInitials: string
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const { canLoad, loading, load } = earlier
  const older = earlier.older.filter((m) => !liveIds.has(m.id))

  // A page lands above the reader: hold their place (WebKit has no scroll
  // anchoring). The place is taken as the load starts, and given back once the
  // page has rendered.
  const anchorRef = useRef<{ height: number; top: number } | null>(null)
  const loadKeepingPlace = useCallback(() => {
    const scroller = sentinelRef.current ? scrollerOf(sentinelRef.current) : null
    if (scroller && !anchorRef.current) anchorRef.current = { height: scroller.scrollHeight, top: scroller.scrollTop }
    load()
  }, [load])
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    if (!anchor || loading || !sentinelRef.current) return
    anchorRef.current = null
    const scroller = scrollerOf(sentinelRef.current)
    if (scroller) scroller.scrollTop = anchor.top + (scroller.scrollHeight - anchor.height)
  }, [loading, older.length])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !canLoad || typeof IntersectionObserver === 'undefined') return
    const root = scrollerOf(el)
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadKeepingPlace()
      },
      { root, rootMargin: '200px 0px 0px 0px' },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [canLoad, loadKeepingPlace, older.length])

  if (!canLoad && older.length === 0) return null
  return (
    <>
      <div ref={sentinelRef} data-earlier-messages className="flex justify-center py-1">
        {canLoad && (
          <Button variant="ghost" size="sm" className="h-7 rounded-full px-3 text-xs text-muted-foreground" onClick={loadKeepingPlace} disabled={loading}>
            {loading ? 'Loading earlier messages…' : 'Load earlier messages'}
          </Button>
        )}
      </div>
      {older.length > 0 && (
        <ChatMessageList messages={older} latestUserMessageId={null} userAvatarUrl={userAvatarUrl} userInitials={userInitials} hideOpenedCards messageTimes />
      )}
    </>
  )
}

/** The nearest scrolling ancestor of `el`, or null (the viewport). */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if (overflow === 'auto' || overflow === 'scroll') return node
  }
  return null
}
