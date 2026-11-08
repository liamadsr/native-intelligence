/**
 * ADMIN_EMAILS (lib/admin-emails.ts): the deployment's admins, one by
 * address. Spaces and case don't matter, blanks and anything that isn't a
 * whole address are dropped, and unset means nobody.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adminEmailDomain, adminEmails, isAdminEmail, parseAdminEmails } from '../admin-emails'

afterEach(() => vi.unstubAllEnvs())

describe('parseAdminEmails', () => {
  it('splits on commas, trims and lower-cases', () => {
    expect([...parseAdminEmails(' Ops@Example.com ,owner@example.org,  ')]).toEqual([
      'ops@example.com',
      'owner@example.org',
    ])
  })

  it('is empty for unset, empty or blank values', () => {
    expect(parseAdminEmails(undefined).size).toBe(0)
    expect(parseAdminEmails(null).size).toBe(0)
    expect(parseAdminEmails('').size).toBe(0)
    expect(parseAdminEmails(' , ,').size).toBe(0)
  })

  it('drops anything that is not a whole address: never a domain', () => {
    expect([...parseAdminEmails('@example.com, example.com, *@example.com, a b@example.com, ops@example.com')]).toEqual([
      'ops@example.com',
    ])
    vi.stubEnv('ADMIN_EMAILS', '*@example.com, @example.com')
    expect(isAdminEmail('anyone@example.com')).toBe(false)
    expect(adminEmailDomain()).toBeNull()
  })

  it('folds duplicates', () => {
    expect([...parseAdminEmails('ops@example.com, OPS@example.com')]).toEqual(['ops@example.com'])
  })
})

describe('isAdminEmail', () => {
  it('reads ADMIN_EMAILS on each call', () => {
    vi.stubEnv('ADMIN_EMAILS', 'ops@example.com')
    expect(isAdminEmail(' OPS@example.com ')).toBe(true)
    expect(isAdminEmail('other@example.com')).toBe(false)
    vi.stubEnv('ADMIN_EMAILS', 'other@example.com')
    expect(isAdminEmail('ops@example.com')).toBe(false)
    expect(isAdminEmail('other@example.com')).toBe(true)
  })

  it('refuses a lookalike address that lower-cases onto an admin (Kelvin sign)', () => {
    vi.stubEnv('ADMIN_EMAILS', 'kim@example.com')
    expect('\u212Aim@example.com'.toLowerCase()).toBe('kim@example.com')
    expect(isAdminEmail('\u212Aim@example.com')).toBe(false)
    expect(isAdminEmail('Kim@Example.com')).toBe(true)
  })

  it('has no admins when ADMIN_EMAILS is unset', () => {
    delete process.env.ADMIN_EMAILS
    expect(adminEmails().size).toBe(0)
    expect(isAdminEmail('ops@example.com')).toBe(false)
    expect(isAdminEmail('')).toBe(false)
    expect(isAdminEmail(null)).toBe(false)
  })
})

describe('adminEmailDomain', () => {
  it("is the admins' shared domain", () => {
    vi.stubEnv('ADMIN_EMAILS', 'ops@example.com, Owner@Example.com')
    expect(adminEmailDomain()).toBe('example.com')
  })

  it('is null with no admins, or admins on more than one domain', () => {
    vi.stubEnv('ADMIN_EMAILS', '')
    expect(adminEmailDomain()).toBeNull()
    vi.stubEnv('ADMIN_EMAILS', 'ops@example.com, owner@example.org')
    expect(adminEmailDomain()).toBeNull()
  })
})
