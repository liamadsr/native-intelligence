/**
 * Safe Tauri unlisten: the one way this app tears down a Tauri event listener.
 *
 * WHY. `@tauri-apps/api`'s `listen()` resolves with the event id from
 * `invoke('plugin:event|listen')` and hands back `async () => _unlisten(event,
 * id)`. `_unlisten` first runs the webview-side
 * `__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener(event, id)`, then
 * `invoke('plugin:event|unlisten')`. But the webview-side listener entry is
 * written by a script Rust evaluates into the page SEPARATELY from the invoke
 * reply (tauri `event/mod.rs` `listen_js_script`), so just after `listen()`
 * resolves that entry may not exist yet. `unlisten_js_script` only guards a
 * missing per-event table, not a missing id: when another listener for the
 * same event already made the table, it throws
 * `undefined is not an object (evaluating 'listeners[eventId].handlerId')`
 * (Chromium: `Cannot read properties of undefined (reading 'handlerId')`).
 * Anything that unlistens right after subscribing hits it: an effect cleaned
 * up before `listen()` resolved, which React StrictMode does on every dev
 * mount. Then the rejection goes unhandled (Next's dev overlay), the Rust-side
 * unlisten never runs (the listener leaks) and the JS callback stays live.
 *
 * WHAT.
 * - `safeUnlisten(fn)` calls an unlisten and never throws (sync or async). On
 *   the missing-listener error it tries again a few times within ~300 ms, so
 *   the registration script lands and the Rust-side unlisten still runs.
 * - `listenScoped(subscribe)` is the effect form: it subscribes and returns a
 *   synchronous, idempotent disposer that also works before the subscription
 *   resolves (it then unlistens once it does, a macrotask later). Handlers are
 *   GATED: wrap each handler in the `gate` it passes you and it stops firing
 *   the moment you dispose, even before the unlisten lands.
 *
 *     useEffect(() => listenScoped((gate) => tauriBridge.onX(gate(handle))), [])
 *
 * The bridge's own `listen` helpers already return `safeUnlisten`-wrapped
 * functions, so a bridge unlisten never throws either.
 */

/** Anything a Tauri subscribe resolves with. */
export type UnlistenLike = () => void | Promise<void>

/** Wraps a handler so it does nothing once the scope is disposed. */
export type Gate = <A extends unknown[]>(handler: (...args: A) => unknown) => (...args: A) => void

/** Waits between unlisten attempts after the missing-listener error (ms):
 *  the retries land at ~50, ~150 and ~300 ms. */
export const UNLISTEN_RETRY_DELAYS_MS: readonly number[] = [50, 100, 150]

/** Tauri's unregisterListener reading a listener entry that isn't there yet. */
export function isMissingListenerError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return message.includes('handlerId')
}

function debug(message: string, err: unknown): void {
  if (process.env.NODE_ENV === 'production') return
  try {
    console.debug(`[tauri-unlisten] ${message}`, err)
  } catch {
    /* no console */
  }
}

function attempt(fn: UnlistenLike, retry: number): void {
  const failed = (err: unknown) => {
    if (isMissingListenerError(err) && retry < UNLISTEN_RETRY_DELAYS_MS.length) {
      setTimeout(() => attempt(fn, retry + 1), UNLISTEN_RETRY_DELAYS_MS[retry])
      return
    }
    debug('unlisten failed', err)
  }
  let result: void | Promise<void>
  try {
    result = fn()
  } catch (err) {
    failed(err)
    return
  }
  if (result && typeof (result as Promise<void>).then === 'function') {
    ;(result as Promise<void>).then(undefined, failed)
  }
}

/** Call a Tauri unlisten. Never throws; swallows sync throws and rejections,
 *  and retries the missing-listener error so the listener doesn't leak. */
export function safeUnlisten(fn: UnlistenLike | null | undefined): void {
  if (typeof fn !== 'function') return
  attempt(fn, 0)
}

/** `fn` wrapped so calling it is `safeUnlisten(fn)`, for disposers handed on. */
export function toSafeUnlisten(fn: UnlistenLike): () => void {
  return () => safeUnlisten(fn)
}

/** One unlisten for several subscriptions (from `Promise.allSettled`, say):
 *  each fulfilled one goes through `safeUnlisten`, rejected ones are skipped. */
export function unlistenEach(
  fns: ReadonlyArray<UnlistenLike | PromiseSettledResult<UnlistenLike> | null | undefined>,
): () => void {
  const list = fns.flatMap((f) => {
    if (typeof f === 'function') return [f]
    if (f && typeof f === 'object' && f.status === 'fulfilled') return [f.value]
    return []
  })
  return () => {
    for (const fn of list.splice(0)) safeUnlisten(fn)
  }
}

/**
 * Subscribe now; return a synchronous disposer.
 * - Called before `subscribe` resolves: unlistens once it resolves, a
 *   macrotask later so the webview's registration script has landed.
 * - Idempotent. A rejected or throwing `subscribe` is swallowed (no event
 *   bridge on this build).
 * - Handlers wrapped in `gate` stop firing at dispose.
 */
export function listenScoped(
  subscribe: (gate: Gate) => Promise<UnlistenLike | null | undefined> | UnlistenLike | null | undefined,
): () => void {
  let disposed = false
  let unlisten: UnlistenLike | null = null
  const gate: Gate = (handler) => (...args) => {
    if (!disposed) handler(...args)
  }
  const resolved = (fn: UnlistenLike | null | undefined) => {
    if (typeof fn !== 'function') return
    if (disposed) setTimeout(() => safeUnlisten(fn), 0)
    else unlisten = fn
  }
  try {
    const out = subscribe(gate)
    if (out && typeof (out as Promise<UnlistenLike>).then === 'function') {
      ;(out as Promise<UnlistenLike | null | undefined>).then(resolved, (err: unknown) => {
        debug('subscribe failed', err)
      })
    } else {
      resolved(out as UnlistenLike | null | undefined)
    }
  } catch (err) {
    debug('subscribe failed', err)
  }
  return () => {
    if (disposed) return
    disposed = true
    const fn = unlisten
    unlisten = null
    safeUnlisten(fn)
  }
}

/** One disposer for several. Each runs once; it never throws. */
export function disposeAll(...disposers: Array<(() => void) | null | undefined>): () => void {
  return () => {
    for (const d of disposers.splice(0)) {
      try {
        d?.()
      } catch (err) {
        debug('dispose failed', err)
      }
    }
  }
}
