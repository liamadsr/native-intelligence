/**
 * A press on the window's drag surface while something would put a card away
 * on an empty press (Liam, 11-26: "if I click and hold to move the app it
 * should also work without first going to home, then I have to grab it
 * again"). A press that moves the window keeps the card; a plain click there
 * still puts it away, as anywhere empty.
 *
 * Why not at the press, as the rest of the app's empty presses: in the
 * desktop app Tauri starts the window's drag from the `mousedown` on an
 * element carrying `data-tauri-drag-region` itself (tauri 2.10's drag script:
 * a first press calls `start_dragging`, a double one zooms, on macOS at the
 * release). An empty press prevented at `pointerdown` has no mousedown after
 * it, so no drag ever started, and the card was gone already: the person had
 * to press again. So a press on a drag region is never prevented and puts
 * nothing away when it lands; it is followed to its end instead.
 *
 * What fires once the drag starts is the OS's, not the page's: the window's
 * drag loop owns the mouse, so the release may never reach the page, nor any
 * move while it is held. So the end is the first of: the release (heard), a
 * move with the button up (the release was not heard), a cancel or another
 * press (neither: nothing put away). It was a click when the window did not
 * move (the window's own move events, Tauri's `onMoved`, counted from the
 * first such press on) and the pointer is where it was pressed, in screen
 * pixels: in a drag the window moves with the pointer, so the pointer's
 * place in the page never changes and only the screen sees it move. Until
 * the window's moves are heard (the first moments of the app, or a refusal),
 * the screen alone decides.
 *
 * Only in the desktop app: in a browser a press on a drag region attribute
 * (it is on plain rows there too) is an empty press like any other, at once.
 *
 * Flat cost: one move listener for the app's life once a card is in front,
 * a counter bump per window move; per press on a drag region, four window
 * listeners until it ends.
 */
import { isDesktopApp } from '@/lib/platform'

/** What Tauri's drag script answers (on the press's own target only, never a parent's). */
export const DRAG_REGION_ATTR = 'data-tauri-drag-region'

/** A release this close to the press, in screen px, is a click (a hand's tremble). */
export const CLICK_SLOP_PX = 4
/** Where the release was not heard and the window's moves are not known: the first move after it may have gone this far. */
export const UNHEARD_SLOP_PX = 12

/** Is a press on `target` a press on the window's drag surface (the desktop app only)? */
export function isWindowDragPress(target: EventTarget | null): boolean {
  if (!isDesktopApp() || !(target instanceof Element)) return false
  const value = target.getAttribute(DRAG_REGION_ATTR)
  return value !== null && value !== 'false'
}

/** How a press on a drag region ended. */
export interface DragPressEnd {
  /** The release reached the page (else the end is a move with the button up). */
  heard: boolean
  /** The pointer went past CLICK_SLOP_PX while held (as far as the page heard). */
  dragged: boolean
  /** Screen px from the press to the end. */
  distance: number
  /** The window moved since the press; null where its moves are not heard. */
  windowMoved: boolean | null
}

/** Was it a click (put the card away) rather than the window's move (keep it)? */
export function dragPressIsClick(end: DragPressEnd): boolean {
  if (end.windowMoved || end.dragged) return false
  if (end.heard) return end.distance <= CLICK_SLOP_PX
  // The window's drag loop took the release, and the window did not move: a click held a moment.
  if (end.windowMoved === false) return true
  return end.distance <= UNHEARD_SLOP_PX
}

let moves = 0
let watching: 'off' | 'pending' | 'on' = 'off'

/** Count the window's moves from now on (once; the desktop app only). */
export function watchWindowMoves(): void {
  if (watching !== 'off' || !isDesktopApp()) return
  watching = 'pending'
  import('@tauri-apps/api/window')
    .then(({ getCurrentWindow }) =>
      getCurrentWindow().onMoved(() => {
        moves += 1
      }),
    )
    .then(
      () => {
        watching = 'on'
      },
      () => {
        watching = 'off'
      },
    )
}

function movedSince(from: number): boolean | null {
  if (moves !== from) return true
  return watching === 'on' ? false : null
}

/** The presses being followed, so a second handler of the same press (a layer under the window's rule) leaves it be. */
const followed = new WeakSet<Event>()

/** Is this press followed already (followWindowDragPress)? */
export function isFollowedDragPress(e: Event): boolean {
  return followed.has(e)
}

/**
 * Follow a press on a drag region to its end; `onClick` when it was a click
 * (dragPressIsClick). The caller neither prevents the press nor puts anything
 * away at it. Returns a stop, for the caller's cleanup or its next press.
 */
export function followWindowDragPress(e: PointerEvent, onClick: () => void): () => void {
  watchWindowMoves()
  followed.add(e)
  const x = e.screenX
  const y = e.screenY
  const from = moves
  let dragged = false
  let over = false
  const distance = (ev: MouseEvent) => Math.hypot(ev.screenX - x, ev.screenY - y)
  const stop = () => {
    if (over) return
    over = true
    window.removeEventListener('pointermove', onMove, true)
    window.removeEventListener('pointerup', onUp, true)
    window.removeEventListener('pointercancel', stop, true)
    window.removeEventListener('pointerdown', onDown, true)
  }
  const end = (ev: MouseEvent, heard: boolean) => {
    stop()
    if (dragPressIsClick({ heard, dragged, distance: distance(ev), windowMoved: movedSince(from) })) onClick()
  }
  function onMove(ev: PointerEvent) {
    if (ev.buttons & 1) {
      if (distance(ev) > CLICK_SLOP_PX) dragged = true
      return
    }
    end(ev, false)
  }
  function onUp(ev: PointerEvent) {
    if (ev.button === 0) end(ev, true)
  }
  // Another press before this one's end was heard (a double click's second, Tauri zooming): nothing put away.
  function onDown(ev: PointerEvent) {
    if (ev !== e) stop()
  }
  window.addEventListener('pointermove', onMove, true)
  window.addEventListener('pointerup', onUp, true)
  window.addEventListener('pointercancel', stop, true)
  window.addEventListener('pointerdown', onDown, true)
  return stop
}

export function __resetWindowDragPressForTests(): void {
  moves = 0
  watching = 'off'
}
