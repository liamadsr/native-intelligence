/**
 * A join link's token never reaches PostHog or Sentry: blanked in plain and
 * encoded URLs, in every property an event carries, and /join/team kept.
 */
import { describe, expect, it } from 'vitest'
import { isJoinLinkPage, redactJoinTokens, scrubPostHogEvent, scrubSentryEvent } from '../join-token-redaction'

const TOKEN = 'Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0_-Ab0'

describe('redactJoinTokens', () => {
  it('blanks the token in a path, a full URL, and with a query or hash after it', () => {
    expect(redactJoinTokens(`/join/${TOKEN}`)).toBe('/join/redacted')
    expect(redactJoinTokens(`https://app.example/join/${TOKEN}?x=1#y`)).toBe('https://app.example/join/redacted?x=1#y')
  })

  it('blanks it inside a redirect= value, plain, encoded once or twice, any case', () => {
    expect(redactJoinTokens(`https://app.example/login?redirect=/join/${TOKEN}`)).toBe('https://app.example/login?redirect=/join/redacted')
    expect(redactJoinTokens(`/login?redirect=%2Fjoin%2F${TOKEN}`)).toBe('/login?redirect=%2Fjoin%2Fredacted')
    expect(redactJoinTokens(`/login?redirect=%2fjoin%2f${TOKEN}&mode=signup`)).toBe('/login?redirect=%2fjoin%2fredacted&mode=signup')
    expect(redactJoinTokens(`/x?next=%252Fjoin%252F${TOKEN}`)).toBe('/x?next=%252Fjoin%252Fredacted')
    expect(redactJoinTokens(`/x?u=https%3A%2F%2Fapp.example%2Fjoin%2F${TOKEN}`)).toBe('/x?u=https%3A%2F%2Fapp.example%2Fjoin%2Fredacted')
  })

  it('keeps the join-by-domain page and anything without a link', () => {
    expect(redactJoinTokens('https://app.example/join/team')).toBe('https://app.example/join/team')
    expect(redactJoinTokens('/login?redirect=%2Fjoin%2Fteam')).toBe('/login?redirect=%2Fjoin%2Fteam')
    expect(redactJoinTokens('/account/settings/workspace')).toBe('/account/settings/workspace')
    expect(redactJoinTokens('/joint/abc')).toBe('/joint/abc')
    // The API's own paths are not the link.
    expect(redactJoinTokens('/api/account/workspace/join/accept')).toBe('/api/account/workspace/join/accept')
    expect(redactJoinTokens('https://app.example/api/account/workspace/join/domain')).toBe('https://app.example/api/account/workspace/join/domain')
    // A token that merely starts with "team" is still a token.
    expect(redactJoinTokens('/join/teamAb0_-Ab0_-Ab0_-Ab0_-Ab')).toBe('/join/redacted')
  })

  it('knows a link page from the domain page', () => {
    expect(isJoinLinkPage(`/join/${TOKEN}`)).toBe(true)
    expect(isJoinLinkPage('/join/team')).toBe(false)
    expect(isJoinLinkPage('/account')).toBe(false)
  })
})

describe('scrubPostHogEvent (before_send)', () => {
  it('blanks every URL property, the $initial_* copies, $set_once, pageleave and autocapture hrefs', () => {
    const url = `https://app.example/join/${TOKEN}`
    const event = {
      uuid: 'u1',
      event: '$autocapture',
      timestamp: new Date('2026-11-13T00:00:00Z'),
      properties: {
        $current_url: url,
        $pathname: `/join/${TOKEN}`,
        $referrer: `https://app.example/login?redirect=%2Fjoin%2F${TOKEN}`,
        $prev_pageview_pathname: `/join/${TOKEN}`,
        $elements: [{ tag_name: 'a', attr__href: `/join/${TOKEN}`, $el_text: 'Join' }],
        $elements_chain: `a:attr__href="/join/${TOKEN}"`,
        count: 3,
      },
      $set: { $current_url: url },
      $set_once: { $initial_current_url: url, $initial_pathname: `/join/${TOKEN}`, $initial_referrer: url },
    }
    const out = scrubPostHogEvent(event)!
    expect(JSON.stringify(out)).not.toContain(TOKEN)
    expect(out.properties.$current_url).toBe('https://app.example/join/redacted')
    expect(out.properties.$elements[0].$el_text).toBe('Join')
    expect(out.properties.count).toBe(3)
    expect(out.timestamp).toBeInstanceOf(Date)
  })

  it('passes null through', () => {
    expect(scrubPostHogEvent(null)).toBeNull()
  })
})

describe('scrubSentryEvent (beforeSend, beforeSendTransaction, beforeBreadcrumb)', () => {
  it('blanks the request, headers, breadcrumbs, transaction name and tags', () => {
    const event = {
      transaction: `/join/${TOKEN}`,
      request: {
        url: `https://app.example/join/${TOKEN}`,
        query_string: `redirect=%2Fjoin%2F${TOKEN}`,
        headers: { Referer: `https://app.example/join/${TOKEN}` },
      },
      breadcrumbs: [
        { category: 'navigation', data: { from: '/account', to: `/join/${TOKEN}` } },
        { category: 'fetch', data: { url: '/api/account/workspace/join/accept', method: 'POST' } },
      ],
      tags: { url: `/join/${TOKEN}` },
      contexts: { trace: { op: 'navigation' } },
    }
    const out = scrubSentryEvent(event)
    expect(JSON.stringify(out)).not.toContain(TOKEN)
    expect(out.breadcrumbs[1].data.url).toBe('/api/account/workspace/join/accept')
    expect(scrubSentryEvent({ category: 'navigation', data: { to: `/join/${TOKEN}` } }).data.to).toBe('/join/redacted')
  })
})
