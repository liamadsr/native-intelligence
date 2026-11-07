// ── PixelCanvas run/schedule policy ─────────────────────────────────────────
// The dotted-canvas twinkle (tab-content.tsx PixelCanvas) is one of the app's
// steady scripted animations, so whether — and how often — its loop runs is
// what the idle power profile hangs off. It runs by the gate here, pure and
// unit-tested (as does anything that reads hooks/use-watched.ts); the
// components just wire DOM/Tauri signals into it.

/**
 * Draw cadence. The twinkle and drifting patches are gradual, so ~12.5fps
 * keeps their motion smooth. The loop schedules each frame via
 * `setTimeout(PIXEL_FRAME_MS)` wrapping a single `requestAnimationFrame`
 * (rather than re-registering rAF every display frame and early-returning), so
 * callback servicing itself happens at 12.5Hz instead of 60–120Hz — raw rAF
 * re-registration made ~90% of wakeups no-ops and kept the rendering-update
 * timer hot at display rate (2026-08-05 idle-residue incident analysis).
 */
export const PIXEL_FRAME_MS = 80

/**
 * Pause the twinkle after this long with no pointer/keyboard input. Nobody is
 * watching a background decoration they aren't interacting with, and the
 * desktop shell disables background throttling — without this gate the canvas
 * burns CPU (and feeds GC) for the whole workday. Any input resumes it.
 */
export const PIXEL_IDLE_MS = 60_000

/** Everything the run gate weighs. All inputs are "current truth" booleans —
 *  the component mirrors live signals into refs and re-evaluates on change. */
export interface PixelCanvasRunState {
  /** Page Visibility API: OS-level tab switch / minimized window. */
  documentHidden: boolean
  /** The window has focus. Sourced per-window on desktop (see
   *  `mainFocusBroadcastApplies` / `PIXEL_FOCUS_EVENT`) with DOM focus/blur as
   *  the web and older-build fallback. */
  windowFocused: boolean
  /** No pointer/keyboard input for PIXEL_IDLE_MS. */
  interactionIdle: boolean
}

/** Should the twinkle loop be running right now? A pure conjunction — every
 *  input is independently sufficient to pause. Pausing FREEZES the last drawn
 *  frame (no clear), so resuming is visually seamless. */
export function shouldRunPixelCanvas(s: PixelCanvasRunState): boolean {
  return (
    !s.documentHidden &&
    s.windowFocused &&
    !s.interactionIdle
  )
}

/** Has the user been idle long enough to pause? Timestamps share the
 *  `performance.now()` basis (rAF hands its callback the same clock). */
export function isInteractionIdle(
  nowMs: number,
  lastInteractionMs: number,
  idleMs: number = PIXEL_IDLE_MS,
): boolean {
  return nowMs - lastInteractionMs >= idleMs
}

// ── Where "this window is focused" comes from ────────────────────────────────

/** Tauri label of the primary dashboard window. Pop-outs are `workspace-<id>`. */
export const MAIN_WINDOW_LABEL = 'main'

/**
 * Per-window focus event (payload identical to `main-focus-changed`: a bare
 * boolean). Emitted by Rust with `emit_to(EventTarget::labeled(label))`, so it
 * must be subscribed WINDOW-SCOPED — a global listener registers as
 * `EventTarget::Any` and would receive every window's targeted emits.
 *
 * VERSION SKEW: the web app ships ahead of the native binary, so older shells
 * never emit this. There is nothing to feature-detect — the listener simply
 * never fires, and `mainFocusBroadcastApplies` remains the fallback wiring.
 */
export const PIXEL_FOCUS_EVENT = 'window-focus-changed'

/**
 * Does the BROADCAST `main-focus-changed` describe THIS window's focus?
 *
 * Only for the main window. The event is a broadcast that every webview
 * receives, but it reports the main window's transitions alone — a pop-out that
 * trusted it would re-arm its twinkle every time the MAIN window was focused,
 * so side-by-side windows both animate into the one shared WKWebView GPU
 * process (the 2026-07 typing-lag incident). Pop-outs use DOM focus/blur, and
 * every desktop window prefers `PIXEL_FOCUS_EVENT` when the shell emits it.
 *
 * `null` label = web (no Tauri): there is no broadcast at all, so the answer is
 * moot; false keeps the DOM path authoritative.
 */
export function mainFocusBroadcastApplies(label: string | null): boolean {
  return label === MAIN_WINDOW_LABEL
}
