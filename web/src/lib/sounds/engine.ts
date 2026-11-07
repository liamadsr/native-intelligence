/**
 * The UI sound engine: one shared AudioContext, the catalog's sounds decoded
 * once into cached AudioBuffers, and `playSound(name)`.
 *
 *   const chime = playSound('voice-chat-start')
 *   await chime.nearEnd(300)   // start what follows over the chime's tail
 *   await chime.ended          // e.g. unmute the mic only now
 *   chime.stop()               // idempotent; `ended` resolves at once
 *
 * `playSound` never throws and its promises never reject or hang. When sound
 * effects are off, there is no AudioContext (SSR, jsdom), the context can't
 * run (a browser before the user's first click or key), the file failed to
 * load or decode, or nothing started within START_TIMEOUT_MS, `started`
 * resolves false and `ended` resolves at once.
 *
 * Unlocking. The desktop's WKWebView runs with autoplay allowed, so audio
 * plays without a gesture. Browsers keep a new AudioContext suspended until
 * the page has a user gesture: `primeSounds()` (the app runtime calls it)
 * creates and resumes the context on the first `pointerdown` / `keydown` with
 * once-listeners, after which later resumes are allowed. It does so even with
 * Sound effects off (Safari only unlocks a context resumed inside a gesture,
 * so turning the setting on later must not find it locked); the idle suspend
 * below releases the device again. A control that turns sounds on calls
 * `unlockSounds()` in its own click handler for the same reason.
 * `canPlaySoundsNow()` says whether this window could make a sound right now
 * (the alert gates ask it before claiming an event for this window).
 *
 * Idle. A running AudioContext keeps the audio device open, so the context is
 * suspended IDLE_SUSPEND_MS after the last sound ends and resumed per play.
 *
 * Loading. A sound is fetched and decoded on its first play; after the first
 * use (a play, or the browser unlock) the rest that something plays
 * (PRELOADED_SOUND_NAMES) are preloaded when the page is idle, so later
 * sounds start at once. A failed load is forgotten, so a later play tries
 * again.
 *
 * Page-played audio is not in the desktop's echo-cancellation reference: a
 * sound played while the mic is live leaks into it. Alert sounds go through
 * `playAlertSound` (./alerts), which stays quiet then; a voice cue that plays
 * on purpose while its own mic is open is its caller's to sequence.
 */

import { isDesktopApp } from '@/lib/platform'
import { PRELOADED_SOUND_NAMES, isSoundName, soundUrl, type SoundName } from './catalog'
import { getSoundEffectsEnabled } from './settings'

export interface SoundHandle {
  readonly name: SoundName
  /** True once the sound is audible; false when it won't play. Never rejects. */
  readonly started: Promise<boolean>
  /** Resolves when the sound finished, was stopped, or never played. Never
   *  rejects, never hangs. */
  readonly ended: Promise<void>
  /** Resolves `leadMs` before the sound's end (at once when it won't play, or
   *  sooner if it ends or is stopped first), to start what follows over its
   *  tail. Never rejects. */
  nearEnd(leadMs: number): Promise<void>
  /** Stop now. Idempotent; `ended` resolves at once. */
  stop(): void
}

/** The give-up points, exported for tests. */
export const SOUND_TIMING = {
  /** From playSound to audible: load + decode + resume. Past it, the sound is
   *  dropped (a late chime is worse than none). */
  START_TIMEOUT_MS: 2500,
  /** How long a resume may take before the context counts as locked. */
  RESUME_TIMEOUT_MS: 1500,
  /** Past the buffer's own length, how long `ended` waits for `onended`. */
  END_SLACK_MS: 750,
  /** Suspend the context this long after the last sound ends. */
  IDLE_SUSPEND_MS: 5000,
  /** Preload fallback delay where requestIdleCallback is missing. */
  PRELOAD_DELAY_MS: 1500,
}

type AudioContextFactory = () => AudioContext | null

let factoryOverride: AudioContextFactory | null = null
let ctx: AudioContext | null = null
const buffers = new Map<SoundName, Promise<AudioBuffer | null>>()
const active = new Set<{ stop: () => void }>()
let unlockArmed = false
let unlockListener: (() => void) | null = null
/** This window had a gesture that unlocked audio (the first-gesture listener,
 *  or `unlockSounds()` from a click handler). */
let gestureUnlocked = false
let preloadScheduled = false
let idleTimer: ReturnType<typeof setTimeout> | null = null

function defaultFactory(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    AudioContext?: typeof AudioContext
    webkitAudioContext?: typeof AudioContext
  }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) return null
  try {
    return new Ctor({ latencyHint: 'interactive' })
  } catch {
    return null
  }
}

/** The shared context, created on first need; null where audio can't run. */
function getContext(): AudioContext | null {
  if (ctx && ctx.state !== 'closed') return ctx
  ctx = null
  try {
    ctx = (factoryOverride ?? defaultFactory)()
  } catch {
    ctx = null
  }
  return ctx
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Resume the context if needed; true once it runs. Never rejects. */
async function ensureRunning(c: AudioContext): Promise<boolean> {
  if (c.state === 'running') return true
  try {
    await Promise.race([Promise.resolve(c.resume()).catch(() => {}), sleep(SOUND_TIMING.RESUME_TIMEOUT_MS)])
  } catch {
    /* treated as not running below */
  }
  return (c.state as string) === 'running'
}

function decode(c: AudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    // Both forms: the callbacks for WebKits that predate the promise, the
    // promise for everything else (a second settle is a no-op).
    const maybe = c.decodeAudioData(data, resolve, reject) as unknown
    if (maybe && typeof (maybe as Promise<AudioBuffer>).then === 'function') {
      ;(maybe as Promise<AudioBuffer>).then(resolve, reject)
    }
  })
}

/** The decoded sound, cached; null when it can't be loaded (then forgotten,
 *  so the next play tries again). Never rejects. */
function loadBuffer(c: AudioContext, name: SoundName): Promise<AudioBuffer | null> {
  const cached = buffers.get(name)
  if (cached) return cached
  const pending = (async () => {
    try {
      const res = await fetch(soundUrl(name))
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await decode(c, await res.arrayBuffer())
    } catch (err) {
      console.warn(`[sounds] could not load ${name}:`, err instanceof Error ? err.message : err)
      buffers.delete(name)
      return null
    }
  })()
  buffers.set(name, pending)
  return pending
}

/** After the first use, load the rest when the page is idle. */
function schedulePreload() {
  if (preloadScheduled || typeof window === 'undefined') return
  preloadScheduled = true
  const run = () => void preloadSounds()
  const w = window as unknown as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(run, { timeout: 10_000 })
  else setTimeout(run, SOUND_TIMING.PRELOAD_DELAY_MS)
}

function cancelIdleSuspend() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
}

function scheduleIdleSuspend() {
  cancelIdleSuspend()
  if (active.size > 0) return
  idleTimer = setTimeout(() => {
    idleTimer = null
    const c = ctx
    if (!c || active.size > 0 || c.state !== 'running') return
    void Promise.resolve(c.suspend()).catch(() => {})
  }, SOUND_TIMING.IDLE_SUSPEND_MS)
}

/** Browsers: unlock on the first click or key (once-listeners). */
function armUnlock() {
  if (unlockArmed || typeof window === 'undefined' || isDesktopApp()) return
  unlockArmed = true
  const unlock = () => {
    disarmUnlock()
    unlockSounds()
  }
  unlockListener = unlock
  window.addEventListener('pointerdown', unlock, { capture: true, once: true, passive: true })
  window.addEventListener('keydown', unlock, { capture: true, once: true })
}

function disarmUnlock() {
  if (unlockListener && typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', unlockListener, true)
    window.removeEventListener('keydown', unlockListener, true)
  }
  unlockListener = null
  unlockArmed = false
}

/** Get sounds ready to play: on browsers, arm the first-gesture unlock. Safe
 *  to call repeatedly (and on the server, where it does nothing). */
export function primeSounds(): void {
  armUnlock()
}

/**
 * Create and resume the shared context now. Call it synchronously inside a
 * user gesture (a click handler, before any await) so the browser lets the
 * resume through; the first-gesture listener calls it too. The context is
 * unlocked whatever the Sound effects setting says (the idle suspend
 * releases the device); only the preload waits for the setting.
 */
export function unlockSounds(): void {
  if (typeof window === 'undefined') return
  gestureUnlocked = true
  const c = getContext()
  if (!c) return
  if (getSoundEffectsEnabled()) schedulePreload()
  if (c.state === 'running') {
    scheduleIdleSuspend()
    return
  }
  try {
    void Promise.resolve(c.resume())
      .catch(() => {})
      .then(() => scheduleIdleSuspend())
  } catch {
    /* the next play resumes (or gives up) on its own */
  }
}

/**
 * Could this window make a sound right now? True on the desktop (autoplay),
 * with the context running, or once this window has had a user gesture
 * (`navigator.userActivation.hasBeenActive`, or the unlock ran here). A
 * browser tab never clicked or typed in can't resume its context, so it must
 * not claim a cross-window alert. Where `userActivation` is missing, true.
 */
export function canPlaySoundsNow(): boolean {
  if (typeof window === 'undefined') return false
  if (isDesktopApp()) return true
  if (ctx?.state === 'running') return true
  if (gestureUnlocked) return true
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive?: boolean } }).userActivation
  if (!activation) return true
  return activation.hasBeenActive === true
}

/** Load (and decode) sounds ahead of their first play. Never rejects. */
export async function preloadSounds(names: readonly SoundName[] = PRELOADED_SOUND_NAMES): Promise<void> {
  const c = getContext()
  if (!c) return
  for (const name of names) {
    // One at a time: a background task, not a burst.
    await loadBuffer(c, name)
  }
}

/** Play one sound. See the module doc for the guarantees. */
export function playSound(name: SoundName): SoundHandle {
  let resolveStarted!: (value: boolean) => void
  let resolveEnded!: () => void
  const started = new Promise<boolean>((resolve) => {
    resolveStarted = resolve
  })
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve
  })

  let done = false
  /** When the sound became audible, and how long it is (ms), once started. */
  let startedAt = 0
  let durationMs = 0
  let source: AudioBufferSourceNode | null = null
  let startTimer: ReturnType<typeof setTimeout> | null = null
  let endTimer: ReturnType<typeof setTimeout> | null = null

  const entry = {
    stop: () => {
      if (source) {
        try {
          source.stop()
        } catch {
          /* already stopped */
        }
      }
      finish()
    },
  }

  function finish() {
    if (done) return
    done = true
    if (startTimer) clearTimeout(startTimer)
    if (endTimer) clearTimeout(endTimer)
    if (source) {
      source.onended = null
      try {
        source.disconnect()
      } catch {
        /* never connected */
      }
    }
    const wasActive = active.delete(entry)
    resolveStarted(false) // a no-op once it resolved true
    resolveEnded()
    if (wasActive) scheduleIdleSuspend()
  }

  const nearEnd = (leadMs: number): Promise<void> =>
    started.then((ok) => {
      if (!ok || done) return
      const wait = startedAt + durationMs - Math.max(0, leadMs) - Date.now()
      if (wait <= 0) return
      return Promise.race([ended, sleep(wait)])
    })

  const handle: SoundHandle = { name, started, ended, nearEnd, stop: entry.stop }

  if (!isSoundName(name) || !getSoundEffectsEnabled()) {
    finish()
    return handle
  }
  const c = getContext()
  if (!c) {
    finish()
    return handle
  }
  armUnlock()
  schedulePreload()
  cancelIdleSuspend()
  active.add(entry)
  startTimer = setTimeout(finish, SOUND_TIMING.START_TIMEOUT_MS)

  void (async () => {
    try {
      const [buffer, running] = await Promise.all([loadBuffer(c, name), ensureRunning(c)])
      if (done) return
      if (!buffer || !running) return finish()
      const node = c.createBufferSource()
      node.buffer = buffer
      node.connect(c.destination)
      node.onended = () => finish()
      source = node
      node.start()
      startedAt = Date.now()
      durationMs = buffer.duration * 1000
      if (startTimer) clearTimeout(startTimer)
      startTimer = null
      resolveStarted(true)
      // `onended` can go missing (a context suspended mid-sound); never hang.
      endTimer = setTimeout(finish, buffer.duration * 1000 + SOUND_TIMING.END_SLACK_MS)
    } catch (err) {
      console.warn(`[sounds] could not play ${name}:`, err instanceof Error ? err.message : err)
      finish()
    }
  })()

  return handle
}

/** Stop every sound playing now. */
export function stopAllSounds(): void {
  for (const entry of [...active]) entry.stop()
}

/** Tests only: build the AudioContext from `factory` (null = the real one). */
export function __setAudioContextFactoryForTests(factory: AudioContextFactory | null): void {
  factoryOverride = factory
  ctx = null
}

/** Tests only: forget the context, the cache and every listener. */
export function __resetSoundEngineForTests(): void {
  for (const entry of [...active]) entry.stop()
  active.clear()
  disarmUnlock()
  cancelIdleSuspend()
  buffers.clear()
  preloadScheduled = false
  gestureUnlocked = false
  ctx = null
}
