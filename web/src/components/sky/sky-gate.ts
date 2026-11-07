'use client'

/**
 * Which motion the shell backdrop runs: the live sky when it's the app's
 * background (Preferences → Background → Sky, `<html data-app-bg="sky">`, the
 * default, or, in dev, a `?sky=` / `?skyTime=` override in the URL), the
 * dotted twinkle otherwise. Tiny on purpose: the dashboard shell reads it
 * statically and fetches the WebGL module only when it's the sky.
 *
 * Three states. The server can't know, so it (and hydration) says `null`:
 * the shell renders no motion at all until the client knows which, so
 * neither the sky nor the dots starts its loop and listeners only to be torn
 * down a frame later. The plain backdrop colour shows meanwhile.
 */

import { useSyncExternalStore } from 'react'
import { SKY_BACKGROUND_ID, isGlassBackground } from '@/lib/app-background'
import { GLASS_WINDOW_UNSUPPORTED_ATTR } from '@/lib/window-backdrop'

/** 'none' on Glass: the window is see-through, nothing moves behind the page.
 * A desktop too old for Glass shows the Sky instead. */
export type BackdropMotionKind = 'sky' | 'dots' | 'none'

function readKind(): BackdropMotionKind {
  const bg = document.documentElement.getAttribute('data-app-bg')
  if (bg === SKY_BACKGROUND_ID) return 'sky'
  if (isGlassBackground(bg)) {
    return document.documentElement.hasAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR) ? 'sky' : 'none'
  }
  if (process.env.NODE_ENV !== 'production') {
    const params = new URLSearchParams(window.location.search)
    if (params.has('sky') || params.has('skyTime')) return 'sky'
  }
  return 'dots'
}

function subscribe(onChange: () => void): () => void {
  const mo = new MutationObserver(onChange)
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-app-bg', GLASS_WINDOW_UNSUPPORTED_ATTR] })
  return () => mo.disconnect()
}

const unknownOnServer = (): BackdropMotionKind | null => null

/** 'sky', 'dots' or 'none' on the client; null on the server and during hydration. */
export function useBackdropMotionKind(): BackdropMotionKind | null {
  return useSyncExternalStore<BackdropMotionKind | null>(subscribe, readKind, unknownOnServer)
}
