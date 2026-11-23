/**
 * Which row of a hub's list (home's Recent; docs/plans/hub-panels.md) is the
 * one open in front, when the card in front can't say so itself: a team
 * chat card names no record (recents-model.ts frontRecentKey is null for
 * it), and flipping from one channel to the next moves that one card rather
 * than opening another (open-card.ts cardForTarget: one team chat card).
 *
 * The list notes the row it opens (`note`). The row is lit while the card
 * that came in front for it is there: the next card in front within
 * PRESS_COUNTS_MS of the open, or, when none came (the card in front was
 * moved in place), the card in front at the open. Any later card in front
 * lights nothing.
 *
 * Pure (openedRowStep) plus a small hook; client-safe.
 */
import { useCallback, useState } from 'react'
import { PRESS_COUNTS_MS } from '../rail/selected-place'

export interface OpenedRow {
  key: string
  /** The card in front for it (or, until settled, the one in front at the open). */
  frontId: string | null
  /** When it was opened (ms, the page's clock). */
  at: number
  /** Its card is known: no later card in front is taken for it. */
  settled: boolean
}

/** The entry once the card in front is `frontId` at `now`. */
export function openedRowStep(entry: OpenedRow | null, frontId: string | null, now: number): OpenedRow | null {
  if (!entry || entry.settled || frontId === entry.frontId) return entry
  // A card came in front: its card, if soon enough after the open; else the open moved the card in place.
  if (frontId !== null && now - entry.at <= PRESS_COUNTS_MS) return { ...entry, frontId, settled: true }
  return { ...entry, settled: true }
}

/** The opened row's key while its card is in front, else null. */
export function openedRowLit(entry: OpenedRow | null, frontId: string | null): string | null {
  return entry && frontId !== null && frontId === entry.frontId ? entry.key : null
}

const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

/** [the lit key, note(key) for a row just opened]. */
export function useOpenedRow(frontId: string | null): [string | null, (key: string) => void] {
  const [entry, setEntry] = useState<OpenedRow | null>(null)
  const next = openedRowStep(entry, frontId, clock())
  if (next !== entry) setEntry(next)
  const note = useCallback((key: string) => setEntry({ key, frontId, at: clock(), settled: false }), [frontId])
  return [openedRowLit(next, frontId), note]
}

/** How long a flip from the keys holds the focus in the list (the card it opens may take it as it mounts). */
export const KEEP_FOCUS_MS = 4000

/**
 * After a flip from the keys (J / K in a hub's list), keep the focus on `el`
 * a moment: the card it opened takes the focus as it mounts (a document's
 * editor, a conversation's composer), and the next J would then be typed
 * into it instead of flipping again (seen in the browser, 11-23). Any press
 * of the person's own (a pointer down) ends it at once.
 */
export function keepFocusAfterFlip(el: HTMLElement, ms: number = KEEP_FOCUS_MS): () => void {
  if (typeof document === 'undefined') return () => {}
  const home = el.closest('[data-page-panel]') ?? el
  const onFocusIn = (e: FocusEvent) => {
    if (!el.isConnected) return stop()
    if (e.target instanceof Node && home.contains(e.target)) return
    el.focus({ preventScroll: true })
  }
  const timer = setTimeout(() => stop(), ms)
  function stop() {
    clearTimeout(timer)
    document.removeEventListener('focusin', onFocusIn, true)
    window.removeEventListener('pointerdown', stop, true)
  }
  document.addEventListener('focusin', onFocusIn, true)
  window.addEventListener('pointerdown', stop, true)
  return stop
}
