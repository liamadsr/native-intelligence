'use client'

import { useEffect } from 'react'

// Module-level guard (not a ref): survives React StrictMode's deliberate
// double-invoke of effects AND any remount within the same page load, so the
// POST fires at most once per full-page load. The server cookie is the real
// cross-load dedup — this only avoids a redundant in-flight duplicate.
let pinged = false

/**
 * Fires the server-side auth-session tracker exactly once per page load.
 *
 * Mounted on the first authenticated surface every sign-in reaches — the
 * trial wall (/account/start-trial, where a new signup lands first), the
 * onboarding wizard, and the dashboard shell. It POSTs to a Route Handler
 * (the one Next 16 context where the dedup cookie can be written legally;
 * Server Components can read cookies but not set them). The handler decides
 * signup-vs-login from the live Supabase session and dedups via an httpOnly
 * cookie, so every auth method — OAuth, password, magic link, returning
 * session — is counted exactly once.
 *
 * Fail-soft: a rejected fetch is swallowed. Analytics must never break the app.
 */
export function AuthSessionPinger() {
  useEffect(() => {
    if (pinged) return
    pinged = true
    fetch('/api/analytics/auth-session', {
      method: 'POST',
      credentials: 'same-origin',
      keepalive: true,
    }).catch(() => {})
  }, [])

  return null
}
