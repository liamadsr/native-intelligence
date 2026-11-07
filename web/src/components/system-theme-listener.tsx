'use client'

import { useEffect } from 'react'
import { applyThemeVariables, THEME_STORAGE_KEY } from '@/lib/themes'

/**
 * Always-mounted listener that keeps the app in sync with the OS appearance
 * (light/dark) in real time when the user is in "System" mode.
 *
 * Previously the only `prefers-color-scheme` listener lived inside the
 * Preferences page, so OS appearance changes were picked up only while that
 * page was mounted — everywhere else you had to refresh or navigate for the
 * theme to catch up. Mounting this in the root layout fixes it globally
 * (landing page + app, browser + desktop WebView) with no native message
 * needed: WKWebView/Tauri fire the standard `matchMedia` change event.
 *
 * "System" mode = no explicit `localStorage.theme` value. If the user has
 * pinned Light or Dark, OS changes are intentionally ignored.
 */
export function SystemThemeListener() {
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')

    const syncFromSystem = () => {
      // Only follow the OS when in System mode (no pinned light/dark choice).
      if (localStorage.getItem('theme')) return

      const isDark = mq.matches
      const root = document.documentElement
      if (isDark) {
        root.classList.add('dark')
        root.style.colorScheme = 'dark'
      } else {
        root.classList.remove('dark')
        root.style.colorScheme = 'light'
      }

      // Re-apply the active style's overrides — light/dark use different sets.
      const themeId = localStorage.getItem(THEME_STORAGE_KEY) || 'default'
      applyThemeVariables(themeId)
    }

    // Cross-tab/window sync: if the mode or style changes elsewhere, mirror it.
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'theme' || e.key === THEME_STORAGE_KEY) syncFromSystem()
    }

    mq.addEventListener('change', syncFromSystem)
    window.addEventListener('storage', onStorage)
    return () => {
      mq.removeEventListener('change', syncFromSystem)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  return null
}
