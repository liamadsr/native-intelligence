/**
 * Which domain a workspace may claim: the public-provider list, and the rule
 * that the domain is always the switching admin's own verified one.
 */
import { describe, expect, it } from 'vitest'
import { FREE_EMAIL_DOMAINS } from '@/lib/auth/work-email'
import { claimRefusalText, claimableDomain, domainClashText, isPublicEmailDomain } from '../domains'

const verified = (email: string, provider = 'email') => ({
  email,
  email_confirmed_at: '2026-11-01T00:00:00.000Z',
  identities: [{ provider, identity_data: { email, email_verified: true } }],
})

describe('public email providers', () => {
  const REQUIRED = [
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com', 'ymail.com',
    'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de',
    'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'fastmail.com', 'hey.com', 'tutanota.com', 'duck.com',
  ]

  it('holds every provider the brief names, in the one list the signup gate keeps', () => {
    for (const d of REQUIRED) {
      expect(FREE_EMAIL_DOMAINS.has(d), d).toBe(true)
      expect(isPublicEmailDomain(d), d).toBe(true)
    }
  })

  it('also refuses regional, ISP and throwaway mail', () => {
    for (const d of ['yahoo.co.uk', 'outlook.co.uk', 'comcast.net', 'mailinator.com', 'web.de']) {
      expect(isPublicEmailDomain(d), d).toBe(true)
    }
  })

  it('reads case and spaces loosely, and leaves company domains alone', () => {
    expect(isPublicEmailDomain(' GMAIL.com ')).toBe(true)
    for (const d of ['acme.example', 'northwind.example', 'mail.acme.example', 'gmail.com.acme.example']) {
      expect(isPublicEmailDomain(d), d).toBe(false)
    }
    expect(isPublicEmailDomain(null)).toBe(false)
    expect(isPublicEmailDomain('')).toBe(false)
  })
})

describe('claimableDomain: always the admin’s own verified domain', () => {
  it('derives the domain from the address, lowercased', () => {
    expect(claimableDomain(verified('Avery.Reyes@ACME.example'))).toEqual({ ok: true, domain: 'acme.example' })
  })

  it('refuses a public provider, and says why', () => {
    const result = claimableDomain(verified('avery@gmail.com'))
    expect(result).toEqual({ ok: false, domain: 'gmail.com', reason: 'public_provider' })
    expect(claimRefusalText(result)).toMatch(/@gmail\.com is a public email provider/)
  })

  it('refuses an address that is not verified', () => {
    const unconfirmed = { ...verified('avery@acme.example'), email_confirmed_at: null }
    expect(claimableDomain(unconfirmed)).toEqual({ ok: false, domain: 'acme.example', reason: 'unverified' })
    const identityUnverified = {
      ...verified('avery@acme.example'),
      identities: [{ provider: 'email', identity_data: { email: 'avery@acme.example', email_verified: false } }],
    }
    expect(claimableDomain(identityUnverified).ok).toBe(false)
  })

  it('refuses an account without an address', () => {
    expect(claimableDomain({ email: null })).toEqual({ ok: false, domain: null, reason: 'no_email' })
    expect(claimableDomain(null).ok).toBe(false)
  })

  it('has no way to name another domain: the input is the user, nothing else', () => {
    expect(claimableDomain.length).toBe(1)
  })

  it('words the clash', () => {
    expect(domainClashText('acme.example')).toBe('Another workspace already uses @acme.example')
  })
})
