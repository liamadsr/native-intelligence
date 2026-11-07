'use client'

/**
 * Keeps this desktop window's backdrop in step with Preferences → Background
 * (lib/window-backdrop.ts): Glass makes the window see-through, every other
 * background keeps it opaque. Watches `<html data-app-bg>`, the `dark` class
 * (the HUD's frosted layer follows the theme) and the Opacity slider, in this
 * window and, through `storage` events, in the others (Preferences in the main
 * window drives the HUD's), and turns the window opaque again when it unmounts
 * so nothing outside the dashboard is see-through.
 * Mounted by the dashboard shell and the agent HUD (app/hud/agent). Renders
 * nothing; does nothing outside the desktop app.
 */

import { useEffect } from 'react'
import { BACKGROUND_STORAGE_KEY, getStoredBackgroundId, isGlassBackground } from '@/lib/app-background'
import { isDesktopApp } from '@/lib/platform'
import {
  GLASS_OPACITY_EVENT,
  GLASS_OPACITY_STORAGE_KEY,
  applyGlassTint,
  getGlassOpacity,
  glassLayers,
  reflectWindowBackdrop,
  setNativeWindowBackdrop,
} from '@/lib/window-backdrop'

export function WindowBackdropSync() {
  useEffect(() => {
    if (!isDesktopApp()) return
    const root = document.documentElement
    let lastKey: string | null = null
    // Calls can overlap (a slider drag): only the newest one's answer is
    // reflected onto the page.
    let seq = 0

    const sync = () => {
      const glass = isGlassBackground(root.getAttribute('data-app-bg'))
      const dark = root.classList.contains('dark')
      const blur = glassLayers(getGlassOpacity()).blur
      const key = glass ? `glass:${blur}:${dark}` : 'off'
      if (key === lastKey) return
      // Going opaque: drop the page's transparency first, so nothing flashes
      // the desktop through an opaque-again window in between.
      if (!glass) reflectWindowBackdrop(false, true)
      // Off is only worth a call once Glass was on.
      if (!glass && lastKey === null) {
        lastKey = key
        return
      }
      lastKey = key
      const mine = ++seq
      void setNativeWindowBackdrop(glass ? 'glass' : 'off', blur, dark).then((ok) => {
        if (mine !== seq) return
        reflectWindowBackdrop(glass, ok)
      })
    }

    // Another window changed the background or the slider (localStorage is
    // shared): follow it here. The attribute change re-runs sync above.
    const onStorage = (e: StorageEvent) => {
      if (e.key === BACKGROUND_STORAGE_KEY || e.key === null) {
        root.setAttribute('data-app-bg', getStoredBackgroundId())
      }
      if (e.key === GLASS_OPACITY_STORAGE_KEY || e.key === null) {
        applyGlassTint(getGlassOpacity())
        sync()
      }
    }

    sync()
    const mo = new MutationObserver(sync)
    mo.observe(root, { attributes: true, attributeFilter: ['data-app-bg', 'class'] })
    window.addEventListener(GLASS_OPACITY_EVENT, sync)
    window.addEventListener('storage', onStorage)
    return () => {
      mo.disconnect()
      window.removeEventListener(GLASS_OPACITY_EVENT, sync)
      window.removeEventListener('storage', onStorage)
      seq++
      if (lastKey !== null && lastKey !== 'off') {
        reflectWindowBackdrop(false, true)
        void setNativeWindowBackdrop('off')
      }
    }
  }, [])

  return null
}
