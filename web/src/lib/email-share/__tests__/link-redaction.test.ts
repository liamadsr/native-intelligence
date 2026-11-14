/**
 * An email share link's token (/mail/s/<token>, migration 646) never reaches
 * PostHog or Sentry, as a join link's doesn't: blanked in page URLs, encoded
 * redirects, autocapture hrefs, fetch breadcrumbs of its API, and Sentry's
 * request; its page sends no pageview. Made-up hosts.
 */
import { describe, expect, it } from 'vitest'
import { redactJoinTokens, scrubPostHogEvent, scrubSentryEvent } from '@/lib/privacy/join-token-redaction'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isEmailShareLinkPage } from '../links'
import { resolvePostAuthRedirect } from '@/lib/auth/login-redirect'

const T = 'TokenOne_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('email share link tokens', () => {
  it('are blanked wherever a URL carries them', () => {
    expect(redactJoinTokens(`https://app.northwind.example/mail/s/${T}`)).toBe('https://app.northwind.example/mail/s/redacted')
    expect(redactJoinTokens(`/mail/s/${T}`)).toBe('/mail/s/redacted')
    expect(redactJoinTokens(`/login?redirect=%2Fmail%2Fs%2F${T}`)).toBe('/login?redirect=%2Fmail%2Fs%2Fredacted')
    expect(redactJoinTokens(`/login?next=%252Fmail%252Fs%252F${T}`)).toBe('/login?next=%252Fmail%252Fs%252Fredacted')
    expect(redactJoinTokens(`GET /api/account/email/shares/links/${T}?images=1`)).toBe('GET /api/account/email/shares/links/redacted?images=1')
    // Other mail paths are kept.
    expect(redactJoinTokens('/account?page=mail')).toBe('/account?page=mail')
  })

  it('PostHog: every property; Sentry: the request, breadcrumbs and transaction', () => {
    const ph = scrubPostHogEvent({
      event: '$autocapture',
      properties: { $current_url: `https://app.northwind.example/mail/s/${T}`, $elements: [{ attr__href: `https://app.northwind.example/mail/s/${T}` }] },
    })
    expect(JSON.stringify(ph)).not.toContain(T)
    const sentry = scrubSentryEvent({
      request: { url: `https://app.northwind.example/api/account/email/shares/links/${T}`, headers: { referer: `https://app.northwind.example/mail/s/${T}` } },
      transaction: `GET /mail/s/${T}`,
      breadcrumbs: [{ category: 'fetch', data: { url: `/api/account/email/shares/links/${T}` } }],
    })
    expect(JSON.stringify(sentry)).not.toContain(T)
  })

  it('its page sends no pageview', () => {
    expect(isEmailShareLinkPage(`/mail/s/${T}`)).toBe(true)
    expect(isEmailShareLinkPage('/account')).toBe(false)
  })
})

describe('the link page', () => {
  it('is served noindex and no-referrer, never cached (next.config headers)', () => {
    const config = readFileSync(join(process.cwd(), 'next.config.mjs'), 'utf8')
    const rule = config.slice(config.indexOf("source: '/mail/s/:path*'"), config.indexOf("source: '/mail/s/:path*'") + 400)
    expect(rule).toContain("{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }")
    expect(rule).toContain("{ key: 'Referrer-Policy', value: 'no-referrer' }")
    expect(rule).toContain("{ key: 'Cache-Control', value: 'private, no-store' }")
  })

  it('sign-in comes back to it', () => {
    expect(resolvePostAuthRedirect(`/mail/s/${T}`, 'https://app.northwind.example')).toBe(`/mail/s/${T}`)
    expect(resolvePostAuthRedirect('/mail/s//evil.example', 'https://app.northwind.example')).toBe('/account')
  })
})
