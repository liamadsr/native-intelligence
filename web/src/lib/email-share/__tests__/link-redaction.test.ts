/**
 * An email share link's token (/mail/s/<token>, migration 646) never reaches
 * PostHog or Sentry, as a join link's doesn't: blanked in page URLs, encoded
 * redirects, autocapture hrefs, fetch breadcrumbs of its API, and Sentry's
 * request; its page sends no pageview. Made-up hosts.
 */
import { describe, expect, it } from 'vitest'
import {
  isEmailShareLinkPage,
  redactJoinTokens,
  scrubPostHogEvent,
  scrubSentryEvent,
} from '@/lib/privacy/join-token-redaction'

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
