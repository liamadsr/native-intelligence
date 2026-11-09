/**
 * Dragging a page's icon up or down the app rail's bar (./app-rail.tsx), on
 * native pointer events and no render per move. Nothing listens at rest: a
 * press on an icon starts following the pointer, and letting go stops.
 *
 * A press that never travels DRAG_START_PX is no drag: let go, it is the
 * icon's click, as before. Past it the icon dims and one drop line (the bar's
 * own, hidden at rest) stands in the gap where the icon would land; let go,
 * `onDrop` hears the new slot among the bar's icons, and the click that
 * follows the release is swallowed. Esc or a cancelled pointer puts it back.
 */

/** A page's icon in the bar (app-rail.tsx PageButton). */
export const RAIL_PAGE_SELECTOR = '[data-app-rail-page]'
/** The bar's drop line. */
export const RAIL_DROP_LINE_SELECTOR = '[data-app-rail-drop-line]'
/** How far the pointer travels before a press on an icon is a drag. */
export const DRAG_START_PX = 4

/**
 * Which gap (0: before the first icon, n: after the last) a pointer at `y`
 * is nearest, given the icons' centres top to bottom.
 */
export function dropGap(centres: readonly number[], y: number): number {
  let gap = 0
  while (gap < centres.length && y > centres[gap]) gap++
  return gap
}

/** The slot an icon from slot `from` takes, dropped in gap `gap`. */
export function slotForGap(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap
}

/** The click a drag's release makes is no click on the icon: swallowed, if it comes at once. */
function swallowClick(): void {
  const swallow = (e: MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }
  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, true), 0)
}

/** Follow a press on `button` (a bar icon); `onDrop` hears its new slot if it moved. */
export function startRailDrag(button: HTMLElement, pointerId: number, startY: number, onDrop: (to: number) => void): void {
  const bar = button.closest<HTMLElement>('[data-app-rail-pill]')
  const line = bar?.querySelector<HTMLElement>(RAIL_DROP_LINE_SELECTOR)
  if (!bar || !line) return
  const icons = [...bar.querySelectorAll<HTMLElement>(RAIL_PAGE_SELECTOR)]
  const from = icons.indexOf(button)
  if (from < 0 || icons.length < 2) return

  let dragging = false
  /** The pointer is up (or cancelled): its click, if any, comes now. */
  let released = false
  let to = from
  // Measured when the drag starts (the bar can't scroll or change under a captured pointer).
  let rects: DOMRect[] = []
  let centres: number[] = []
  let barTop = 0

  try {
    button.setPointerCapture(pointerId)
  } catch {
    // No capture (an old engine, a test DOM): the window still hears the moves.
  }

  const lineAt = (gap: number): number => {
    if (gap === 0) return rects[0].top - 1
    if (gap === rects.length) return rects[rects.length - 1].bottom + 1
    return (rects[gap - 1].bottom + rects[gap].top) / 2
  }

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    if (!dragging) {
      if (Math.abs(e.clientY - startY) < DRAG_START_PX) return
      dragging = true
      rects = icons.map((el) => el.getBoundingClientRect())
      centres = rects.map((r) => r.top + r.height / 2)
      barTop = bar.getBoundingClientRect().top
      button.setAttribute('data-dragging', '')
    }
    e.preventDefault()
    const gap = dropGap(centres, e.clientY)
    to = slotForGap(from, gap)
    // No line where the icon would land back in its own place.
    if (to === from) line.style.display = ''
    else {
      line.style.top = `${lineAt(gap) - barTop}px`
      line.style.display = 'block'
    }
  }

  const finish = (drop: boolean) => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('keydown', onKey, true)
    line.style.display = ''
    line.style.top = ''
    button.removeAttribute('data-dragging')
    if (!dragging) return
    if (released) swallowClick()
    // Put back with Esc while still pressed: the release to come makes no click either.
    else window.addEventListener('pointerup', swallowClick, { capture: true, once: true })
    if (drop && to !== from) onDrop(to)
  }
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    released = true
    finish(true)
  }
  const onCancel = (e: PointerEvent) => {
    if (e.pointerId !== pointerId) return
    released = true
    finish(false)
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !dragging) return
    e.preventDefault()
    e.stopPropagation()
    finish(false)
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('keydown', onKey, true)
}
