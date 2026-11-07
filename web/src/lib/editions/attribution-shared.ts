/**
 * The one piece of signup attribution both sides of the wire need to agree on.
 *
 * WHY this file exists rather than living in attribution.ts next to the logic:
 * attribution.ts imports the server PostHog client (and, lazily, the
 * service-role Supabase client) at module scope, so a `'use client'` component
 * cannot import from it at all. The login form is the WRITER of this cookie and
 * the auth-session route is its READER; before this split the writer hardcoded
 * the string literal and the two could silently drift apart.
 *
 * Nothing server-only may be added here — it is imported by client code.
 */

/**
 * Cookie carrying the edition a signup was attributed to. Short-lived (1h):
 * long enough to survive an OAuth round-trip and a slow first onboarding load,
 * short enough that a stale one can't re-attribute a much later workspace.
 * Not httpOnly — it is written by the client login form.
 */
export const SIGNUP_EDITION_COOKIE = 'signup_edition'

/** Cookie lifetime in seconds. The login form writes it with this max-age; the
 *  server's freshness windows (see attribution.ts) are aligned to it, so an
 *  expired cookie and an out-of-window stamp can never disagree. */
export const SIGNUP_EDITION_COOKIE_MAX_AGE_SECONDS = 3600
