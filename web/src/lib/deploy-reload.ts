/**
 * New deploy → reload when idle, for every web surface (the main window on web
 * and desktop, the HUD windows, the bots overlay).
 *
 * A window that stays open across a deploy keeps running its old bundle against
 * the new server. Mostly that is harmless, but not when the client and server
 * speak a versioned protocol: an eve bump that raises the message stream
 * version makes the old eve client throw "Unsupported message stream version"
 * on every send, AFTER the POST was accepted, so the turn runs and bills behind
 * an error. So a stale window reloads itself as soon as nothing would be lost.
 *
 * FLAT COST, NO TIMERS. Nothing polls:
 *   - every same-origin `/api/` response carries the deployment's build id in
 *     `x-dial8-build` (next.config.mjs headers), which the existing fetch patch
 *     hands to {@link noteServerBuild} (lib/workspace-fetch.ts) for free;
 *   - on `visibilitychange` (to visible) and `focus`, a window that has not
 *     heard from the server for {@link RECHECK_AFTER_MS} asks `/api/version`
 *     once, so an idle window still notices on return.
 *
 * RELOAD ONLY WHEN IDLE. Surfaces register blockers (a reply streaming, an
 * unsent composer draft, a live recording, an occupied overlay) with
 * {@link registerReloadBlocker}; a stale window reloads at the first check with
 * none busy: when the new build is seen, on visibility / focus, and whenever a
 * blocker tells it it went idle ({@link reloadIfIdle}). The chat thread itself
 * is written to storage on pagehide (tabs/tab-context.tsx), so a reload keeps it.
 *
 * ONCE PER BUILD. A window reloads at most once for a given server build
 * (sessionStorage), so a CDN still serving the old bundle can never loop it.
 *
 * {@link reloadForStaleStream} is the backstop: the eve transports call it with
 * any stream error, and an unsupported-stream-version error reloads at once
 * instead of surfacing (the page shows the thread as stored on reload).
 */
import { clientBuildId } from './build-id'

/** The response header a deployment stamps with its build id (next.config.mjs). */
export const BUILD_HEADER = 'x-dial8-build'
/** Where a window notes the server build it last reloaded for (survives the reload). */
export const RELOADED_FOR_KEY = 'dial8:deploy-reloaded-for'
/** A window back in view re-asks the server only if it has not heard from it for this long. */
export const RECHECK_AFTER_MS = 60_000

const BUILD_ID = /^[\w.-]{1,100}$/

type Blocker = () => boolean
const blockers = new Set<Blocker>()
let staleFor: string | null = null
let lastHeardAt = 0
let installed = false
let reloading = false

/** For tests: a reload stand-in, and a reset of the module state. */
let doReload: () => void = () => window.location.reload()
export function __setReloadForTests(fn: () => void): void {
  doReload = fn
}
export function __resetDeployReloadForTests(): void {
  blockers.clear()
  staleFor = null
  lastHeardAt = 0
  reloading = false
}

/**
 * Register a busy check; while any returns true the window does not reload.
 * Read on demand (never polled). Returns the unregister function.
 */
export function registerReloadBlocker(isBusy: Blocker): () => void {
  blockers.add(isBusy)
  return () => {
    blockers.delete(isBusy)
  }
}

/** Whether this window is running an older build than the server's. */
export function isStaleBundle(): boolean {
  return staleFor !== null
}

/** The server build a response named (a Headers or a raw value). Mismatch → stale, and reload if idle. */
export function noteServerBuild(build: string | null | undefined, now: number = Date.now()): void {
  lastHeardAt = now
  const mine = clientBuildId()
  if (!mine || !build || !BUILD_ID.test(build) || build === mine) return
  staleFor = build
  reloadIfIdle()
}

/** Read the build header off a response (any status). */
export function noteResponseBuild(res: Pick<Response, 'headers'>): void {
  try {
    noteServerBuild(res.headers.get(BUILD_HEADER))
  } catch {
    /* a response without readable headers says nothing */
  }
}

/** Reload now if this window is stale and nothing registered is busy. */
export function reloadIfIdle(): boolean {
  if (!staleFor || reloading || typeof window === 'undefined') return false
  for (const isBusy of blockers) {
    try {
      if (isBusy()) return false
    } catch {
      return false // an unreadable blocker counts as busy
    }
  }
  return reloadOnceFor(staleFor)
}

/**
 * The eve transports' backstop: an "Unsupported message stream version" error
 * means this bundle's eve client is older than the server's. Reload at once
 * (whatever is busy: every send would fail the same way) and return true so the
 * caller shows nothing; any other error returns false.
 */
export function reloadForStaleStream(err: unknown): boolean {
  if (!isUnsupportedStreamVersionError(err) || typeof window === 'undefined') return false
  // Once per server build: the version itself stands in when no build is known.
  const build = staleFor ?? `stream:${String((err as Error).message).match(/version: (\w+)/)?.[1] ?? 'unknown'}`
  if (!reloadOnceFor(build)) return false
  return true
}

/** eve's client throws `TypeError("Unsupported message stream version: N.")` (client/stream-version.js). */
export function isUnsupportedStreamVersionError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /Unsupported message stream version/.test(message)
}

function reloadOnceFor(build: string): boolean {
  try {
    if (window.sessionStorage.getItem(RELOADED_FOR_KEY) === build) return false
    window.sessionStorage.setItem(RELOADED_FOR_KEY, build)
    if (window.sessionStorage.getItem(RELOADED_FOR_KEY) !== build) return false
  } catch {
    return false // can't note it, so it could loop: never reload
  }
  reloading = true
  doReload()
  return true
}

/**
 * Install the visibility / focus checks once per window. Called by the fetch
 * patch (every surface that loads lib/workspace-fetch.ts gets it).
 */
export function installDeployReload(): void {
  if (installed || typeof window === 'undefined' || typeof document === 'undefined') return
  installed = true
  const onReturn = () => {
    if (document.visibilityState === 'hidden') {
      // Out of sight is the best moment: nobody is looking at what reloads.
      reloadIfIdle()
      return
    }
    if (reloadIfIdle()) return
    if (staleFor || !clientBuildId() || Date.now() - lastHeardAt < RECHECK_AFTER_MS) return
    lastHeardAt = Date.now()
    void fetch('/api/version', { cache: 'no-store' })
      .then(async (res) => {
        noteResponseBuild(res)
        if (staleFor) return
        const body = (await res.json().catch(() => null)) as { buildId?: unknown } | null
        if (typeof body?.buildId === 'string') noteServerBuild(body.buildId)
      })
      .catch(() => {})
  }
  document.addEventListener('visibilitychange', onReturn)
  window.addEventListener('focus', onReturn)
}
