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
 * The same call checks join-by-email-domain once per sign-in; when a
 * workspace on the person's domain is on offer, the page goes to /join/team.
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
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { joinOffer?: boolean } | null) => {
        // Workspaces on the person's email domain are on offer (checked once
        // per sign-in): show them, one click each.
        if (body?.joinOffer) window.location.assign('/join/team')
      })
      .catch(() => {})
  }, [])

  return null
}
