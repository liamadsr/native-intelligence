import { describe, it, expect } from 'vitest'
import {
  classifyEmailDomain,
  emailDomain,
  isBusinessEmail,
  PERSONAL_EMAIL_DOMAINS,
} from '../email-domain'

describe('emailDomain', () => {
  it('extracts and lowercases the domain', () => {
    expect(emailDomain('Jane@Example.COM')).toBe('example.com')
  })
  it('takes the last @ segment', () => {
    expect(emailDomain('weird@name@vercel.com')).toBe('vercel.com')
  })
  it('returns null for malformed / missing emails', () => {
    expect(emailDomain('not-an-email')).toBeNull()
    expect(emailDomain('no-tld@localhost')).toBeNull()
    expect(emailDomain('')).toBeNull()
    expect(emailDomain(null)).toBeNull()
    expect(emailDomain(undefined)).toBeNull()
  })
})

describe('classifyEmailDomain — personal branch', () => {
  const personal = [
    'a@gmail.com',
    'a@googlemail.com',
    'a@outlook.com',
    'a@hotmail.com',
    'a@live.com',
    'a@yahoo.com',
    'a@icloud.com',
    'a@me.com',
    'a@aol.com',
    'a@proton.me',
    'a@protonmail.com',
    'a@pm.me',
    'a@gmx.com',
    'a@mail.com',
    'a@fastmail.com',
    'a@hey.com',
  ]
  it.each(personal)('%s → personal (light mode, no company research)', (email) => {
    const c = classifyEmailDomain(email)
    expect(c.isPersonal).toBe(true)
    expect(c.isBusiness).toBe(false)
    expect(isBusinessEmail(email)).toBe(false)
  })
})

describe('classifyEmailDomain — business branch', () => {
  const business = [
    'liam@vercel.com',
    'a@acme.io',
    'a@somestartup.ai',
    'a@bigco.co.uk',
    'a@university.edu',
  ]
  it.each(business)('%s → business (company research)', (email) => {
    const c = classifyEmailDomain(email)
    expect(c.isBusiness).toBe(true)
    expect(c.isPersonal).toBe(false)
    expect(isBusinessEmail(email)).toBe(true)
  })
})

describe('classifyEmailDomain — malformed', () => {
  it('treats a malformed / absent email as personal (nothing to research)', () => {
    for (const bad of ['garbage', '', null, undefined]) {
      const c = classifyEmailDomain(bad)
      expect(c.isBusiness).toBe(false)
      expect(c.isPersonal).toBe(true)
      expect(c.domain).toBeNull()
    }
  })
})

describe('PERSONAL_EMAIL_DOMAINS', () => {
  it('is a superset of the core consumer domains and all lowercase', () => {
    for (const d of PERSONAL_EMAIL_DOMAINS) {
      expect(d).toBe(d.toLowerCase())
    }
    expect(PERSONAL_EMAIL_DOMAINS.has('gmail.com')).toBe(true)
    expect(PERSONAL_EMAIL_DOMAINS.has('vercel.com')).toBe(false)
  })
})
