'use client'

import { useSyncExternalStore } from 'react'
import { desktopOS, hasTrafficLights, isDesktopApp, type DesktopOS } from '@/lib/platform'

// Hydration-safe "are we on the client yet?" gate. getServerSnapshot returns
// false so SSR and the FIRST client render agree; it flips to true only on the
// post-hydration pass. This matters because `useIsDesktop` gates whether large
// Radix (Tooltip/Dialog) subtrees mount in the top bar — flipping it during the
// hydration render itself would shift every later Radix `useId`, producing an
// `aria-controls` hydration mismatch on unrelated popovers (e.g. the chat
// input). Deferring the flip to after hydration keeps the id counter stable.
// Exported so other deferred controls (CaptureBarButton, in the top bar) share
// one gate.
export const subscribeMounted = () => () => {}
export const getMountedSnapshot = () => true
export const getMountedServerSnapshot = () => false

/**
 * Hook to detect the desktop (Tauri) app. Returns false during SSR and the
 * first client render — the desktop check only resolves on the post-hydration
 * pass — so consumers that conditionally mount id-consuming subtrees don't
 * shift the Radix `useId` counter during hydration. Use in client components
 * that need to adjust layout for the titlebar overlay.
 */
export function useIsDesktop() {
  const mounted = useSyncExternalStore(
    subscribeMounted,
    getMountedSnapshot,
    getMountedServerSnapshot,
  )
  return mounted && isDesktopApp()
}

/**
 * Hook: is this the macOS desktop app, whose traffic lights overlay the
 * page's top-left corner? Hydration-safe like {@link useIsDesktop} (false on
 * the server and the first client render). False in the Windows app, which
 * has a native title bar above the page.
 */
export function useHasTrafficLights() {
  const mounted = useSyncExternalStore(
    subscribeMounted,
    getMountedSnapshot,
    getMountedServerSnapshot,
  )
  return mounted && hasTrafficLights()
}

/**
 * Hook: which desktop app this is ('macos' | 'windows'), null outside it.
 * Hydration-safe like {@link useIsDesktop} (null on the server and the first
 * client render).
 */
export function useDesktopOS(): DesktopOS | null {
  const mounted = useSyncExternalStore(
    subscribeMounted,
    getMountedSnapshot,
    getMountedServerSnapshot,
  )
  return mounted ? desktopOS() : null
}
