'use client'

import { useFeatureFlagVariantKey } from 'posthog-js/react'
import { SignupEditionProvider, editionForVariant } from '@/components/signup-href'
import CompanyBrainPage from './company-brain/company-brain-page'
import MeetingNotesPage from './meeting-notes/meeting-notes-page'
import SalesPage from './sales-page'
import LandingPage from './landing-page'

/**
 * PostHog variant switch for the root landing page.
 *
 * Flag key: `landing-page-variant` (multivariate), four arms:
 *
 *   • `sales`         → ./sales-page.tsx — the homepage pitch, and the
 *                       fallback for every unresolved state (see below).
 *   • `note-taker`    → ./meeting-notes/meeting-notes-page.tsx
 *   • `company-brain` → ./company-brain/company-brain-page.tsx
 *   • `classic`       → ./landing-page.tsx (the original landing page)
 *
 * Weights live in the PostHog dashboard, not here. The sales pivot pinned the
 * flag to `sales` at 100% and deleted the other three pages; they were later
 * restored from git history and their arms re-added here, with the dashboard
 * still holding them at 0%. So `/` shows the sales pitch to everyone until a
 * weight is raised — which is all it takes to put a pitch back in rotation.
 * Meeting-notes and company-brain are also served at their own routes
 * (/meeting-notes, /company-brain) regardless of the flag.
 *
 * EVERY other state — no flag, PostHog blocked or not yet loaded, SSR, or a
 * variant key added in the dashboard that this build does not ship — renders
 * DEFAULT_VARIANT, the sales page. That is the one deliberate departure from
 * the pre-pivot switch, whose fallback was meeting-notes: the fallback is what
 * crawlers and first paint get, so it is the homepage's own pitch.
 *
 * All four page components are safe to render here: each is a client component
 * whose only side effect is the same `isDesktopApp()` → `/login` redirect, and
 * each renders its full marketing HTML on the server regardless.
 *
 * ADDING AN ARM is two edits, and the second is easy to forget: an entry in
 * VARIANTS below, AND the variant key in `LIVE_VARIANTS` in
 * `@/components/signup-href` (plus its edition in VARIANT_EDITIONS if new).
 * Without the second, the new pitch renders while its signups attribute to
 * `sales`.
 *
 * SSR always emits the sales HTML (the hook returns undefined on the server);
 * a visitor bucketed into another arm swaps client-side once the flag
 * evaluates. At 0% nobody is, so there is no flash in practice. If one starts
 * to matter, the fix is PostHog flag bootstrapping, not a loading screen —
 * crawlers must always get full marketing HTML.
 *
 * SIGNUP ATTRIBUTION. Whatever renders is wrapped in `SignupEditionProvider`
 * with the edition that pitch sells, which every CTA's `useSignupHref()` reads
 * in preference to the pathname (`/` maps to nothing). The rule is "attribute
 * the pitch the visitor actually saw", so the fallback render carries `sales`
 * and each other arm carries its own. The key → edition table lives in
 * `@/components/signup-href` (`editionForVariant`), next to the hook that
 * consumes it and where a unit test can reach it without dragging all four
 * landing pages into its module graph.
 */

/**
 * The arms this build can render, as already-constructed elements keyed by
 * `landing-page-variant` value.
 *
 * ELEMENTS, NOT COMPONENT REFERENCES, on purpose. Selecting a component type
 * into a local and rendering `<Variant />` trips the React compiler's "Cannot
 * create components during render" rule, and would also remount the subtree
 * whenever the flag resolves. Elements are inert values: picking one is an
 * object lookup, and React reconciles by type as usual.
 */
const VARIANTS: Record<string, React.ReactElement> = {
  'note-taker': <MeetingNotesPage />,
  sales: <SalesPage />,
  'company-brain': <CompanyBrainPage />,
  classic: <LandingPage />,
}

/** What every unresolved, unknown, or retired key renders. */
const DEFAULT_VARIANT = <SalesPage />

export function LandingVariantSwitch() {
  const variant = useFeatureFlagVariantKey('landing-page-variant')
  const edition = editionForVariant(variant)

  // Own-property lookup only: a flag value like `toString` must not resolve to
  // something off Object.prototype.
  const rendered =
    typeof variant === 'string' &&
    Object.prototype.hasOwnProperty.call(VARIANTS, variant)
      ? VARIANTS[variant]
      : DEFAULT_VARIANT

  return <SignupEditionProvider edition={edition}>{rendered}</SignupEditionProvider>
}
