/**
 * What moves WITH a card's flight to and from its tile (./minimized-card.ts,
 * lib/chat/tile-flight.ts), so opening and closing read as one motion (Liam,
 * 11-11: "it's not a fliker now but the panel is transparent and you see
 * thorugh it and looks broken, the over all transition even with the sub-nav
 * needs to be updated to be smoother the entire open sequence needs to happen
 * smoother").
 *
 * Why the window looked see-through: its flying copy wears the window's own
 * glass (70% of the surface over a blur), which reads solid over the app's
 * bare backdrop, where an open card sits (the chat under it stops painting,
 * front-card.ts FRONT_CARD_ATTR), and see-through over anything else. Growing
 * out of the tile it flew over the chat, still painted until the card was
 * full screen again, for the whole flight and the page's render after it. So
 * the scene changes hands with the flight, never after it:
 *
 *   Opening   home leaves as the window grows (homeLeaves: the chat, the top
 *             bar and what else an open card hides fade out in
 *             SCENE_LEAVE_MS, before the window is over them), and so does
 *             home's panel when the page brings its own (panelLeaves); the
 *             page's sub-nav arrives as the window lands (the card full
 *             screen from the flight's hand-over on: page-panel-frame.tsx's
 *             entrance).
 *   Closing   the page's sub-nav leaves with the window (panelLeaves); home
 *             arrives as the window lands (homeArrives: the same things fade
 *             in over SCENE_ARRIVE_MS from the commit the card leaves in,
 *             home's panel making its entrance in that same commit).
 *
 * Opacity only, on what is there already (the compositor's; no layout, no
 * React state): each fade is given back the moment the app's own rules agree
 * with it (the card in front: hidden by CSS; the panel swapped out), or after
 * SCENE_GIVE_UP_MS when they never do (a card that was no more), so nothing
 * stays faded. Nothing without the Web Animations API or under reduced
 * motion.
 *
 * Client-safe: no server imports.
 */
import { canFly } from '@/lib/chat/card-reply-flight'
import { PALETTE_ENTRANCE_EASING } from '@/lib/motion/palette-entrance'
import { frontCard, subscribeFrontCard } from './front-card'

/**
 * Home (and a page's panel) leaving, ms, on the window's own curve (the ⌘K
 * palette's fast out: a tenth left a third of the way in), so it is gone
 * before the growing window is over it.
 */
export const SCENE_LEAVE_MS = 110
const SCENE_LEAVE_EASING = PALETTE_ENTRANCE_EASING
/** Home arriving as the window lands, ms. */
export const SCENE_ARRIVE_MS = 200
/** A fade nothing took over is given back after this, ms. */
export const SCENE_GIVE_UP_MS = 1500

/**
 * What stops painting under a full-screen card beside the rail (tailwind.css,
 * the `html[data-app-rail][data-card-front]` rules; kept in step by
 * flight-scene.test.ts): the chat row's children but the page panel, the
 * chat strip and the top bar's frosted strip, the top bar, and in the strip
 * the thread and the capture's dock. The composer and both frosted strips
 * stay, so the blur never goes and comes back (Liam, 11-11: "you make that
 * stay the whole time so that way it doesn't go away and come back").
 */
export const UNDER_CARD_SELECTORS = [
  '[data-windows-row] > :not([data-page-panel]):not(#ni-chat-strip-slot):not([data-fading-blur])',
  '[data-shell-top-bar]',
  '#ni-chat-strip-slot [data-chat-thread-stage]',
  '#ni-chat-strip-slot [data-live-capture-dock]',
] as const

/** The page panel on screen (page-panel-frame.tsx: the frame whose mode is not `off`). */
const SHOWN_PANEL_SELECTOR = '[data-page-panel][data-page-panel-mode]:not([data-page-panel-mode="off"])'

const noop = () => {}

function underCard(): HTMLElement[] {
  if (typeof document === 'undefined') return []
  return [...document.querySelectorAll<HTMLElement>(UNDER_CARD_SELECTORS.join(', '))]
}

function fade(els: HTMLElement[], keyframes: Keyframe[], options: KeyframeAnimationOptions): Animation[] {
  const out: Animation[] = []
  for (const el of els) {
    if (typeof el.animate !== 'function') continue
    out.push(el.animate(keyframes, options))
  }
  return out
}

/**
 * Opening: what an open card hides fades out now, ahead of the window growing
 * over it, and stays out until the card is in front (its own CSS hides it
 * from then; the fade is let go in that same commit). Returns the fade's
 * release (a flight that was cancelled: home shows again at once).
 */
export function homeLeaves(): () => void {
  if (!canFly() || frontCard()) return noop
  const fades = fade(underCard(), [{ opacity: 0, offset: 1 }], { duration: SCENE_LEAVE_MS, easing: SCENE_LEAVE_EASING, fill: 'forwards' })
  if (!fades.length) return noop
  let done = false
  const release = () => {
    if (done) return
    done = true
    off()
    clearTimeout(timer)
    for (const a of fades) a.cancel()
  }
  // The card in front: FRONT_CARD_ATTR is on <html> before this is told, so letting go shows nothing.
  const off = subscribeFrontCard(() => frontCard() && release())
  const timer = setTimeout(release, SCENE_GIVE_UP_MS)
  return release
}

/**
 * Closing: what the open card hid fades in, from the commit the card leaves
 * full screen in (it is hidden by CSS until then, so there is nothing to
 * fade before; told by front-card.ts in that commit, before its paint), or
 * from now when none is in front. `delay` holds it clear a moment longer
 * (a card that left before its flight began: the copy is still over the
 * chat). Returns its release.
 */
export function homeArrives({ delay = 0 }: { delay?: number } = {}): () => void {
  if (!canFly()) return noop
  let fades: Animation[] = []
  let done = false
  const start = () => {
    off()
    // From clear to each one's own opacity (the keyframe left out), so nothing is forced visible.
    fades = fade(underCard(), [{ opacity: 0, offset: 0 }], { duration: SCENE_ARRIVE_MS, delay, easing: 'ease-out', fill: 'backwards' })
  }
  const release = () => {
    if (done) return
    done = true
    off()
    clearTimeout(timer)
    for (const a of fades) a.cancel()
  }
  let off = noop
  if (frontCard()) off = subscribeFrontCard(() => !frontCard() && !done && start())
  else start()
  // Its fades end by themselves (nothing kept after them); the wait for the card to leave does not.
  const timer = setTimeout(() => !fades.length && release(), SCENE_GIVE_UP_MS)
  return release
}

/** The page whose panel is on screen (`home`, a rail page's id), or null with none. */
export function pagePanelOnScreen(): string | null {
  if (typeof document === 'undefined') return null
  return document.querySelector(SHOWN_PANEL_SELECTOR)?.getAttribute('data-page-panel') ?? null
}

/**
 * The page panel on screen is about to change hands (the place changes with
 * the card: home's Recent for a page's sub-nav as it opens, the sub-nav for
 * Recent as it is minimized): its card fades out now, with the window's
 * first move, so the next one's entrance (page-panel-frame.tsx) is the only
 * thing that happens when the place does change. Let go the moment its frame
 * is off (the swap), or after SCENE_GIVE_UP_MS when it never was (it shows
 * again). Returns its release.
 */
export function panelLeaves(): () => void {
  if (!canFly() || typeof document === 'undefined') return noop
  const frame = document.querySelector<HTMLElement>(SHOWN_PANEL_SELECTOR)
  const card = frame?.querySelector<HTMLElement>('[data-page-panel-card]')
  if (!frame || !card || typeof card.animate !== 'function') return noop
  const out = card.animate([{ opacity: 0, offset: 1 }], { duration: SCENE_LEAVE_MS, easing: SCENE_LEAVE_EASING, fill: 'forwards' })
  let done = false
  const release = () => {
    if (done) return
    done = true
    watch?.disconnect()
    clearTimeout(timer)
    out.cancel()
  }
  const watch =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          if (frame.getAttribute('data-page-panel-mode') === 'off' || !frame.isConnected) release()
        })
      : null
  watch?.observe(frame, { attributes: true, attributeFilter: ['data-page-panel-mode'] })
  const timer = setTimeout(release, SCENE_GIVE_UP_MS)
  return release
}
