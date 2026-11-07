'use client'

/**
 * Thumbs on the chat's replies (the evals flywheel, docs/plans/always-on-agent.md
 * §8): one store per conversation holds the person's ratings, read once with
 * GET /api/account/chat/feedback and changed optimistically by POST.
 *
 * Built for the message list's memoization (chat-message-list.tsx): ChatPanel
 * hands the store down through a context whose value changes only with the
 * conversation, and each reply's thumbs subscribe to their own message's
 * rating (useMessageRating), so a click re-renders that one reply's buttons
 * and nothing else.
 *
 * A POST the route refuses with 404 (the reply isn't saved yet, or the
 * conversation isn't the person's) puts the rating back and says "Try again
 * in a moment"; 409 means a reviewer already promoted or exported it: the
 * stored rating stays, so the thumbs show it, and say "Already reviewed".
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { sliceStart } from '@/lib/evals/flywheel/bytes'
import type { NudgeReason } from '@/lib/evals/flywheel/types'

export type MessageRating = 'up' | 'down'

export interface MessageFeedbackStore {
  readonly conversationId: string
  /** The rating shown for a message right now (optimistic), or null. */
  get(messageId: string): MessageRating | null
  subscribe(messageId: string, onChange: () => void): () => void
  /** Reads the conversation's ratings; once per store, however often called. */
  load(): Promise<void>
  /**
   * Sets (or, with null, clears) a rating; `reason` rides a thumbs-down, and
   * so does `nudgeReason`, a live nudge's quick reason chip.
   */
  rate(messageId: string, rating: MessageRating | null, reason?: string, nudgeReason?: NudgeReason): Promise<void>
}

const FEEDBACK_URL = '/api/account/chat/feedback'
/** The person's reason, as the route takes it. */
export const FEEDBACK_REASON_MAX = 500

function isRating(v: unknown): v is MessageRating {
  return v === 'up' || v === 'down'
}

export function createMessageFeedbackStore(conversationId: string): MessageFeedbackStore {
  // What the server holds, as far as this store knows, and what the thumbs show.
  const confirmed = new Map<string, MessageRating>()
  const shown = new Map<string, MessageRating>()
  // Each message's newest POST: an older one's answer never undoes a newer click.
  const latestSeq = new Map<string, number>()
  const listeners = new Map<string, Set<() => void>>()
  let seq = 0
  let loading: Promise<void> | null = null

  const emit = (messageId: string) => {
    listeners.get(messageId)?.forEach((fn) => fn())
  }
  const setIn = (map: Map<string, MessageRating>, messageId: string, rating: MessageRating | null) => {
    if (rating) map.set(messageId, rating)
    else map.delete(messageId)
  }
  const show = (messageId: string, rating: MessageRating | null) => {
    if ((shown.get(messageId) ?? null) === rating) return
    setIn(shown, messageId, rating)
    emit(messageId)
  }

  return {
    conversationId,
    get: (messageId) => shown.get(messageId) ?? null,
    subscribe(messageId, onChange) {
      let set = listeners.get(messageId)
      if (!set) listeners.set(messageId, (set = new Set()))
      set.add(onChange)
      return () => {
        set.delete(onChange)
        if (set.size === 0) listeners.delete(messageId)
      }
    },
    load() {
      if (loading) return loading
      loading = (async () => {
        try {
          const res = await fetch(`${FEEDBACK_URL}?conversationId=${encodeURIComponent(conversationId)}`)
          if (!res.ok) throw new Error(String(res.status))
          const body = (await res.json()) as { ratings?: Record<string, unknown> }
          for (const [messageId, rating] of Object.entries(body.ratings ?? {})) {
            if (!isRating(rating)) continue
            confirmed.set(messageId, rating)
            // A click made while this read was in flight is newer: it stays.
            if (!latestSeq.has(messageId)) show(messageId, rating)
          }
        } catch {
          // No ratings shown is a fine fallback; the next mount reads again.
          loading = null
        }
      })()
      return loading
    },
    async rate(messageId, rating, reason, nudgeReason) {
      const mine = ++seq
      latestSeq.set(messageId, mine)
      show(messageId, rating)

      const settle = (serverRating: MessageRating | null) => {
        setIn(confirmed, messageId, serverRating)
        if (latestSeq.get(messageId) === mine) show(messageId, serverRating)
      }
      const revert = () => {
        if (latestSeq.get(messageId) === mine) show(messageId, confirmed.get(messageId) ?? null)
      }

      const clipped = reason ? sliceStart(reason.trim(), FEEDBACK_REASON_MAX) : undefined
      let res: Response
      try {
        res = await fetch(FEEDBACK_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId,
            messageId,
            rating,
            ...(clipped ? { reason: clipped } : {}),
            ...(nudgeReason && rating === 'down' ? { nudge_reason: nudgeReason } : {}),
          }),
        })
      } catch {
        revert()
        toast('Try again in a moment')
        return
      }

      const body = (await res.json().catch(() => null)) as { rating?: unknown; details?: { rating?: unknown } } | null
      if (res.ok) {
        settle(body && 'rating' in body && (isRating(body.rating) || body.rating === null) ? body.rating : rating)
        return
      }
      if (res.status === 409) {
        // The reviewed rating stays where it was; the route names it (details.rating).
        const kept = body?.details?.rating
        if (isRating(kept) || kept === null) settle(kept)
        else revert()
        toast('Already reviewed')
        return
      }
      revert()
      toast('Try again in a moment')
    },
  }
}

/**
 * One store per conversation for the page's life, so a remounted chat (a tab
 * switch, a reload of the panel) reads its ratings once. Bounded: the oldest
 * conversation's store goes first.
 */
const STORE_CACHE_MAX = 20
const stores = new Map<string, MessageFeedbackStore>()

export function messageFeedbackStoreFor(conversationId: string): MessageFeedbackStore {
  let store = stores.get(conversationId)
  if (store) return store
  store = createMessageFeedbackStore(conversationId)
  stores.set(conversationId, store)
  while (stores.size > STORE_CACHE_MAX) {
    const oldest = stores.keys().next().value
    if (oldest === undefined) break
    stores.delete(oldest)
  }
  return store
}

export function __resetMessageFeedbackForTests(): void {
  stores.clear()
}

/** The conversation's ratings store (read once), or null with no conversation yet. */
export function useMessageFeedback(conversationId: string | null | undefined): MessageFeedbackStore | null {
  const store = useMemo(() => (conversationId ? messageFeedbackStoreFor(conversationId) : null), [conversationId])
  useEffect(() => {
    void store?.load()
  }, [store])
  return store
}

const NO_SUBSCRIBE = () => () => {}

/** One message's rating; re-renders only when that message's rating changes. */
export function useMessageRating(store: MessageFeedbackStore | null, messageId: string): MessageRating | null {
  const subscribe = useMemo(
    () => (store ? (onChange: () => void) => store.subscribe(messageId, onChange) : NO_SUBSCRIBE),
    [store, messageId],
  )
  return useSyncExternalStore(
    subscribe,
    () => store?.get(messageId) ?? null,
    () => null,
  )
}
