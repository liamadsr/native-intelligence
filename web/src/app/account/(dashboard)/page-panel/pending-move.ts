'use client'

/**
 * A press in a page's sub-nav before its card has said where it is (Liam,
 * 11-11: "it's only on first load that's it's a bit laggy"): the sub-nav
 * shows its rows at once, before the card has loaded (page-panel.tsx), so a
 * row can be pressed before there is a card to move. The move waits for the
 * card: the latest one asked for runs once the card says where it is, read
 * against that card (so "already there, nothing more" still holds). One at
 * most; the page left before then, it is dropped.
 *
 * Flat cost: a ref and one effect; no timer.
 */
import { useCallback, useEffect, useRef } from 'react'

/** `run(move)`: the move on the card now, or on the card when it comes. */
export function usePendingMove<C>(card: C | null, active: boolean): (move: (card: C) => void) => void {
  const pending = useRef<((card: C) => void) | null>(null)
  const cardRef = useRef(card)
  cardRef.current = card
  useEffect(() => {
    if (!active) {
      pending.current = null
      return
    }
    const move = pending.current
    if (!card || !move) return
    pending.current = null
    move(card)
  }, [card, active])
  return useCallback((move: (card: C) => void) => {
    const now = cardRef.current
    if (now) move(now)
    else pending.current = move
  }, [])
}
