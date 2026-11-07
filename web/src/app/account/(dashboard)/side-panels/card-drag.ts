/**
 * Dragging a side panel card by its ⋮⋮ handle (card-heading.tsx), on native
 * pointer events and no render per move: the dragged card follows the pointer
 * on its own `translate` (lifted over its siblings), and each card it passes
 * steps aside by its height on theirs, so the gap left open is where it will
 * land.
 *
 * Dropped, the inline styles go together with their transition (so nothing
 * animates back) and the new order goes to the store once: the column
 * re-renders in that order, React moving the keyed cards (no remounts). A
 * press that never travels DRAG_START_PX is no drag: let go, it is a tap
 * (`onTap`), which the row takes as a press on itself (card-heading.tsx).
 */

/** A card in the panel's column (side-panels.tsx PanelCard). */
export const CARD_SELECTOR = '[data-side-panel-card]'
/** How far the pointer travels before a press on the handle is a drag. */
export const DRAG_START_PX = 4
/** How long a passed card takes to step aside (none under reduced motion). */
const STEP_MS = 150

/**
 * Where a card dragged `dy` px from slot `from` would land, given the cards'
 * centres where they stand (top to bottom): at or past a neighbour's centre,
 * it takes that neighbour's slot (at, so the end slots are reachable with the
 * drag kept inside the column).
 */
export function dropIndex(centres: readonly number[], from: number, dy: number): number {
  const centre = centres[from] + dy
  let to = from
  while (to < centres.length - 1 && centre >= centres[to + 1]) to++
  while (to > 0 && centre <= centres[to - 1]) to--
  return to
}

/**
 * Start following a press on a card's handle; `onDrop` hears the new slot
 * among the column's cards, if it moved, and `onTap` a press let go before it
 * became a drag.
 */
export function startCardDrag(
  handle: HTMLElement,
  pointerId: number,
  startY: number,
  onDrop: (to: number) => void,
  onTap?: () => void,
): void {
  const card = handle.closest<HTMLElement>(CARD_SELECTOR)
  const list = card?.parentElement
  if (!card || !list) return
  const cards = [...list.children].filter((el): el is HTMLElement => el instanceof HTMLElement && el.matches(CARD_SELECTOR))
  const from = cards.indexOf(card)
  if (from < 0 || cards.length < 2) return

  const rects = cards.map((c) => c.getBoundingClientRect())
  const centres = rects.map((r) => r.top + r.height / 2)
  const gap = Math.max(0, rects[1].top - rects[0].bottom)
  const step = rects[from].height + gap
  const last = rects[rects.length - 1]
  // Drawn inside the column: from the first card's top to the last one's bottom.
  const minDy = rects[0].top - rects[from].top
  const maxDy = last.bottom - rects[from].bottom
  // Placed by where the pointer takes its centre, as far as those edges: a
  // tall (open) card still reaches the end slots past a short neighbour.
  const minReach = rects[0].top - centres[from]
  const maxReach = last.bottom - centres[from]
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const shifts = cards.map(() => 0)
  let dragging = false
  let to = from

  try {
    handle.setPointerCapture(pointerId)
  } catch {
    // No capture (an old engine, a test DOM): the window still hears the moves.
  }

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    const raw = e.clientY - startY
    if (!dragging) {
      if (Math.abs(raw) < DRAG_START_PX) return
      dragging = true
      card.setAttribute('data-dragging', '')
      card.style.zIndex = '1'
      if (!reduce) for (const c of cards) if (c !== card) c.style.transition = `translate ${STEP_MS}ms ease-out`
    }
    e.preventDefault()
    card.style.translate = `0 ${Math.max(minDy, Math.min(maxDy, raw))}px`
    const next = dropIndex(centres, from, Math.max(minReach, Math.min(maxReach, raw)))
    if (next === to) return
    to = next
    cards.forEach((c, i) => {
      if (i === from) return
      const shift = from < i && i <= to ? -step : to <= i && i < from ? step : 0
      if (shift === shifts[i]) return
      shifts[i] = shift
      c.style.translate = shift ? `0 ${shift}px` : ''
    })
  }

  const onEnd = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onEnd)
    window.removeEventListener('pointercancel', onEnd)
    // Styles and transitions cleared in one go: nothing animates back before the new order lands.
    for (const c of cards) {
      c.style.translate = ''
      c.style.transition = ''
      c.style.zIndex = ''
      c.removeAttribute('data-dragging')
    }
    if (e.type !== 'pointerup') return
    if (!dragging) onTap?.()
    else if (to !== from) onDrop(to)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onEnd)
  window.addEventListener('pointercancel', onEnd)
}
