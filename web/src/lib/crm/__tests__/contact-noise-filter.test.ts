/**
 * Tests for the CRM noise filter (GEN-139).
 *
 * Pure predicates → exhaustive cases. Invariants:
 *   - manual / member sources ALWAYS create (never filtered)
 *   - every auto source requires a non-role address
 *   - email_sync ALSO requires a human-name signal (the newsletter filter)
 *   - calendar_sync / capture_participant do NOT: being invited to a real
 *     meeting is itself the human signal, and providers routinely omit the
 *     display name for external attendees
 *   - the filter only ever refuses to CREATE; it never mutates existing data
 */
import { describe, it, expect } from 'vitest'
import {
  isRoleOrBotAddress,
  hasHumanNameSignal,
  shouldAutoCreateContact,
  placeholderNameFromEmail,
} from '../contact-noise-filter'

describe('isRoleOrBotAddress', () => {
  it('flags classic no-reply / transactional local-parts', () => {
    for (const e of [
      'noreply@acme.com', 'no-reply@acme.com', 'donotreply@acme.com',
      'notifications@acme.com', 'support@acme.com', 'billing@acme.com',
      'info@acme.com', 'hello@acme.com', 'team@acme.com', 'admin@acme.com',
      'mailer-daemon@acme.com', 'postmaster@acme.com', 'sales@acme.com',
    ]) {
      expect(isRoleOrBotAddress(e), e).toBe(true)
    }
  })

  it('flags role words appearing as a segment of the local-part', () => {
    for (const e of ['github-notifications@acme.com', 'noreply-123@acme.com', 'acme.billing@acme.com']) {
      expect(isRoleOrBotAddress(e), e).toBe(true)
    }
  })

  it('flags known automated / bot domains', () => {
    for (const e of [
      'someone@users.noreply.github.com',
      'notifications@github.com',
      'bounce@sendgrid.net',
      'x@mailchimp.com',
      'receipts@e.stripe.com',
    ]) {
      expect(isRoleOrBotAddress(e), e).toBe(true)
    }
  })

  it('flags long opaque hex local-parts (per-message reply addresses)', () => {
    expect(isRoleOrBotAddress('a1b2c3d4e5f60718@reply.example.com')).toBe(true)
  })

  it('flags brand marketing subdomains even with a human-looking local-part', () => {
    // Real prod junk: brand mail streams with person-shaped local-parts.
    for (const e of [
      'americanexpress@welcome.americanexpress.com',
      'disneyplus@trx.mail2.disneyplus.com',
      'concierge@equinox.com',
      'someone@e.marriott.com',
      'x@mailer.brand.com',
    ]) {
      expect(isRoleOrBotAddress(e), e).toBe(true)
    }
  })

  it('does NOT flag a normal personal address', () => {
    for (const e of [
      'sarah.hale@acme.com', 'liam@gmail.com', 'k.pae@company.io',
      'jsmith@university.edu', 'toby@dial8.ai',
      // Colleague-shaped addresses — first.last @ a company root (2-label) domain.
      'priya.nair@ledgerline.com', 'alex.toma@kestrelpoint.com', 'maya.osei@corvanne.com',
      'kai@framewright.io', 'eric.holm@vantlane.com',
    ]) {
      expect(isRoleOrBotAddress(e), e).toBe(false)
    }
  })

  it('treats a non-address as non-human', () => {
    expect(isRoleOrBotAddress('Sarah Hale (ext)')).toBe(true)
    expect(isRoleOrBotAddress('')).toBe(true)
  })
})

describe('hasHumanNameSignal', () => {
  it('accepts a first + last name', () => {
    expect(hasHumanNameSignal('Sarah Hale', 'sarah@acme.com')).toBe(true)
    expect(hasHumanNameSignal('Liam Alizadeh', 'liam@gmail.com')).toBe(true)
  })

  it('accepts a plausible single given name distinct from the local-part', () => {
    expect(hasHumanNameSignal('Sarah', 'sb1994@acme.com')).toBe(true)
  })

  it('rejects an empty / missing name', () => {
    expect(hasHumanNameSignal('', 'sarah@acme.com')).toBe(false)
    expect(hasHumanNameSignal(null, 'sarah@acme.com')).toBe(false)
    expect(hasHumanNameSignal(undefined, 'sarah@acme.com')).toBe(false)
    expect(hasHumanNameSignal('   ', 'sarah@acme.com')).toBe(false)
  })

  it('rejects name == email (the 110/167 pollution pattern)', () => {
    expect(hasHumanNameSignal('sarah@acme.com', 'sarah@acme.com')).toBe(false)
    expect(hasHumanNameSignal('SARAH@ACME.COM', 'sarah@acme.com')).toBe(false)
  })

  it('rejects a name that is itself an email address', () => {
    expect(hasHumanNameSignal('other@acme.com', 'sarah@acme.com')).toBe(false)
  })

  it('ACCEPTS a single given name that equals the local-part (Toby <toby@…> is real)', () => {
    // The pollution is name == email ADDRESS, not name == local-part. A person
    // whose email is seeded from their given name must not be filtered.
    expect(hasHumanNameSignal('Toby', 'toby@dial8.ai')).toBe(true)
    expect(hasHumanNameSignal('sarah.hale', 'sarah.hale@acme.com')).toBe(true)
  })

  it('rejects a single role word as a name', () => {
    expect(hasHumanNameSignal('billing', 'x@acme.com')).toBe(false)
    expect(hasHumanNameSignal('Support', 'x@acme.com')).toBe(false)
  })

  it('rejects a name with no letters (id/phone landed in the name field)', () => {
    expect(hasHumanNameSignal('12345', 'x@acme.com')).toBe(false)
    expect(hasHumanNameSignal('+1 (555) 010-2020', 'x@acme.com')).toBe(false)
  })
})

describe('shouldAutoCreateContact', () => {
  it('ALWAYS creates for manual / member / unknown sources (unfiltered)', () => {
    // Even a role address the user manually added is their choice.
    expect(shouldAutoCreateContact({ email: 'billing@vendor.com', fullName: 'billing@vendor.com', source: 'manual' }).create).toBe(true)
    expect(shouldAutoCreateContact({ email: 'noreply@x.com', fullName: null, source: 'member' }).create).toBe(true)
    expect(shouldAutoCreateContact({ email: 'noreply@x.com', fullName: null }).create).toBe(true) // default manual
  })

  it('refuses a role/bot address from an auto source', () => {
    const v = shouldAutoCreateContact({ email: 'notifications@github.com', fullName: 'GitHub', source: 'email_sync' })
    expect(v.create).toBe(false)
    expect(v.reason).toMatch(/role|bot|transactional/)
  })

  it('refuses an EMAIL_SYNC contact whose name == email (no human signal)', () => {
    const v = shouldAutoCreateContact({ email: 'chase@chase.com', fullName: 'chase@chase.com', source: 'email_sync' })
    expect(v.create).toBe(false)
    expect(v.reason).toMatch(/human-name/)
  })

  it('refuses an EMAIL_SYNC contact with no name at all', () => {
    expect(shouldAutoCreateContact({ email: 'unknown@acme.com', fullName: null, source: 'email_sync' }).create).toBe(false)
  })

  it('CREATES a meeting-derived contact with no name — the invite is the signal', () => {
    // The Nikhil case: Google sent no displayName for the external attendee, so
    // the name arrived as the address (or missing). He is still a real person.
    for (const source of ['calendar_sync', 'capture_participant']) {
      expect(
        shouldAutoCreateContact({ email: 'nikhil.rao@pagetrail.ai', fullName: null, source }).create,
        `${source} / null name`,
      ).toBe(true)
      expect(
        shouldAutoCreateContact({
          email: 'nikhil.rao@pagetrail.ai',
          fullName: 'nikhil.rao@pagetrail.ai',
          source,
        }).create,
        `${source} / name == email`,
      ).toBe(true)
    }
  })

  it('still refuses a role/bot address from a meeting source', () => {
    // Relaxing the NAME bar must not relax the ADDRESS bar — conference rooms
    // and no-reply invites are exactly what would flood the CRM otherwise.
    for (const source of ['calendar_sync', 'capture_participant']) {
      expect(
        shouldAutoCreateContact({ email: 'noreply@acme.com', fullName: null, source }).create,
        source,
      ).toBe(false)
    }
  })

  it('creates a real human from an auto source', () => {
    expect(shouldAutoCreateContact({ email: 'sarah.hale@acme.com', fullName: 'Sarah Hale', source: 'email_sync' }).create).toBe(true)
    expect(shouldAutoCreateContact({ email: 'toby@dial8.ai', fullName: 'Toby', source: 'capture_participant' }).create).toBe(true)
  })

  it('filters the exact junk from the card (GitHub bots, Chase, Equinox, Nelnet)', () => {
    const junk = [
      { email: 'notifications@github.com', fullName: 'GitHub' },
      { email: 'no-reply@chase.com', fullName: 'Chase' },
      { email: 'noreply@equinox.com', fullName: 'noreply@equinox.com' },
      { email: 'billing@nelnet.net', fullName: 'Nelnet' },
    ]
    for (const c of junk) {
      expect(shouldAutoCreateContact({ ...c, source: 'email_sync' }).create, c.email).toBe(false)
    }
  })
})

describe('placeholderNameFromEmail', () => {
  it('humanizes a clearly person-shaped local-part', () => {
    expect(placeholderNameFromEmail('nikhil.rao@pagetrail.ai')).toBe('Nikhil Rao')
    expect(placeholderNameFromEmail('sarah_hale@acme.com')).toBe('Sarah Hale')
    expect(placeholderNameFromEmail('jean-luc.picard@acme.com')).toBe('Jean Luc Picard')
    expect(placeholderNameFromEmail('ADA.LOVELACE@acme.com')).toBe('Ada Lovelace')
  })

  it('returns the raw local-part when it is not name-shaped', () => {
    // These stay EXACTLY as the local part so enrichment's isPlaceholderName
    // still recognizes them and fills in the real name later.
    expect(placeholderNameFromEmail('jsmith42@acme.com')).toBe('jsmith42')
    expect(placeholderNameFromEmail('nikhil@acme.com')).toBe('nikhil')
    expect(placeholderNameFromEmail('j.k@acme.com')).toBe('j.k') // segments too short
    expect(placeholderNameFromEmail('nikhil.k2@acme.com')).toBe('nikhil.k2') // digit in a segment
  })

  it('never returns the full address, and never empties a real address', () => {
    for (const email of ['nikhil.rao@pagetrail.ai', 'jsmith42@acme.com', 'x@acme.com']) {
      const name = placeholderNameFromEmail(email)
      expect(name).not.toBe(email)
      expect(name).not.toContain('@')
      expect(name.length).toBeGreaterThan(0)
    }
  })
})
