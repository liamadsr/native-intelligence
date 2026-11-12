/**
 * One rule for every full-screen surface (a full-screen card, the live
 * browser's full screen, the long-reply reader): a press anywhere that is not
 * on the card itself, and not on a control, puts it away. The empty space all
 * round counts as outside, the layout wrappers that fill it included (the
 * stage, the column, the row under the card, the browser's veil bands);
 * before, only the layer's own padding did, so a press above the card closed
 * it and one beside or below it did nothing (Liam, 2026-10-09).
 *
 * Surfaces call it from `onPointerDown`, and when it says yes they
 * `preventDefault()` the press before closing: that stops the mousedown that
 * follows from landing on whatever the layer covered (a chat link, the
 * composer) once the layer is gone. A drag that starts inside the card never
 * closes it, wherever it ends: only where the press starts counts.
 *
 * From `md` up beside the app rail the same rule covers the whole app, in one
 * place (isEmptyAppPress, read by one window listener while a card is in
 * front: app/account/(dashboard)/minimized-card-tile.tsx EmptyPressMinimizes): Liam, 11-11,
 * "anytime you click an empty area it does close it … consistent across all
 * the pages". A press under Team chat's sub-nav landed on the chat row behind
 * the card (it stops painting, but still takes presses) and one beside the
 * composer on its dock, and neither did anything; only the card's layer
 * answered. Now any empty part of the app does, and the card minimizes
 * (minimized-card.ts).
 */
import { CARD_FRAME_ATTR } from './card-frame-attr'

/** A control over a full-screen surface that is not a plain button (the Interactive toggle's cluster). */
export const FULL_SCREEN_CONTROL_ATTR = 'data-full-screen-control'

/** Anything a press is meant for: never an "outside" press, even off the card. */
const INTERACTIVE_SELECTOR = [
  'button',
  'a[href]',
  'input',
  'textarea',
  'select',
  'label',
  '[contenteditable=""]',
  '[contenteditable="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="switch"]',
  '[role="checkbox"]',
  '[role="tab"]',
  `[${FULL_SCREEN_CONTROL_ATTR}]`,
].join(', ')

/**
 * A popover that stays mounted but never closes on an outside press (the
 * agent's pending question: only its X / Skip put it away), so it never holds
 * a card open either.
 */
export const FULL_SCREEN_IGNORE_ATTR = 'data-full-screen-ignore'

/**
 * Does this open layer take the press? Not one parked out of sight: a hidden
 * tab keeps its popovers mounted but invisible and inert, and one there must
 * not stop the card in front from closing. Nor one marked to be ignored.
 */
function layerTakesPress(el: Element): boolean {
  if (el.closest(`[inert], [aria-hidden="true"], [${FULL_SCREEN_IGNORE_ATTR}]`)) return false
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true })) return false
  return true
}

/**
 * Is a popover, menu or dialog open over the page? Its own outside press
 * closes it (Radix), and only it: the card behind stays. A tooltip doesn't
 * count, since one lingers after the pointer leaves its button and would
 * otherwise swallow the press.
 */
export function popoverLayerOpen(): boolean {
  if (typeof document === 'undefined') return false
  const open = document.querySelectorAll('[role="dialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]')
  if (Array.from(open).some(layerTakesPress)) return true
  return Array.from(document.querySelectorAll('[data-radix-popper-content-wrapper]')).some(
    (wrapper) => !wrapper.querySelector('[role="tooltip"]') && layerTakesPress(wrapper.firstElementChild ?? wrapper),
  )
}

type PressLike = {
  button: number
  target: EventTarget | null
  currentTarget: EventTarget | null
}

/**
 * Is this press on a full-screen layer outside its card? `frame` is the card
 * itself (its frame: the header and the page). Yes when: the primary button,
 * the press is on the layer's own DOM (React also bubbles a press from a
 * popover portaled out of the card here, which is not outside), not inside
 * the frame, not on a control, and no popover is open.
 */
export function isOutsideCardPress(e: PressLike, frame: Element | null): boolean {
  if (e.button !== 0) return false
  const target = e.target
  if (!(target instanceof Node)) return false
  const layer = e.currentTarget
  if (!(layer instanceof Node) || !layer.contains(target)) return false
  if (frame?.contains(target)) return false
  const el = target instanceof Element ? target : target.parentElement
  const control = el?.closest(INTERACTIVE_SELECTOR)
  if (control && layer.contains(control)) return false
  return !popoverLayerOpen()
}

/**
 * On an element that is the app's own backdrop, with nothing of its own to
 * press (the chat composer's reading column around the composer): a press on
 * it itself is on empty space (isEmptyAppPress).
 */
export const EMPTY_PRESS_ZONE_ATTR = 'data-empty-press-zone'

/** The full-screen card's layer (show-tool-card.tsx). */
const CARD_LAYER_SELECTOR = '[data-chat-card-fullscreen]'

/**
 * The app's backdrop, behind and around a full-screen card: a press landing
 * on one of THESE ELEMENTS ITSELF is on empty space (a press on anything in
 * them, a row, a button, the composer box, a panel's card, lands on that
 * instead). The page and the shell, the chat row (it stops painting under a
 * card, and still takes the presses beside and under the page panel, whose
 * column lets them through to it), the chat strip, the composer's dock and
 * its bottom zone, and what is marked EMPTY_PRESS_ZONE_ATTR.
 */
const EMPTY_ZONE_SELECTOR = [
  'html',
  'body',
  '#ni-shell-root',
  '[data-windows-row]',
  '#ni-chat-strip-slot',
  '[data-chat-composer-dock]',
  '[data-chat-composer]',
  `[${EMPTY_PRESS_ZONE_ATTR}]`,
].join(', ')

/**
 * Is a press on `target` on an EMPTY part of the app, with a card full screen
 * (Liam, 11-11)? Yes on the card's layer outside its frame and its controls
 * (as isOutsideCardPress), and on the app's backdrop itself
 * (EMPTY_ZONE_SELECTOR). Never on the card or anything in it, the page
 * panel's card and rows, the rail and its header, the top bar's controls, the
 * read-aloud capsule (FULL_SCREEN_CONTROL_ATTR), the composer box and what it
 * opens, the minimized card's tile, the right panel's cards, or anything
 * portalled to <body> (a popover, a menu, a dialog, a toast): those are not
 * backdrop elements, nor in the layer. The caller checks the button and that
 * no popover is open (popoverLayerOpen).
 */
export function isEmptyAppPress(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  const layer = target.closest(CARD_LAYER_SELECTOR)
  if (layer) {
    if (layer.querySelector(`[${CARD_FRAME_ATTR}]`)?.contains(target)) return false
    const control = target.closest(INTERACTIVE_SELECTOR)
    return !(control && layer.contains(control))
  }
  return target.matches(EMPTY_ZONE_SELECTOR)
}
