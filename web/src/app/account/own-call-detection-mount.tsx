'use client'

/**
 * Starts the desktop's own-call watch (src/lib/desktop-own-call.ts) for the
 * signed-in person: while he is in one of our own calls, anywhere, the
 * desktop's meeting detection neither prompts nor auto-records (the server
 * records the call itself). Does anything only in the desktop's main window.
 * Resolves the person the way PresenceMount does. Renders nothing.
 */
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { isDesktopApp } from '@/lib/platform'
import { startDesktopOwnCallWatch } from '@/lib/desktop-own-call'

export function OwnCallDetectionMount() {
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    if (!isDesktopApp()) return
    const supabase = createClient()
    let active = true
    void supabase.auth.getUser().then(({ data, error }) => {
      if (active && !error) setUserId(data.user?.id ?? null)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => setUserId(session?.user?.id ?? null))
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!userId) return
    return startDesktopOwnCallWatch(userId, createClient())
  }, [userId])

  return null
}
