/**
 * Persona attribution for every marketing signup CTA.
 *
 * A signup that starts on a persona landing page should land the user in a
 * workspace shaped like that persona. The chain: this helper appends
 * `&edition=<id>` to the signup href → the login form cookies the id
 * (`signup_edition`) → `/api/analytics/auth-session` stamps it onto the first
 * workspace. The canonical edition definitions live in
 * `src/lib/editions/manifest.ts`.
 *
 * Note the `mode=signup` in `BASE_SIGNUP_HREF` is load-bearing, not cosmetic:
 * the login form only cookies the edition while the SIGNUP form is the active
 * intent, and the server only stamps a genuinely new signup's workspace (see
 * lib/editions/attribution.ts). An `&edition=` appended to a plain `/login`
 * would attribute nothing — which is the correct outcome for a link that isn't
 * a signup CTA.
 *
 * ATTRIBUTION IS BY PATHNAME. Each persona pitch has its own route
 * (/meeting-notes, /company-brain), and its CTAs carry its edition. The
 * homepage (`/`, the whole workspace: src/app/workspace-page.tsx) and every
 * other page (/pricing, /blog, /docs) send the bare href, and a cookieless
 * signup gets DEFAULT_SIGNUP_EDITION (lib/editions/attribution.ts): `full`,
 * the whole app. Until 2026-11-14 `/` was a PostHog A/B switch whose arms
 * declared their edition through a React context; it was retired with the
 * sales pitch, and the context with it.
 *
 * The ids are string literals rather than a VALUE import from `@/lib/editions`:
 * that module's public barrel re-exports the server-side resolver and the AI
 * tool-ceiling machinery, none of which belongs in a marketing client bundle
 * for what amounts to a few query-string suffixes. The `EditionId` TYPE is
 * imported, which costs nothing (`verbatimModuleSyntax` erases an
 * `import type`), and types the table below, so a literal that is not a real
 * EditionId fails the type check. An id this file got
 * wrong would be inert anyway — the login form validates against the manifest
 * and ignores what it doesn't recognize.
 */

'use client'

import { usePathname } from 'next/navigation'
import type { EditionId } from '@/lib/editions'

// /meeting-notes and /company-brain serve their own pitches, so their CTAs
// attribute through this table. /sales 308s to `/`, so nothing renders a CTA
// there today; its entry costs nothing and keeps the mapping right should a
// sales pitch get its own route back.
const PATH_EDITIONS: readonly { prefix: string; edition: EditionId }[] = [
  { prefix: '/sales', edition: 'sales' },
  { prefix: '/meeting-notes', edition: 'notes' },
  { prefix: '/company-brain', edition: 'brain' },
]

export const BASE_SIGNUP_HREF = '/login?mode=signup'

/**
 * The signup destination for a given edition id, or the bare href for `null`.
 */
export function signupHrefForEdition(edition: EditionId | null | undefined): string {
  return edition ? `${BASE_SIGNUP_HREF}&edition=${edition}` : BASE_SIGNUP_HREF
}

/**
 * The signup destination for a given pathname — `&edition=` appended when the
 * path is one of the persona landing pages, bare otherwise.
 *
 * Matches on prefix so sub-paths (`/sales/enterprise`) inherit their landing
 * page's attribution, with an exact-or-boundary check so a future unrelated
 * route like `/sales-tax` cannot accidentally claim it.
 */
export function signupHrefForPath(pathname: string | null | undefined): string {
  if (!pathname) return BASE_SIGNUP_HREF
  const match = PATH_EDITIONS.find(
    ({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  )
  return signupHrefForEdition(match?.edition)
}

/**
 * The signup href for the current route (see `signupHrefForPath`). Landing
 * pages have several CTA components apiece; this keeps each one to a single
 * import.
 */
export function useSignupHref(): string {
  return signupHrefForPath(usePathname())
}
