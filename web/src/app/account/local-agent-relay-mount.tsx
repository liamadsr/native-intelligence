'use client'

/**
 * Mounts the local-agent relay (useLocalAgentRelay; l1-contract E) once for
 * all /account/* routes, via AccountProviders. It resolves the signed-in user
 * itself; the hook runs only in the desktop's main window, so a Mac has one
 * relay however many windows are open. Renders nothing.
 *
 * The person's name rides along for the `[From <first name>]` prefix on
 * their messages to a local agent.
 */
import { useEffect, useState } from 'react'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/client'
import { isDesktopApp } from '@/lib/platform'
import { useLocalAgentRelay } from '@/hooks/use-local-agent-relay'

interface Person {
  id: string
  name: string | null
}

function personOf(user: User | null | undefined): Person | null {
  if (!user) return null
  const meta = (user.user_metadata ?? {}) as { full_name?: unknown; name?: unknown }
  const name = typeof meta.full_name === 'string' ? meta.full_name : typeof meta.name === 'string' ? meta.name : null
  return { id: user.id, name }
}

export function LocalAgentRelayMount() {
  const [person, setPerson] = useState<Person | null>(null)

  useEffect(() => {
    if (!isDesktopApp()) return
    const supabase = createClient()
    let active = true
    // Token refreshes fire the listener with the same person: keep the object.
    const apply = (next: Person | null) =>
      setPerson((prev) => (prev?.id === next?.id && prev?.name === next?.name ? prev : next))
    // An errored lookup (offline, a token mid-refresh) is not a sign-out; the listener covers it.
    void supabase.auth.getUser().then(({ data, error }) => {
      if (active && !error) apply(personOf(data.user))
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => apply(personOf(session?.user)))
    return () => {
      active = false
      sub.subscription.unsubscribe()
    }
  }, [])

  useLocalAgentRelay(person?.id ?? null, person?.name ?? null)
  return null
}
