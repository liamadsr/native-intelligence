import { describe, it, expect } from 'vitest'
import {
  FREE_EMAIL_DOMAINS,
  WORK_EMAIL_REQUIRED_MESSAGE,
  emailDomain,
  isFreeEmailDomain,
  isWorkEmail,
  isWorkEmailRejection,
} from '../work-email'

/**
 * The client half of the work-email signup policy. The server hook
 * (public.hook_require_work_email, migration 241) is the real gate; these
 * tests pin the pre-check the login form runs and the OAuth-callback mapping,
 * so the words a rejected visitor sees are the same on every path.
 */
describe('emailDomain', () => {
  it('returns the lowercased domain', () => {
    expect(emailDomain('Jane@Acme.COM')).toBe('acme.com')
    expect(emailDomain('  jane@acme.com  ')).toBe('acme.com')
  })

  it('returns null for unusable input', () => {
    expect(emailDomain('')).toBeNull()
    expect(emailDomain(null)).toBeNull()
    expect(emailDomain(undefined)).toBeNull()
    expect(emailDomain('jane')).toBeNull()
    expect(emailDomain('@acme.com')).toBeNull()
    expect(emailDomain('jane@')).toBeNull()
    expect(emailDomain('jane@localhost')).toBeNull()
  })

  it('uses the last @ so quoted local parts do not confuse it', () => {
    expect(emailDomain('"a@b"@acme.com')).toBe('acme.com')
  })
})

describe('isWorkEmail / isFreeEmailDomain', () => {
  it('accepts company domains', () => {
    for (const email of ['liam@dial8.ai', 'jane@acme.com', 'x@sub.corp.co.uk']) {
      expect(isWorkEmail(email)).toBe(true)
      expect(isFreeEmailDomain(email)).toBe(false)
    }
  })

  it('rejects the obvious free-mail providers regardless of case', () => {
    for (const email of [
      'someone@gmail.com',
      'Someone@GMAIL.com',
      'a@googlemail.com',
      'a@yahoo.com',
      'a@yahoo.co.uk',
      'a@hotmail.com',
      'a@outlook.com',
      'a@icloud.com',
      'a@proton.me',
      'a@protonmail.com',
      'a@aol.com',
      'a@mailinator.com',
    ]) {
      expect(isWorkEmail(email)).toBe(false)
      expect(isFreeEmailDomain(email)).toBe(true)
    }
  })

  it('does not treat a company subdomain that merely contains a free-mail name as free', () => {
    // Exact-domain match only: the server list behaves the same way.
    expect(isWorkEmail('a@gmail.corp.example')).toBe(true)
    expect(isWorkEmail('a@notgmail.com')).toBe(true)
  })

  it('treats malformed input as neither work nor free', () => {
    expect(isWorkEmail('nope')).toBe(false)
    expect(isFreeEmailDomain('nope')).toBe(false)
  })

  it('keeps every listed domain lowercase and dot-qualified', () => {
    for (const domain of FREE_EMAIL_DOMAINS) {
      expect(domain).toBe(domain.toLowerCase())
      expect(domain).toContain('.')
      expect(domain.trim()).toBe(domain)
    }
  })
})

describe('isWorkEmailRejection', () => {
  it('recognises the hook message, verbatim or wrapped', () => {
    expect(isWorkEmailRejection(WORK_EMAIL_REQUIRED_MESSAGE)).toBe(true)
    expect(isWorkEmailRejection(`Error: ${WORK_EMAIL_REQUIRED_MESSAGE}`)).toBe(true)
    expect(isWorkEmailRejection('dial8 requires a BUSINESS EMAIL to sign up.')).toBe(true)
  })

  it('ignores unrelated auth errors and empty input', () => {
    expect(isWorkEmailRejection('Invalid login credentials')).toBe(false)
    expect(isWorkEmailRejection('User already registered')).toBe(false)
    expect(isWorkEmailRejection('')).toBe(false)
    expect(isWorkEmailRejection(null)).toBe(false)
    expect(isWorkEmailRejection(undefined)).toBe(false)
  })
})
