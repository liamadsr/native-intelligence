'use client'

import { useEffect } from 'react'
import { mediaMatches, subscribeMedia } from '@/lib/media-query'

/**
 * Keep a floating window's theme (the agent HUD, the dictation panel) in step
 * with the app's, live. The app stores it in localStorage 'theme' ('dark' |
 * 'light' | unset = follow the system) and puts .dark on <html>. 'storage'
 * fires here when the app's window writes it (storage is shared); the media
 * query covers system mode; and the window re-reads whenever it is shown or
 * focused, so it can never stay on a stale theme. (The root layout's listener
 * follows only system mode.)
 */
export function useHudTheme() {
  useEffect(() => {
    const DARK = '(prefers-color-scheme: dark)'
    const apply = () => {
      try {
        const theme = localStorage.getItem('theme')
        const dark = theme === 'dark' || (!theme && mediaMatches(DARK))
        document.documentElement.classList.toggle('dark', dark)
      } catch {
        /* storage unavailable */
      }
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === 'theme') apply()
    }
    apply()
    window.addEventListener('storage', onStorage)
    const offMedia = subscribeMedia(DARK, apply)
    document.addEventListener('visibilitychange', apply)
    window.addEventListener('focus', apply)
    return () => {
      window.removeEventListener('storage', onStorage)
      offMedia()
      document.removeEventListener('visibilitychange', apply)
      window.removeEventListener('focus', apply)
    }
  }, [])
}
