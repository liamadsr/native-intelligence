/**
 * One ringtone for a ring, however many tabs and desktop windows of the app
 * are open (each gets the ring over Realtime and shows it; only one plays it
 * and raises the desktop banner).
 *
 * With the Web Locks API (every browser the app supports, and the desktop's
 * WebKit): each window asks for the ring's lock and waits; the one holding it
 * rings, the others wait their turn. When the ringing window closes, its lock
 * goes to the next one waiting, which rings on: a ring never falls silent
 * because a tab closed. When the ring stops (answered anywhere, declined, run
 * out), every window lets go of its place in line.
 *
 * Without it: a BroadcastChannel claim (src/lib/sounds/cross-window.ts
 * claimLock, the lowest window id wins), held for the ring's whole time.
 */
import { claimLock } from '@/lib/sounds/cross-window'

export interface RingerLocks {
  request(name: string, options: { signal?: AbortSignal }, callback: (lock: unknown) => Promise<void> | void): Promise<unknown>
}

function webLocks(): RingerLocks | null {
  if (typeof navigator === 'undefined') return null
  const lm = (navigator as unknown as { locks?: RingerLocks }).locks
  return lm && typeof lm.request === 'function' ? lm : null
}

/** The lock a ring's ringtone is held under. */
export function ringerLockName(ringId: string): string {
  return `ni-team-call-ring:${ringId}`
}

/**
 * Take this window's place in line to ring for `ringId`. `onRing` runs when
 * this window is the one (at once, or when the one before it lets go) and
 * returns how to stop. The returned function lets go: stops this window's
 * ringing, or leaves the line. Never throws.
 */
export function holdRinger(
  ringId: string,
  onRing: () => () => void,
  opts: { locks?: RingerLocks | null; holdMs?: number } = {},
): () => void {
  const locks = opts.locks === undefined ? webLocks() : opts.locks
  let released = false
  let stop: (() => void) | null = null
  const ring = () => {
    if (released) return
    try {
      stop = onRing()
    } catch {
      stop = null
    }
  }

  if (!locks) {
    void claimLock(ringerLockName(ringId), opts.holdMs ?? 45_000).then((won) => {
      if (won) ring()
    })
    return () => {
      if (released) return
      released = true
      stop?.()
      stop = null
    }
  }

  const abort = typeof AbortController !== 'undefined' ? new AbortController() : null
  let letGo: (() => void) | null = null
  try {
    void locks
      .request(ringerLockName(ringId), abort ? { signal: abort.signal } : {}, () => {
        if (released) return
        ring()
        return new Promise<void>((resolve) => {
          letGo = resolve
        })
      })
      .catch(() => undefined)
  } catch {
    // No lock to be had: this window rings (a rare second ringtone beats a silent ring).
    ring()
  }
  return () => {
    if (released) return
    released = true
    stop?.()
    stop = null
    if (letGo) letGo()
    else abort?.abort()
  }
}
