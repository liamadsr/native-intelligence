/**
 * Which For you card waits as the main chat's Reply chip now (card-reply.ts),
 * or which message of the thread does (message-reply.ts: the same blur behind
 * it, Liam 10-20: "when you reply to a message the background of the app
 * should get blurred out"),
 * for what stands around the chat: everything but the composer and the For
 * you column goes soft behind the For you focus view's blur (the shell's
 * CardReplyBackdrop, card-reply-chip.tsx), where a press takes the chip off,
 * and the column shows that card as the one in hand (column-compact-card.tsx).
 * The chat panel sets it while its chip is up, with how to take the chip off.
 * One value: when it changes, only what reads a different answer re-renders.
 *
 * CARD_REPLY_FOCUS_ATTR on <html> meanwhile: the composer and the column sit
 * deep in the content row and the chat strip, stacking contexts under the top
 * bar, so while it's set those stop forming them (dashboard-shell.tsx) and the
 * two are raised over the blur, which is over the top bar (as
 * CAPTURE_CARD_UP_ATTR lifts the composer's rising cards). Keyed off <html>,
 * not `:has()`, so the streaming chat never pays for the selector.
 */
import { useSyncExternalStore } from 'react'
import type { CardReplyRef } from './card-reply'

/** Set on <html> while a card waits as the chat's Reply chip (see above). */
export const CARD_REPLY_FOCUS_ATTR = 'data-card-reply-focus'

let current: string | null = null
let dismiss: (() => void) | null = null
const listeners = new Set<() => void>()

const keyOf = (kind: string, id: string) => `${kind}:${id}`

/** The chip's card and how to take it off, or null once it's gone (sent or taken off). */
export function setReplyingCard(card: Pick<CardReplyRef, 'kind' | 'id'> | null, onDismiss?: () => void): void {
  setReplyFocus(card ? keyOf(card.kind, card.id) : null, onDismiss)
}

/**
 * The chip by a key of its own (a card's `kind:id`, a message's
 * `message:<id>`: message-reply.ts messageReplyFlightKey) and how to take it
 * off, or null once it's gone.
 */
export function setReplyFocus(next: string | null, onDismiss?: () => void): void {
  dismiss = next ? (onDismiss ?? null) : null
  if (next === current) return
  current = next
  if (typeof document !== 'undefined') document.documentElement.toggleAttribute(CARD_REPLY_FOCUS_ATTR, next !== null)
  for (const l of listeners) l()
}

/** Take the chip off (a press on something gone soft behind it). */
export function dismissReplyingCard(): void {
  dismiss?.()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** This card waits as the chat's Reply chip. */
export function useIsReplyingCard(card: Pick<CardReplyRef, 'kind' | 'id'>): boolean {
  const key = keyOf(card.kind, card.id)
  return useSyncExternalStore(
    subscribe,
    () => current === key,
    () => false,
  )
}

/** A card waits as the chat's Reply chip: everything but the composer and the column goes soft. */
export function useReplyFocus(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => current !== null,
    () => false,
  )
}
