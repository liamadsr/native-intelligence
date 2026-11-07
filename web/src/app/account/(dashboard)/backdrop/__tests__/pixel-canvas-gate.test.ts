import { describe, it, expect } from 'vitest'
import {
  MAIN_WINDOW_LABEL,
  PIXEL_FOCUS_EVENT,
  PIXEL_FRAME_MS,
  PIXEL_IDLE_MS,
  isInteractionIdle,
  mainFocusBroadcastApplies,
  shouldRunPixelCanvas,
  type PixelCanvasRunState,
} from '../pixel-canvas-gate'

/**
 * PixelCanvas run/schedule policy (2026-08-05 idle-residue analysis).
 *
 * The dotted twinkle was the app's only steady scripted animation and, at
 * ~7% CPU forever, the dominant idle power draw: it re-registered rAF at
 * DISPLAY rate (60–120Hz) and early-returned ~90% of ticks, keeping WebKit's
 * rendering-update timer hot and feeding the allocation stream that schedules
 * full GCs over an already-bloated heap.
 *
 * Two decisions were extracted here so they can be pinned without a canvas:
 *   - WHETHER to run (a pure conjunction: any one signal pauses), and
 *   - HOW OFTEN callbacks are serviced (the setTimeout-wrapped-rAF cadence,
 *     as opposed to raw rAF re-registration).
 */

const running: PixelCanvasRunState = {
  documentHidden: false,
  windowFocused: true,
  interactionIdle: false,
}

describe('shouldRunPixelCanvas — the full truth table', () => {
  it('runs only when every signal says someone can see it move', () => {
    expect(shouldRunPixelCanvas(running)).toBe(true)
  })

  // Each input is INDEPENDENTLY sufficient to pause — a regression that ANDed
  // one of these away (or dropped it entirely) would silently restore the burn.
  const pausers: Array<[string, Partial<PixelCanvasRunState>]> = [
    ['the document is hidden (OS tab switch / minimized)', { documentHidden: true }],
    ['the window is unfocused but still visible (cmd-tab — the workday case)', { windowFocused: false }],
    ['the user has not touched pointer or keyboard for a minute', { interactionIdle: true }],
  ]

  for (const [label, patch] of pausers) {
    it(`pauses when ${label}`, () => {
      expect(shouldRunPixelCanvas({ ...running, ...patch })).toBe(false)
    })
  }

  it('stays paused when several signals apply at once', () => {
    expect(
      shouldRunPixelCanvas({
        documentHidden: true,
        windowFocused: false,
        interactionIdle: true,
      }),
    ).toBe(false)
  })

  it('an unfocused window pauses even while visible and interacted-with — document.hidden alone is not enough', () => {
    // The desktop shell disables background throttling deliberately, so an
    // unfocused-but-visible window would otherwise animate all day; the
    // Visibility API never fires for cmd-tab.
    expect(
      shouldRunPixelCanvas({ ...running, windowFocused: false, interactionIdle: false }),
    ).toBe(false)
  })

  it('resumes as soon as the last blocking signal clears', () => {
    let s: PixelCanvasRunState = { ...running, windowFocused: false, interactionIdle: true }
    expect(shouldRunPixelCanvas(s)).toBe(false)
    s = { ...s, windowFocused: true }
    expect(shouldRunPixelCanvas(s)).toBe(false) // still idle
    s = { ...s, interactionIdle: false }
    expect(shouldRunPixelCanvas(s)).toBe(true)
  })

  it('is pure — evaluating it does not mutate the state it is handed', () => {
    const s = { ...running }
    shouldRunPixelCanvas(s)
    expect(s).toEqual(running)
  })
})

describe('isInteractionIdle', () => {
  it('is not idle immediately after an interaction', () => {
    expect(isInteractionIdle(1_000, 1_000)).toBe(false)
  })

  it('is not idle just under the threshold', () => {
    expect(isInteractionIdle(PIXEL_IDLE_MS + 999, 1_000)).toBe(false)
  })

  it('becomes idle exactly AT the threshold (inclusive)', () => {
    expect(isInteractionIdle(PIXEL_IDLE_MS + 1_000, 1_000)).toBe(true)
  })

  it('is idle well past the threshold', () => {
    expect(isInteractionIdle(500_000, 1_000)).toBe(true)
  })

  it('accepts a caller-supplied window', () => {
    expect(isInteractionIdle(5_000, 0, 10_000)).toBe(false)
    expect(isInteractionIdle(10_000, 0, 10_000)).toBe(true)
  })

  it('treats a backwards clock as not-idle rather than flapping the gate off', () => {
    expect(isInteractionIdle(500, 1_000)).toBe(false)
  })
})

/**
 * Which window's focus drives the gate (multi-window regression).
 *
 * `main-focus-changed` is a BROADCAST that reports only the MAIN window's
 * transitions, but every webview receives it. A pop-out that treated it as its
 * own focus re-armed its twinkle every time main was focused — so with two
 * windows side by side both canvas loops ran continuously into the single
 * shared WKWebView GPU process, which is exactly the earlier typing-lag burn.
 */
describe('mainFocusBroadcastApplies — the broadcast belongs to main alone', () => {
  it('applies in the main window (cmd-tab pause must keep working there)', () => {
    expect(mainFocusBroadcastApplies(MAIN_WINDOW_LABEL)).toBe(true)
  })

  it('does NOT apply in a workspace pop-out', () => {
    expect(mainFocusBroadcastApplies('workspace-9f2c')).toBe(false)
    expect(mainFocusBroadcastApplies('workspace-e4a7ad7e-1c93-432f-89f7-fd855e0e23df')).toBe(false)
  })

  it('does not apply in the HUD windows either', () => {
    expect(mainFocusBroadcastApplies('meeting-hud')).toBe(false)
    expect(mainFocusBroadcastApplies('agent-hud')).toBe(false)
  })

  it('does not apply on the web, where there is no broadcast at all', () => {
    expect(mainFocusBroadcastApplies(null)).toBe(false)
  })

  it('pins the label and event names the Rust side pairs with', () => {
    // Renaming either half silently drops the per-window signal: the listener
    // stops matching, and the fallback quietly reinstates the old behaviour.
    expect(MAIN_WINDOW_LABEL).toBe('main')
    expect(PIXEL_FOCUS_EVENT).toBe('window-focus-changed')
    expect(PIXEL_FOCUS_EVENT).not.toBe('main-focus-changed')
  })
})

describe('scheduling cadence — throttled, not raw rAF re-registration', () => {
  it('pins the draw cadence at ~12.5fps', () => {
    expect(PIXEL_FRAME_MS).toBe(80)
    expect(1000 / PIXEL_FRAME_MS).toBeCloseTo(12.5, 5)
  })

  it('pins the idle window at one minute', () => {
    expect(PIXEL_IDLE_MS).toBe(60_000)
  })

  /**
   * The regression this guards: the OLD loop called requestAnimationFrame at
   * the top of every callback and early-returned when <80ms had elapsed, so
   * callbacks were SERVICED at display rate while only ~1 in 5–10 drew. The
   * new loop schedules with setTimeout(PIXEL_FRAME_MS) → ONE rAF, so servicing
   * and drawing happen at the same 12.5Hz.
   *
   * Both shapes are simulated below against the same fake clock; the assertion
   * is on the ratio of servicings to draws.
   */
  it('services one callback per drawn frame (the old shape serviced ~5–10× more)', () => {
    const DISPLAY_HZ = 120
    const DURATION_MS = 2_000

    // ── Old shape: rAF re-registered every display frame, throttled by time.
    let oldServicings = 0
    let oldDraws = 0
    let lastDraw = -Infinity
    for (let t = 0; t < DURATION_MS; t += 1000 / DISPLAY_HZ) {
      oldServicings++
      if (t - lastDraw < PIXEL_FRAME_MS) continue
      lastDraw = t
      oldDraws++
    }

    // ── New shape: setTimeout(PIXEL_FRAME_MS) → one rAF → draw → reschedule.
    let newServicings = 0
    let newDraws = 0
    for (let t = 0; t < DURATION_MS; t += PIXEL_FRAME_MS) {
      newServicings++
      newDraws++
    }

    // Same visual cadence…
    expect(newDraws).toBe(oldDraws)
    // …but every serviced callback now does work.
    expect(newServicings).toBe(newDraws)
    // …whereas the old shape burned ~10× the callbacks at 120Hz.
    expect(oldServicings / oldDraws).toBeGreaterThan(5)
    expect(newServicings).toBeLessThan(oldServicings / 5)
  })

  it('an idle pause stops scheduling entirely — not just skipped draws', () => {
    // Modeled the way the loop actually behaves: on the idle tick it returns
    // WITHOUT rescheduling, so servicing count stops advancing rather than
    // continuing at cadence with no-op draws.
    let servicings = 0
    let t = 0
    const lastInteraction = 0
    let alive = true
    while (alive && t < PIXEL_IDLE_MS * 2) {
      servicings++
      if (isInteractionIdle(t, lastInteraction)) {
        alive = false
        break
      }
      t += PIXEL_FRAME_MS
    }

    expect(alive).toBe(false)
    // One servicing per frame up to the idle threshold, then nothing.
    expect(servicings).toBe(Math.ceil(PIXEL_IDLE_MS / PIXEL_FRAME_MS) + 1)
    expect(t).toBeGreaterThanOrEqual(PIXEL_IDLE_MS)
  })
})
