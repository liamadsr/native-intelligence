/**
 * Which domain a workspace may list for join-by-domain: the blocked-domain
 * list (public, relay/alias, ISP) and its SQL twin, ASCII normalising, and
 * the rule that the domain is always the switching admin's own verified one.
 */
import { describe, expect, it } from 'vitest'
import { FREE_EMAIL_DOMAINS } from '@/lib/auth/work-email'
import { latestDefinition } from '@/test/migration-sql'
import { addressDomain, claimRefusalText, claimableDomain, isPublicEmailDomain, normalizeDomain } from '../domains'

const verified = (email: string, provider = 'email') => ({
  email,
  email_confirmed_at: '2026-11-01T00:00:00.000Z',
  identities: [{ provider, identity_data: { email, email_verified: true } }],
})

describe('blocked domains', () => {
  const PUBLIC = [
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
    'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de',
    'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'fastmail.com', 'hey.com', 'tutanota.com', 'duck.com',
  ]
  const RELAY = [
    'privaterelay.appleid.com', 'mozmail.com', 'relay.firefox.com', 'simplelogin.com', 'simplelogin.co', 'slmail.me',
    'aleeas.com', 'anonaddy.com', 'anonaddy.me', 'addy.io', 'passmail.net', 'passinbox.com', 'duck.com',
  ]
  const ISP = [
    'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net', 'charter.net', 'spectrum.net', 'earthlink.net',
    'btinternet.com', 'sky.com', 'virginmedia.com', 'orange.fr', 'free.fr', 'wanadoo.fr', 't-online.de', 'web.de',
    'libero.it', 'shaw.ca', 'rogers.com', 'bell.net', 'telus.net', 'optusnet.com.au', 'bigpond.com',
  ]

  it.each([
    ['public providers', PUBLIC],
    ['relay and alias services', RELAY],
    ['consumer ISPs', ISP],
  ])('refuses %s', (_label, list) => {
    for (const d of list) {
      expect(FREE_EMAIL_DOMAINS.has(d), d).toBe(true)
      expect(isPublicEmailDomain(d), d).toBe(true)
      expect(claimableDomain(verified(`someone@${d}`)), d).toMatchObject({ ok: false, reason: 'public_provider' })
    }
  })

  it('holds the same list as public.is_free_email_domain, its newest definition', () => {
    const { file, blocks } = latestDefinition('is_free_email_domain')
    expect(file).toBe('644_workspace_join.sql')
    const sql = blocks.join('\n').replace(/--[^\n]*/g, '')
    const inSql = new Set([...sql.matchAll(/'([a-z0-9.-]+\.[a-z]+)'/g)].map((m) => m[1]))
    expect([...inSql].sort()).toEqual([...FREE_EMAIL_DOMAINS].sort())
  })

  it('reads case and spaces loosely, and leaves company domains alone', () => {
    expect(isPublicEmailDomain(' GMAIL.com ')).toBe(true)
    for (const d of ['acme.example', 'northwind.example', 'mail.acme.example', 'gmail.com.acme.example']) {
      expect(isPublicEmailDomain(d), d).toBe(false)
    }
    expect(isPublicEmailDomain(null)).toBe(false)
  })
})

describe('normalizeDomain', () => {
  it('lowercases, trims and drops a trailing dot', () => {
    expect(normalizeDomain(' ACME.Example. ')).toBe('acme.example')
  })

  it('turns an internationalised domain into its ASCII (punycode) form', () => {
    expect(normalizeDomain('bücher.example')).toBe('xn--bcher-kva.example')
    expect(addressDomain('jo@Bücher.example')).toBe('xn--bcher-kva.example')
  })

  it('refuses what is not a host name', () => {
    for (const bad of ['', 'localhost', 'acme..example', '-acme.example', 'acme example', 'a_b.example', '💥', null]) {
      expect(normalizeDomain(bad), String(bad)).toBeNull()
    }
  })
})

describe('claimableDomain: always the admin’s own verified domain', () => {
  it('derives the domain from the address', () => {
    expect(claimableDomain(verified('Avery.Reyes@ACME.example'))).toEqual({ ok: true, domain: 'acme.example' })
    expect(claimableDomain(verified('jo@bücher.example'))).toEqual({ ok: true, domain: 'xn--bcher-kva.example' })
  })

  it('refuses a public provider, and says why', () => {
    const result = claimableDomain(verified('avery@gmail.com'))
    expect(result).toEqual({ ok: false, domain: 'gmail.com', reason: 'public_provider' })
    expect(claimRefusalText(result)).toMatch(/@gmail\.com is a public or shared email provider/)
  })

  it('refuses a domain that cannot be a host name, with a reason, not an error', () => {
    const result = claimableDomain(verified('avery@acme_corp.example'))
    expect(result).toMatchObject({ ok: false, reason: 'unsupported_domain' })
    expect(claimRefusalText(result)).toMatch(/can’t be used/)
  })

  it('refuses an address that is not verified', () => {
    expect(claimableDomain({ ...verified('avery@acme.example'), email_confirmed_at: null })).toEqual({
      ok: false, domain: 'acme.example', reason: 'unverified',
    })
    const identityUnverified = {
      ...verified('avery@acme.example'),
      identities: [{ provider: 'email', identity_data: { email: 'avery@acme.example', email_verified: false } }],
    }
    expect(claimableDomain(identityUnverified).ok).toBe(false)
  })

  it('refuses an account without an address; there is no way to name another domain', () => {
    expect(claimableDomain({ email: null })).toEqual({ ok: false, domain: null, reason: 'no_email' })
    expect(claimableDomain.length).toBe(1)
  })
})
