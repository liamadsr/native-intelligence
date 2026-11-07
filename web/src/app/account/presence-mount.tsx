'use client'

/**
 * Starts the presence client (src/lib/presence/client.ts,
 * docs/plans/reach-follows-you.md §1) once for all /account/* routes, via
 * AccountProviders, for the signed-in person: on the web and in every desktop
 * window (the client itself decides that only the desktop's main window reads
 * the Mac's idle time). It resolves the person the way LocalAgentRelayMount
 * does, and starts nothing while nobody is signed in. Renders nothing.
 */
import { useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { startPresence } from '@/lib/presence/client'

export function PresenceMount() {
  const [userId, setUserId] = useState<string | null>(null)

  useEffect(() => {
    const supabase = createClient()
    let active = true
    // An errored lookup (offline, a token mid-refresh) is not a sign-out; the listener covers it.
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
    return startPresence(userId)
  }, [userId])

  return null
}
