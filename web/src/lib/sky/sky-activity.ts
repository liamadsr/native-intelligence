/**
 * When the sky may move. It drifts unless the person is using the app:
 * scrolling, clicking, typing or touch-scrolling freezes it at once, and it
 * eases back after CALM_MS without any. Moving the mouse doesn't (Liam,
 * 10-10); it only wakes a sky at rest. Holds freeze it for as long as they're
 * on, whatever the input: a reply streaming, a page full screen, the document
 * hidden, reduced motion. Releasing a hold counts as activity, so the sky
 * waits out a calm spell before it moves again.
 *
 * A calm run is capped: after MAX_CALM_RUN_MS of continuous motion with no
 * input the sky comes to rest (`isResting()`; the renderer eases it to a
 * stop) and stays still, with no loop and no timer, until the next input.
 * That input, then a calm spell, starts a fresh run. Nobody watches a
 * background drift for minutes on end, and every frame also makes WebKit
 * redo the blurs drawn over it.
 *
 * Per input event the cost is one clock read and a comparison: there is one
 * pending timer at most, armed when activity starts and re-armed for the
 * remainder when it fires early, so a burst of scroll events never touches
 * the timer. Calm, allowed and not yet rested is the only state with an
 * animation loop; the renderer subscribes and stops the moment this says no.
 * While it moves there is one more timer, the run's cap.
 *
 * Client-safe: nothing touches `window` until attach().
 */

export const CALM_MS = 2_000
/** The longest the sky moves without input before it comes to rest. */
export const MAX_CALM_RUN_MS = 300_000

/** The input that counts as activity, all passive. `scroll` in the capture phase catches inner scrollers. */
// Not pointermove (Liam, 10-10): the mouse moving over the window isn't
// using the app; scrolling, clicking, typing and touch-scrolling are.
const ACTIVITY_EVENTS = ['wheel', 'pointerdown', 'keydown', 'touchmove'] as const

export interface SkyActivityOptions {
  now?: () => number
  calmMs?: number
  maxRunMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export interface SkyActivity {
  /** Input happened: freeze now, move again after a calm spell. */
  markActive(): void
  /** Turn a named hold on or off. */
  setHold(key: string, on: boolean): void
  /** No input for a calm spell. */
  isCalm(): boolean
  /** A calm run hit MAX_CALM_RUN_MS: still until the next input. */
  isResting(): boolean
  /** Calm, nothing holding it and not resting: the only state with an animation loop. */
  canMove(): boolean
  /** The names of the holds that are on (debugging). */
  holds(): string[]
  /** A chat panel reports whether its chat is empty (null: it isn't the active one). */
  setChatEmpty(key: string, empty: boolean | null): void
  /** At least one active chat reported, and every active chat is empty. */
  isChatEmpty(): boolean
  subscribe(listener: () => void): () => void
  /** Listen for input on the window (and its visibility / reduced motion). Ref-counted. */
  attach(): () => void
}

export function createSkyActivity(options: SkyActivityOptions = {}): SkyActivity {
  const now = options.now ?? (() => performance.now())
  const calmMs = options.calmMs ?? CALM_MS
  const maxRunMs = options.maxRunMs ?? MAX_CALM_RUN_MS
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))

  let calm = false
  let lastActivity = now()
  let timer: unknown = null
  let resting = false
  /** The current run's cap: armed while the sky may move, and only then. */
  let runTimer: unknown = null
  const holdSet = new Set<string>()
  const emptyByChat = new Map<string, boolean>()
  const listeners = new Set<() => void>()
  let attachCount = 0
  let detachDom: (() => void) | null = null

  const moving = () => calm && !resting && holdSet.size === 0

  /** Arm the run's cap when motion starts, drop it when motion stops. */
  const syncRun = () => {
    if (moving()) {
      if (runTimer === null) runTimer = setTimer(onRunCap, maxRunMs)
    } else if (runTimer !== null) {
      clearTimer(runTimer)
      runTimer = null
    }
  }

  const emit = () => {
    syncRun()
    for (const l of [...listeners]) l()
  }

  function onRunCap() {
    runTimer = null
    if (!moving()) return
    resting = true
    emit()
  }

  const arm = (ms: number) => {
    timer = setTimer(onTimer, ms)
  }

  function onTimer() {
    timer = null
    const idle = now() - lastActivity
    if (idle >= calmMs) {
      if (!calm) {
        calm = true
        emit()
      }
    } else {
      arm(calmMs - idle)
    }
  }

  const markActive = () => {
    lastActivity = now()
    if (timer === null) arm(calmMs)
    if (calm || resting) {
      calm = false
      resting = false
      emit()
    }
  }

  const setHold = (key: string, on: boolean) => {
    if (on === holdSet.has(key)) return
    if (on) {
      holdSet.add(key)
      emit()
    } else {
      holdSet.delete(key)
      markActive()
      emit()
    }
  }

  const isChatEmpty = () => {
    if (emptyByChat.size === 0) return false
    for (const empty of emptyByChat.values()) if (!empty) return false
    return true
  }

  /**
   * The mouse moved: not activity (it never freezes the sky), but a sky at
   * rest after its run's cap wakes for a fresh run, since someone is there.
   */
  const wake = () => {
    if (!resting) return
    resting = false
    emit()
  }

  const setChatEmpty = (key: string, empty: boolean | null) => {
    const before = isChatEmpty()
    if (empty === null) emptyByChat.delete(key)
    else emptyByChat.set(key, empty)
    if (isChatEmpty() !== before) emit()
  }

  const wireDom = (): (() => void) => {
    const opts: AddEventListenerOptions = { passive: true }
    const scrollOpts: AddEventListenerOptions = { passive: true, capture: true }
    for (const type of ACTIVITY_EVENTS) window.addEventListener(type, markActive, opts)
    window.addEventListener('scroll', markActive, scrollOpts)
    window.addEventListener('pointermove', wake, opts)

    const onVisibility = () => setHold('hidden', document.visibilityState !== 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()

    const motion = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
    const onMotion = () => setHold('reduced-motion', !!motion?.matches)
    motion?.addEventListener?.('change', onMotion)
    onMotion()

    return () => {
      for (const type of ACTIVITY_EVENTS) window.removeEventListener(type, markActive, opts)
      window.removeEventListener('scroll', markActive, scrollOpts)
      window.removeEventListener('pointermove', wake, opts)
      document.removeEventListener('visibilitychange', onVisibility)
      motion?.removeEventListener?.('change', onMotion)
    }
  }

  return {
    markActive,
    setHold,
    isCalm: () => calm,
    isResting: () => resting,
    canMove: moving,
    holds: () => [...holdSet],
    setChatEmpty,
    isChatEmpty,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    attach() {
      attachCount++
      if (attachCount === 1) {
        detachDom = wireDom()
        markActive()
      }
      let done = false
      return () => {
        if (done) return
        done = true
        attachCount--
        if (attachCount === 0) {
          detachDom?.()
          detachDom = null
          if (timer !== null) clearTimer(timer)
          timer = null
          if (runTimer !== null) clearTimer(runTimer)
          runTimer = null
          calm = false
          resting = false
        }
      }
    },
  }
}

/** The app's one sky activity store. */
export const skyActivity: SkyActivity = createSkyActivity()
