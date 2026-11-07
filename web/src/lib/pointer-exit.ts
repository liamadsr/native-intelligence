/**
 * "The pointer is no longer over this page" — one signal for every hover UI.
 *
 * Hover popups in the app (tooltips, the liquid pills' hover cards) decide
 * they've been left by watching `pointermove`. That works while the pointer
 * stays over the page, but when it leaves the webview entirely — off a window
 * edge, up into the macOS title-bar strip of the desktop app, onto another
 * window (the HUD, a native dialog), or the app loses focus — WKWebView (and
 * browsers) send no further moves, so the popup waits forever and stays open
 * until the next click. This module turns those exits into one callback:
 *
 * - `mouseout` whose `relatedTarget` is null: the pointer left the document
 *   (or went into a cross-origin frame, which is just as far from our hover
 *   targets);
 * - window `blur`: another window or app took focus;
 * - `visibilitychange` to hidden: the page was hidden or the window minimized.
 *
 * One set of document/window listeners is installed lazily and shared by all
 * subscribers; it is removed again when the last one unsubscribes.
 */

type Listener = () => void

const listeners = new Set<Listener>()
let teardown: (() => void) | null = null

function notify() {
  // Copy: a listener may unsubscribe itself (or others) while closing.
  for (const listener of Array.from(listeners)) {
    try {
      listener()
    } catch (err) {
      console.error('[pointer-exit] listener failed', err)
    }
  }
}

function install() {
  const onMouseOut = (event: MouseEvent) => {
    if (event.relatedTarget == null) notify()
  }
  const onBlur = () => notify()
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') notify()
  }
  document.addEventListener('mouseout', onMouseOut, true)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  teardown = () => {
    document.removeEventListener('mouseout', onMouseOut, true)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('visibilitychange', onVisibility)
    teardown = null
  }
}

/**
 * Calls `listener` whenever the pointer leaves the page or the page loses
 * focus. Returns the unsubscribe function. No-op on the server.
 */
export function subscribePointerExit(listener: Listener): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  listeners.add(listener)
  if (!teardown) install()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) teardown?.()
  }
}
