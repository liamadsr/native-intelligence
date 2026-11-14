import { describe, it, expect } from 'vitest'
import { signupHrefForEdition, signupHrefForPath } from '../signup-href'
import { EDITION_IDS } from '@/lib/editions'

/**
 * Funnel wiring — the edition attribution shared by the navbar and every
 * landing-page CTA. Attribution is by pathname: each persona pitch has its own
 * route, and the homepage ('/', the whole workspace) sends the bare href, so a
 * homepage signup gets the default edition (`full`, the whole app).
 *
 * The assertions that carry weight:
 *
 *   1. Each persona route attributes its own edition, sub-paths included.
 *   2. Unmapped paths — '/' above all — stay BARE.
 *   3. Every edition id emitted is a real EditionId.
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
    // '/' is the whole workspace's pitch: its signups get the default edition.
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

describe('signupHrefForEdition', () => {
  it('appends the edition, or leaves the href bare without one', () => {
    expect(signupHrefForEdition('notes')).toBe('/login?mode=signup&edition=notes')
    expect(signupHrefForEdition(null)).toBe('/login?mode=signup')
    expect(signupHrefForEdition(undefined)).toBe('/login?mode=signup')
  })
})
