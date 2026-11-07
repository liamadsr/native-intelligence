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
 * TWO SOURCES OF TRUTH, IN PRECEDENCE ORDER: CONTEXT, THEN PATHNAME.
 *
 * The landing-page components do not map 1:1 to routes. `/` goes through the
 * `landing-page-variant` A/B switch (src/app/landing-variant-switch.tsx), whose
 * four arms are the sales pitch — the homepage, and the fallback render — plus
 * the meeting-notes, company-brain, and classic pitches. Those three were
 * retired in the sales pivot and later restored from git history; the flag
 * holds them at 0%. Meeting-notes and company-brain ALSO render at their own
 * routes, /meeting-notes and /company-brain, while /sales 308s to `/`.
 *
 * So the same component can be serving its own route or a homepage bucket. On
 * `/` the pathname cannot know which pitch rendered, so `SignupEditionProvider`
 * declares it, and a non-null context value WINS over the pathname. The rule is
 * "attribute the pitch the visitor actually saw".
 *
 * Standalone routes mount no provider, so context is absent there and the
 * pathname mapping below stands.
 *
 * Paths with no entry and no provider get the bare href. That is the
 * deliberate default: an unattributed signup resolves to the `full` edition,
 * i.e. today's app. It is now a narrow case — /pricing, /blog, /docs — rather
 * than the homepage's.
 *
 * The ids are string literals rather than a VALUE import from `@/lib/editions`:
 * that module's public barrel re-exports the server-side resolver and the AI
 * tool-ceiling machinery, none of which belongs in a marketing client bundle
 * for what amounts to four query-string suffixes. The `EditionId` TYPE is
 * imported, which costs nothing — `verbatimModuleSyntax` guarantees an
 * `import type` is erased outright — and it is what makes the provider's value
 * checkable. `__tests__/signup-href.test.ts` still asserts every literal here
 * is a real EditionId, so the two cannot drift silently. An id this file got
 * wrong would be inert anyway — the login form validates against the manifest
 * and ignores what it doesn't recognize.
 *
 * Note the ids here are four distinct personas: editions are a PRODUCT concept
 * (see lib/editions/manifest.ts), so a signup from the meeting-notes pitch gets
 * a `notes`-shaped workspace and one from company-brain a `brain`-shaped one.
 */

'use client'

import { createContext, useContext } from 'react'
import { usePathname } from 'next/navigation'
import type { EditionId } from '@/lib/editions'

// /meeting-notes and /company-brain serve their own pitches, so their CTAs
// attribute through this table. /sales 308s to `/` — the sales pitch IS the
// homepage — so nothing renders a CTA there today; its entry costs nothing and
// means the mapping is already right if that pitch ever gets its own route
// back.
const PATH_EDITIONS: readonly { prefix: string; edition: string }[] = [
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
  return match ? `${BASE_SIGNUP_HREF}&edition=${match.edition}` : BASE_SIGNUP_HREF
}

/**
 * The `landing-page-variant` keys and the edition each one's pitch sells.
 *
 * All four arms render again. The sales pivot retired three of them, but kept
 * their entries here as the pattern for reviving a persona — restore the page
 * component, add its arm to the switch, add its key to LIVE_VARIANTS below —
 * and that is exactly how they came back.
 *
 * This lives here rather than in `src/app/landing-variant-switch.tsx` — its
 * only consumer — purely so it stays testable: that module imports all four
 * landing pages and `posthog-js/react`, and pulling that graph into a unit test
 * to assert a lookup table would be absurd. This file is a leaf.
 */
export const VARIANT_EDITIONS = {
  'note-taker': 'notes',
  sales: 'sales',
  'company-brain': 'brain',
  // The whole product, not a persona. Declared explicitly rather than `null`:
  // a null arm sends a bare CTA, and since the sales pivot a cookieless fresh
  // signup is stamped `sales` (DEFAULT_SIGNUP_EDITION in
  // lib/editions/attribution.ts) — the wrong workspace for a page that pitches
  // projects and AI execution. Before the pivot, `null` meant `full`; this
  // keeps that outcome.
  classic: 'full',
} as const satisfies Record<string, EditionId | null>

export type LandingVariantKey = keyof typeof VARIANT_EDITIONS

/**
 * The edition to attribute a signup to for a given raw flag value.
 *
 * The rule is "attribute the pitch the visitor actually saw", and the switch's
 * fallback render is the sales page, so:
 *
 *   • A LIVE known key → its own edition from the table.
 *   • No key at all — flag unresolved, PostHog blocked, SSR — → `sales`,
 *     because the visitor is looking at the sales fallback. This is the
 *     majority path on first paint, and it is a real sales-pitch signup.
 *   • An UNKNOWN key — a variant added in the PostHog dashboard that this build
 *     does not ship — → `sales` too: whatever the key says, the sales fallback
 *     is what renders and what the visitor reads.
 *   • A RETIRED known key — in the table but not in LIVE_VARIANTS; none today —
 *     → also `sales`. The table maps it to its own edition, but a table lookup
 *     answers "what does this pitch sell", and the question here is "what did
 *     this visitor read": with its page gone from the build, the switch renders
 *     the sales fallback for that key. Trusting the table would stamp `notes`
 *     on a workspace whose owner never saw the notes pitch. So the lookup is
 *     gated on the arm being LIVE.
 *
 * REVIVING A PERSONA: restore its page component, add its arm to
 * LandingVariantSwitch, and add its key to LIVE_VARIANTS below. Miss that last
 * step and the pitch renders while its signups attribute to `sales` — the
 * failure is silent, which is why the list sits next to this comment.
 */
const LIVE_VARIANTS: readonly LandingVariantKey[] = [
  'note-taker',
  'sales',
  'company-brain',
  'classic',
]

export function editionForVariant(variant: unknown): EditionId | null {
  if (
    typeof variant === 'string' &&
    (LIVE_VARIANTS as readonly string[]).includes(variant)
  ) {
    return VARIANT_EDITIONS[variant as LandingVariantKey]
  }
  // Unresolved, non-string, unknown, and retired keys alike: the sales fallback
  // is what rendered, so the sales edition is what the visitor's signup means.
  return 'sales'
}

/**
 * The edition a rendered pitch declares for itself, overriding the pathname.
 *
 * `null` — the default, and what every unwrapped subtree sees — means "no
 * declaration", NOT "no edition": the hook falls through to the pathname, which
 * is what keeps any page rendered outside the homepage switch (today:
 * /meeting-notes and /company-brain) attributing by path.
 */
const SignupEditionContext = createContext<EditionId | null>(null)

export function SignupEditionProvider({
  edition,
  children,
}: {
  edition: EditionId | null
  children: React.ReactNode
}) {
  return <SignupEditionContext.Provider value={edition}>{children}</SignupEditionContext.Provider>
}

/**
 * Resolve the signup href from the two sources, context first.
 *
 * Exported for tests: it is the whole precedence rule with neither React nor
 * the router in the way.
 */
export function resolveSignupHref(
  contextEdition: EditionId | null | undefined,
  pathname: string | null | undefined
): string {
  return contextEdition ? signupHrefForEdition(contextEdition) : signupHrefForPath(pathname)
}

/**
 * The signup href for the current render — the enclosing
 * `SignupEditionProvider`'s edition when there is one, otherwise the current
 * route's. Landing pages have several CTA components apiece; this keeps each
 * one to a single import instead of threading either source down through them.
 */
export function useSignupHref(): string {
  return resolveSignupHref(useContext(SignupEditionContext), usePathname())
}
