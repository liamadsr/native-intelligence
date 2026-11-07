'use client'

import { useEffect } from 'react'

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
    let mq: MediaQueryList | null = null
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)')
    } catch {
      /* no matchMedia */
    }
    const apply = () => {
      try {
        const theme = localStorage.getItem('theme')
        const dark = theme === 'dark' || (!theme && !!mq?.matches)
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
    mq?.addEventListener?.('change', apply)
    document.addEventListener('visibilitychange', apply)
    window.addEventListener('focus', apply)
    return () => {
      window.removeEventListener('storage', onStorage)
      mq?.removeEventListener?.('change', apply)
      document.removeEventListener('visibilitychange', apply)
      window.removeEventListener('focus', apply)
    }
  }, [])
}
