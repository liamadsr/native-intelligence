'use client'

import { useEffect, useState, type ComponentType, type ReactNode } from 'react'

/**
 * A component whose module is fetched the first time it mounts, and rendered
 * synchronously on every mount after that.
 *
 * For UI that is statically wired into the dashboard shell but only rarely has
 * anything to show (the onboarding tour, its spotlight): the gate that decides
 * whether to render stays in the shell, and the heavy module behind it leaves
 * the first-load bundle.
 *
 * Why not `next/dynamic` / `React.lazy`:
 *  - a lazy component suspends on its first render even when its module is
 *    already in memory, and React 19 throttles the reveal of a boundary that
 *    just showed its fallback by up to 300 ms (measured: 306 ms from a click to
 *    the content in the DOM, module preloaded). A tour card is meant to appear
 *    in the commit that opens it.
 *  - a failed chunk fetch throws to the nearest error boundary — for a surface
 *    mounted by the shell, the whole dashboard's.
 * Here there is no Suspense: until the module arrives the component renders
 * nothing (what the gated surfaces render while closed anyway), then re-renders
 * once with the real component; once loaded, every mount is a plain render. A
 * failed fetch renders nothing, and the next mount retries it. `onError` hears
 * of a failed fetch while a mount waits on it, for a gate that should give up
 * (and so unmount it, to retry on the next mount) rather than stay open over
 * nothing. `failed` is what a mount whose fetch failed shows instead of
 * nothing, for a surface that stays open around it (the bot bubble's chat):
 * it's handed `retry`, which fetches again, and the current props, so a
 * fallback can retain host actions while the feature is unavailable.
 */
export function lazyComponent<P extends object>(
  load: () => Promise<ComponentType<P>>,
  { onError, failed }: { onError?: (error: unknown) => void; failed?: (retry: () => void, props: P) => ReactNode } = {},
): ComponentType<P> & { preload: () => void } {
  let loaded: ComponentType<P> | undefined
  let pending: Promise<ComponentType<P>> | undefined

  function fetchOnce() {
    pending ??= load().then(
      (component) => (loaded = component),
      (error: unknown) => {
        pending = undefined
        throw error
      },
    )
    return pending
  }

  function LazyComponent(props: P) {
    // Read once at mount: a module that is already here renders in this commit.
    const [Component, setComponent] = useState(() => loaded)
    // The fetch this mount waited on failed: `failed` shows until a retry.
    const [attempt, setAttempt] = useState({ n: 0, failed: false })

    useEffect(() => {
      if (Component) return
      let live = true
      fetchOnce().then(
        (component) => {
          // Wrapped: a bare function passed to a state setter is an updater.
          if (live) setComponent(() => component)
        },
        (error: unknown) => {
          if (!live) return
          onError?.(error)
          if (failed) setAttempt((a) => ({ ...a, failed: true }))
        },
      )
      return () => {
        live = false
      }
    }, [Component, attempt.n])

    if (Component) return <Component {...props} />
    return attempt.failed && failed ? failed(() => setAttempt((a) => ({ n: a.n + 1, failed: false })), props) : null
  }

  // Fetches the module ahead of the first mount (a failure is retried by that mount).
  return Object.assign(LazyComponent, {
    preload: () => {
      if (!loaded) fetchOnce().catch(() => {})
    },
  })
}
