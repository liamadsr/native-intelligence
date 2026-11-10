import { describe, it, expect } from 'vitest'
import {
  signupHrefForEdition,
  signupHrefForPath,
  resolveSignupHref,
  editionForVariant,
  VARIANT_EDITIONS,
} from '../signup-href'
import { EDITION_IDS } from '@/lib/editions'

/**
 * Funnel wiring — the edition attribution shared by the navbar and every
 * landing-page CTA, from its two sources in precedence order.
 *
 * It has to exist because the landing-page components do not map 1:1 to
 * routes. '/' is the `landing-page-variant` A/B switch: the sales pitch (also
 * the fallback render) plus the meeting-notes, company-brain, and classic
 * pitches, restored after the sales pivot retired them. meeting-notes-page.tsx
 * and company-brain-page.tsx ALSO serve /meeting-notes and /company-brain, so a
 * constant href per component would attribute every homepage signup to
 * whichever component happened to be shared.
 *
 * The pathname is the default source; on '/' it deliberately knows nothing, and
 * `SignupEditionProvider` (fed by the switch) supplies the answer instead. The
 * product rule under test throughout is "attribute the pitch the visitor
 * actually saw" — which is why an unresolved or unknown flag value attributes
 * `sales`: the sales fallback is what renders for it.
 *
 * The assertions that carry weight:
 *
 *   1. Context beats pathname when present; absent/null context falls through
 *      to the pathname, so the standalone routes attribute by path.
 *   2. Unmapped paths — '/' above all — stay BARE with no provider.
 *   3. Every arm in the table is LIVE and attributes its own edition. An arm
 *      missing from LIVE_VARIANTS would render its pitch while its signups
 *      silently attributed `sales`.
 *   4. Every edition id emitted is a real EditionId. The values are written as
 *      string literals to keep the manifest barrel (which re-exports the
 *      server-side resolver and the AI tool-ceiling machinery) out of the
 *      marketing bundle, so this test is what keeps the two from drifting.
 */
describe('signupHrefForPath', () => {
  it('attributes each persona landing route to its own edition', () => {
    // /meeting-notes and /company-brain serve their pitches directly. /sales
    // 308s to '/' (the sales pitch is the homepage), so its entry only keeps the
    // mapping right should that pitch get its own route back.
    expect(signupHrefForPath('/sales')).toBe('/login?mode=signup&edition=sales')
    expect(signupHrefForPath('/meeting-notes')).toBe('/login?mode=signup&edition=notes')
    expect(signupHrefForPath('/company-brain')).toBe('/login?mode=signup&edition=brain')
  })

  it('leaves the homepage and every other unmapped path unattributed', () => {
    // '/' maps to NOTHING by pathname, deliberately: it is the A/B switch, and
    // two of its arms are the very components whose own routes DO attribute.
    // The homepage's attribution comes from the provider (see
    // resolveSignupHref below), because the switch is what knows what rendered.
    for (const path of ['/', '/pricing', '/blog', '/docs', '/blog/some-post']) {
      expect(signupHrefForPath(path)).toBe('/login?mode=signup')
    }
  })

  it('degrades to the bare href when the pathname is unavailable', () => {
    // usePathname() can hand back null outside an app-router render.
    expect(signupHrefForPath(null)).toBe('/login?mode=signup')
    expect(signupHrefForPath(undefined)).toBe('/login?mode=signup')
    expect(signupHrefForPath('')).toBe('/login?mode=signup')
  })

  it('matches sub-paths but not merely similar prefixes', () => {
    expect(signupHrefForPath('/sales/enterprise')).toBe('/login?mode=signup&edition=sales')
    // A future unrelated route must not inherit /sales' attribution.
    expect(signupHrefForPath('/sales-tax')).toBe('/login?mode=signup')
    expect(signupHrefForPath('/meeting-notes-old')).toBe('/login?mode=signup')
  })

  it('only ever emits ids the manifest actually defines', () => {
    for (const path of ['/sales', '/meeting-notes', '/company-brain']) {
      const edition = new URL(signupHrefForPath(path), 'https://nativeintelligence.dev').searchParams.get(
        'edition'
      )
      expect(EDITION_IDS as readonly string[]).toContain(edition)
    }
  })
})

describe('editionForVariant', () => {
  it('maps every A/B arm to the edition its pitch sells', () => {
    expect(editionForVariant('note-taker')).toBe('notes')
    expect(editionForVariant('sales')).toBe('sales')
    expect(editionForVariant('company-brain')).toBe('brain')
    // The classic page sells the whole product, not a persona, so it declares
    // `full` outright. A null declaration would send a bare CTA, and a
    // cookieless fresh signup is stamped with the `sales` default.
    expect(editionForVariant('classic')).toBe('full')
  })

  it('attributes the UNRESOLVED flag to sales, because that is what renders', () => {
    // SSR, PostHog blocked, or simply not evaluated yet: the visitor is looking
    // at the sales page. Attributing the pitch they actually read is the whole
    // point — the alternative (neutral) would lose the majority of homepage
    // signups to `full`.
    expect(editionForVariant(undefined)).toBe('sales')
    expect(editionForVariant(null)).toBe('sales')
  })

  it('treats every arm in the table as LIVE', () => {
    // editionForVariant gates the table lookup on LIVE_VARIANTS, so a key that
    // is in the table but missing from that list falls through to `sales`: its
    // pitch renders while its signups are stamped with an edition its visitor
    // never saw. Nothing else would catch that, so pin it for every key.
    for (const [key, edition] of Object.entries(VARIANT_EDITIONS)) {
      expect(editionForVariant(key)).toBe(edition)
    }
  })

  it('attributes a variant key this build does not ship to sales', () => {
    // The flag is edited in the PostHog dashboard, so a key can exist in
    // production before any code knows it. The switch renders the sales
    // fallback for it, so sales is the pitch the visitor actually read.
    expect(editionForVariant('pricing-led')).toBe('sales')
    expect(editionForVariant('')).toBe('sales')
    // PostHog types the value as string | boolean; `true` is not a pitch, but
    // the sales page is still what the visitor is looking at.
    expect(editionForVariant(true)).toBe('sales')
  })

  it('is not fooled by inherited Object.prototype keys', () => {
    // These must not resolve to something off the prototype chain. They land on
    // the same `sales` default as any other unknown key — the point is that
    // they take the DEFAULT path rather than finding a bogus table entry.
    expect(editionForVariant('toString')).toBe('sales')
    expect(editionForVariant('constructor')).toBe('sales')
  })

  it('never returns null, so no homepage signup falls to the cookieless default', () => {
    // A null declaration yields a bare CTA, and a bare CTA's fresh signup is
    // stamped `sales` by default — right for the sales fallback, wrong for any
    // other pitch. So every arm declares its edition, classic included. The
    // `| null` in the signature is kept for a future arm that means it.
    const arms = ['sales', 'note-taker', 'company-brain', 'classic']
    for (const v of [...arms, undefined, null, '', 'nope', true, 42, {}]) {
      expect(editionForVariant(v)).not.toBeNull()
    }
  })

  it('only ever names ids the manifest actually defines', () => {
    for (const edition of Object.values(VARIANT_EDITIONS)) {
      if (edition === null) continue
      expect(EDITION_IDS as readonly string[]).toContain(edition)
    }
  })
})

describe('resolveSignupHref', () => {
  it('prefers a non-null context edition over the pathname', () => {
    // The homepage case this exists for: '/' maps to nothing, and the A/B
    // switch declares what was rendered.
    expect(resolveSignupHref('sales', '/')).toBe('/login?mode=signup&edition=sales')
    expect(resolveSignupHref('brain', '/')).toBe('/login?mode=signup&edition=brain')
    expect(resolveSignupHref('notes', '/')).toBe('/login?mode=signup&edition=notes')
  })

  it('lets context override a pathname that maps to a DIFFERENT edition', () => {
    // Not a real route today, but it is the assertion that proves precedence
    // rather than mere fallthrough: if these agreed, the test would prove
    // nothing about which source won.
    expect(resolveSignupHref('brain', '/sales')).toBe('/login?mode=signup&edition=brain')
  })

  it('falls through to the pathname when context is absent or null', () => {
    // Standalone routes mount no provider — useContext hands back the `null`
    // default — so they must keep attributing exactly as they did before the
    // context existed.
    for (const absent of [null, undefined] as const) {
      expect(resolveSignupHref(absent, '/sales')).toBe('/login?mode=signup&edition=sales')
      expect(resolveSignupHref(absent, '/meeting-notes')).toBe('/login?mode=signup&edition=notes')
      expect(resolveSignupHref(absent, '/company-brain')).toBe('/login?mode=signup&edition=brain')
      expect(resolveSignupHref(absent, '/sales/enterprise')).toBe(
        '/login?mode=signup&edition=sales'
      )
      // And an unmapped path with no provider is still bare.
      expect(resolveSignupHref(absent, '/')).toBe('/login?mode=signup')
      expect(resolveSignupHref(absent, '/pricing')).toBe('/login?mode=signup')
      expect(resolveSignupHref(absent, null)).toBe('/login?mode=signup')
    }
  })

  it('composes with editionForVariant to give each A/B bucket its href', () => {
    // End-to-end on the homepage: flag value in, signup href out. This is the
    // pairing LandingVariantSwitch performs.
    const hrefForVariant = (variant: unknown) =>
      resolveSignupHref(editionForVariant(variant), '/')

    const SALES = '/login?mode=signup&edition=sales'
    expect(hrefForVariant('note-taker')).toBe('/login?mode=signup&edition=notes')
    expect(hrefForVariant('sales')).toBe(SALES)
    expect(hrefForVariant('company-brain')).toBe('/login?mode=signup&edition=brain')
    expect(hrefForVariant('classic')).toBe('/login?mode=signup&edition=full')
    // Unresolved flag (SSR / PostHog blocked) and unknown future keys → the
    // sales fallback's own pitch, because that is what the switch renders.
    expect(hrefForVariant(undefined)).toBe(SALES)
    expect(hrefForVariant(null)).toBe(SALES)
    expect(hrefForVariant('pricing-led')).toBe(SALES)
  })
})

describe('signupHrefForEdition', () => {
  it('appends the edition, or stays bare for no edition', () => {
    expect(signupHrefForEdition('sales')).toBe('/login?mode=signup&edition=sales')
    expect(signupHrefForEdition(null)).toBe('/login?mode=signup')
    expect(signupHrefForEdition(undefined)).toBe('/login?mode=signup')
  })
})
