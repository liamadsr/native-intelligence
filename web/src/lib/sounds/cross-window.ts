/**
 * Coordination between every window and tab of the app (same origin): several
 * desktop windows and browser tabs each receive the same realtime event, and
 * one of them should make the sound.
 *
 * The Web Locks API does it atomically across windows:
 *   claimLock(name, holdMs)  — take `name` if no window holds it, and keep it
 *                              for holdMs (the dedupe claim);
 *   holdLock(name)           — keep `name` until released (a standing state,
 *                              e.g. "the mic is live here");
 *   isLockHeld(prefix)       — does any window hold a lock under `prefix`.
 *
 * Without `navigator.locks` (older WebKit), claims fall back to a
 * BroadcastChannel race (the lowest window id wins), standing holds are
 * window-local, and `isLockHeld` answers false (callers keep a local count).
 * Nothing here throws.
 */

const WINDOW_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

export function windowId(): string {
  return WINDOW_ID
}

interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; mode?: 'exclusive' | 'shared' },
    callback: (lock: unknown) => unknown,
  ): Promise<unknown>
  query?: () => Promise<{ held?: Array<{ name?: string }> }>
}

let locksOverride: LockManagerLike | null | undefined

function lockManager(): LockManagerLike | null {
  if (locksOverride !== undefined) return locksOverride
  if (typeof navigator === 'undefined') return null
  const lm = (navigator as unknown as { locks?: LockManagerLike }).locks
  return lm && typeof lm.request === 'function' ? lm : null
}

/**
 * Take `name` for `holdMs` if no other window holds it. Resolves true when
 * this window won. Never rejects: a lock API that errors counts as a win
 * (a rare double sound beats a lost one).
 */
export function claimLock(name: string, holdMs: number): Promise<boolean> {
  const lm = lockManager()
  if (!lm) return claimViaBroadcast(name, holdMs)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (won: boolean) => {
      if (settled) return
      settled = true
      resolve(won)
    }
    try {
      void lm
        .request(name, { ifAvailable: true }, (lock) => {
          if (!lock) {
            settle(false)
            return undefined
          }
          settle(true)
          return new Promise<void>((release) => setTimeout(release, holdMs))
        })
        .catch(() => settle(true))
    } catch {
      settle(true)
    }
  })
}

/** Hold `name` until the returned release runs. Where locks are missing the
 *  hold is a no-op (callers count locally too). */
export function holdLock(name: string): () => void {
  const lm = lockManager()
  if (!lm) return () => {}
  let release: (() => void) | null = null
  let released = false
  try {
    void lm
      .request(name, {}, () => {
        if (released) return undefined
        return new Promise<void>((resolve) => {
          release = resolve
        })
      })
      .catch(() => {})
  } catch {
    /* no hold; callers count locally */
  }
  return () => {
    if (released) return
    released = true
    release?.()
  }
}

/** Does any window hold a lock whose name starts with `prefix`? False when
 *  the answer isn't available (no `locks.query`). Never rejects. */
export async function isLockHeld(prefix: string): Promise<boolean> {
  const lm = lockManager()
  if (!lm || typeof lm.query !== 'function') return false
  try {
    const snapshot = await lm.query()
    return (snapshot?.held ?? []).some((lock) => typeof lock?.name === 'string' && lock.name.startsWith(prefix))
  } catch {
    return false
  }
}

// ── BroadcastChannel fallback ────────────────────────────────────────────────

const CLAIM_CHANNEL = 'ni:sound-claims'
/** How long a claimant listens for a rival before it counts as the winner. */
export const BROADCAST_CLAIM_WAIT_MS = 80
const MAX_CLAIMS = 200

interface Claim {
  owner: string
  until: number
}

const claims = new Map<string, Claim>()
let claimChannel: BroadcastChannel | null | undefined

function channel(): BroadcastChannel | null {
  if (claimChannel !== undefined) return claimChannel
  claimChannel = null
  if (typeof BroadcastChannel === 'undefined') return null
  try {
    claimChannel = new BroadcastChannel(CLAIM_CHANNEL)
    claimChannel.onmessage = (e: MessageEvent<{ name?: unknown; owner?: unknown; until?: unknown }>) => {
      const { name, owner, until } = e.data ?? {}
      if (typeof name !== 'string' || typeof owner !== 'string' || typeof until !== 'number') return
      record(name, { owner, until })
    }
  } catch {
    claimChannel = null
  }
  return claimChannel
}

/** Keep the standing claim for `name`: an unexpired one stands unless the
 *  newcomer's owner id sorts first (the tie-break for simultaneous claims). */
function record(name: string, claim: Claim) {
  const now = Date.now()
  const current = claims.get(name)
  if (current && current.until > now && current.owner <= claim.owner) return
  if (claims.size >= MAX_CLAIMS) {
    for (const [key, value] of claims) if (value.until <= now) claims.delete(key)
    if (claims.size >= MAX_CLAIMS) claims.clear()
  }
  claims.set(name, claim)
}

async function claimViaBroadcast(name: string, holdMs: number): Promise<boolean> {
  const now = Date.now()
  const current = claims.get(name)
  // Held — by another window, or already by this one (a second caller here).
  if (current && current.until > now) return false
  const mine: Claim = { owner: WINDOW_ID, until: now + holdMs }
  record(name, mine)
  const ch = channel()
  if (!ch) return true
  try {
    ch.postMessage({ name, ...mine })
  } catch {
    return true
  }
  await new Promise<void>((resolve) => setTimeout(resolve, BROADCAST_CLAIM_WAIT_MS))
  return claims.get(name)?.owner === WINDOW_ID
}

/** Tests only: use `lm` as the lock manager (null = none, undefined = the real one). */
export function __setLockManagerForTests(lm: LockManagerLike | null | undefined): void {
  locksOverride = lm
}

/** Tests only: forget broadcast claims and the channel. */
export function __resetCrossWindowForTests(): void {
  claims.clear()
  try {
    claimChannel?.close()
  } catch {
    /* already closed */
  }
  claimChannel = undefined
  locksOverride = undefined
}
