/**
 * The public sky shows on every page outside the signed-in app (so a new
 * public page gets it with no change), and on none of the app shells,
 * callbacks, popups, overlays or the share and handoff pages.
 */
import { describe, expect, it } from 'vitest'
import { publicSkyShowsOn } from '../public-sky-routes'

describe('publicSkyShowsOn', () => {
  it('shows on the public pages, including ones nobody listed', () => {
    for (const path of [
      '/',
      '/blog',
      '/blog/hello-world',
      '/docs',
      '/docs/getting-started/quick-start',
      '/pricing',
      '/about',
      '/privacy',
      '/terms',
      '/release-notes',
      '/meeting-notes',
      '/company-brain',
      '/vs/granola',
      '/scribe',
      '/login',
      '/forgot-password',
      '/invite/abc',
      '/some-page-added-next-year',
      '/accounting', // a prefix of an excluded name is not that name
      '/sales',
    ]) {
      expect(publicSkyShowsOn(path), path).toBe(true)
    }
  })

  it('stays out of the app shells, callbacks, popups, overlays, share and handoff pages', () => {
    for (const path of [
      '/account',
      '/account/settings/profile',
      '/admin',
      '/admin/users',
      '/hud/agent',
      '/auth/callback',
      '/auth/desktop-callback',
      '/oauth-popup-callback',
      '/mcp-oauth-popup-callback',
      '/mcp/authorize',
      '/sign-out',
      '/welcome',
      '/s/token123',
      '/dev/knowledge-map',
      '/api/sky',
    ]) {
      expect(publicSkyShowsOn(path), path).toBe(false)
    }
    expect(publicSkyShowsOn(null)).toBe(false)
    expect(publicSkyShowsOn('')).toBe(false)
  })
})
