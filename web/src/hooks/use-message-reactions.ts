'use client'

/**
 * The person's reactions on the chat's replies (src/lib/chat/message-reactions.ts),
 * one per bubble (message-bubbles.ts): one store per conversation holds the
 * conversation's reactions, read once with GET /api/account/chat/reactions
 * (the thread the chat restores from the device's own copy predates any made
 * since, here or on another device), and what the person changed in this
 * tab, written with POST, optimistically. Until the read lands, each
 * message's own metadata (`metadata.reactions`) stands.
 *
 * Built like the thumbs' store (use-message-feedback.ts): the panel hands it
 * down in a context whose value changes only with the conversation, and each
 * bubble subscribes to its own reaction (useMessageReaction), so a reaction
 * re-renders that one reply and nothing else. The stores are kept per
 * conversation for the tab's life, so a panel that mounts again (a workspace
 * switch and back, whose tab snapshot predates the reaction) still shows it.
 *
 * A POST the route answers 404 is a reply whose row isn't saved yet (it saves
 * as its turn settles): it is tried again a few times before the reaction is
 * put back and "Try again in a moment" shows.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { parseMessageReaction, parseMessageReactions, reactionOfMetadata, type MessageReaction } from '@/lib/chat/message-reactions'

export interface MessageReactionsStore {
  readonly conversationId: string
  /**
   * A bubble's reaction as the store knows it: its reaction, null for none
   * (taken off here, or none in the conversation's read), or undefined when
   * the store knows nothing of it yet (the message's metadata stands).
   */
  get(messageId: string, bubble: number): MessageReaction | null | undefined
  subscribe(messageId: string, onChange: () => void): () => void
  /** Reads the conversation's reactions; once per store, however often called. */
  load(): Promise<void>
  /** Sets (or, with null, takes off) the reaction on a bubble of an agent message. */
  react(messageId: string, bubble: number, emoji: string | null): Promise<void>
}

const REACTIONS_URL = '/api/account/chat/reactions'
/** The waits before each retry of a reply not saved yet (ms). */
export const REACTION_RETRY_MS = [1200, 2500, 5000] as const

const stores = new Map<string, MessageReactionsStore>()

const keyOf = (messageId: string, bubble: number) => `${messageId}#${bubble}`

function createMessageReactionsStore(conversationId: string): MessageReactionsStore {
  // The conversation's reactions as read (null until the read lands), and what this tab changed, by bubble.
  let loaded: Map<string, MessageReaction> | null = null
  let loading: Promise<void> | null = null
  const changed = new Map<string, MessageReaction | null>()
  // What the server holds for each bubble this tab changed, as far as it knows.
  const confirmed = new Map<string, MessageReaction | null | undefined>()
  // Each bubble's newest write: an older one's answer never undoes a newer click.
  const latestSeq = new Map<string, number>()
  // By message: a reaction re-renders its message's bubbles.
  const listeners = new Map<string, Set<() => void>>()
  let seq = 0

  const get = (messageId: string, bubble: number): MessageReaction | null | undefined => {
    const key = keyOf(messageId, bubble)
    if (changed.has(key)) return changed.get(key)
    return loaded ? (loaded.get(key) ?? null) : undefined
  }
  const emit = (messageId: string) => listeners.get(messageId)?.forEach((fn) => fn())
  const show = (messageId: string, bubble: number, value: MessageReaction | null | undefined) => {
    const key = keyOf(messageId, bubble)
    if (value === undefined) changed.delete(key)
    else changed.set(key, value)
    emit(messageId)
  }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  return {
    conversationId,
    get,
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
          const res = await fetch(`${REACTIONS_URL}?conversationId=${encodeURIComponent(conversationId)}`)
          if (!res.ok) throw new Error(String(res.status))
          const body = (await res.json()) as { reactions?: Record<string, unknown> }
          const read = new Map<string, MessageReaction>()
          for (const [messageId, value] of Object.entries(body.reactions ?? {})) {
            for (const [bubble, reaction] of parseMessageReactions(value)) read.set(keyOf(messageId, bubble), reaction)
          }
          loaded = read
          // Every reply shown reads it again (a click made meanwhile is newer: it stands).
          for (const messageId of listeners.keys()) emit(messageId)
        } catch {
          // The messages' own metadata is a fine fallback; the next mount reads again.
          loading = null
        }
      })()
      return loading
    },
    async react(messageId, bubble, emoji) {
      const key = keyOf(messageId, bubble)
      const mine = ++seq
      latestSeq.set(key, mine)
      if (!confirmed.has(key)) confirmed.set(key, get(messageId, bubble))
      show(messageId, bubble, emoji ? { emoji, at: new Date().toISOString() } : null)
      const current = () => latestSeq.get(key) === mine
      const revert = () => {
        if (current()) show(messageId, bubble, confirmed.get(key))
      }

      for (let attempt = 0; ; attempt++) {
        let res: Response
        try {
          res = await fetch(REACTIONS_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ conversationId, messageId, bubble, emoji }),
          })
        } catch {
          revert()
          toast('Try again in a moment')
          return
        }
        if (!current()) return
        if (res.ok) {
          const body = (await res.json().catch(() => null)) as { reaction?: unknown } | null
          const saved = body && 'reaction' in body ? (body.reaction === null ? null : parseMessageReaction(body.reaction)) : null
          // The server's time stands (it orders the reaction against the next message).
          const value = emoji ? (saved ?? { emoji, at: new Date().toISOString() }) : null
          confirmed.set(key, value)
          if (current()) show(messageId, bubble, value)
          return
        }
        // Not saved yet (its turn is still settling): wait and try again.
        if (res.status === 404 && attempt < REACTION_RETRY_MS.length) {
          await wait(REACTION_RETRY_MS[attempt])
          if (!current()) return
          continue
        }
        revert()
        toast('Try again in a moment')
        return
      }
    },
  }
}

/** The conversation's store (one per conversation for the tab's life), or null without one. */
export function messageReactionsStoreFor(conversationId: string | null): MessageReactionsStore | null {
  if (!conversationId) return null
  let store = stores.get(conversationId)
  if (!store) stores.set(conversationId, (store = createMessageReactionsStore(conversationId)))
  return store
}

/** The reaction shown on a bubble of `message`: what the store knows, else what its metadata says. */
export function shownReaction(store: MessageReactionsStore | null, message: { id: string; metadata?: unknown }, bubble: number): MessageReaction | null {
  const known = store?.get(message.id, bubble)
  return known === undefined ? reactionOfMetadata(message.metadata, bubble) : known
}

const noop = () => () => {}

/** The reaction on a bubble of `message`, re-rendering when it changes. */
export function useMessageReaction(store: MessageReactionsStore | null, message: { id: string; metadata?: unknown }, bubble: number): MessageReaction | null {
  const id = message.id
  const subscribe = useCallback((fn: () => void) => (store ? store.subscribe(id, fn) : noop()), [store, id])
  const known = useSyncExternalStore(
    subscribe,
    () => store?.get(id, bubble),
    () => undefined,
  )
  return known === undefined ? reactionOfMetadata(message.metadata, bubble) : known
}
