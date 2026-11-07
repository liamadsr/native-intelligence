/**
 * Layer 1 of the dedup story: every candidate reduces to one stable
 * `candidate_key` before anything is compared. These are the tests that keep
 * `UNIQUE (list_id, candidate_key)` meaningful — a key that normalizes
 * inconsistently makes the database's guarantee vacuous.
 */
import { describe, it, expect } from 'vitest'
import { companyCandidateKey, personCandidateKey } from '../keys'
import { isPersonalDomain } from '@/lib/crm/enrichment'

describe('companyCandidateKey', () => {
  it('normalizes scheme, www, path, query, case and trailing dots to one key', () => {
    const expected = 'acme.com'
    for (const raw of [
      'acme.com',
      'ACME.com',
      '  Acme.Com  ',
      'www.acme.com',
      'https://acme.com',
      'https://www.acme.com',
      'http://www.ACME.com/pricing?utm_source=x#top',
      'acme.com.',
    ]) {
      expect(companyCandidateKey(raw), raw).toBe(expected)
    }
  })

  it('keeps subdomains distinct — they are different sites, not the same company', () => {
    expect(companyCandidateKey('eu.acme.com')).toBe('eu.acme.com')
    expect(companyCandidateKey('acme.co.uk')).toBe('acme.co.uk')
  })

  it('rejects anything that is not a domain', () => {
    for (const raw of [null, undefined, '', '   ', 'acme', 'not a domain', 'https://']) {
      expect(companyCandidateKey(raw), String(raw)).toBeNull()
    }
  })

  it('rejects personal / webmail domains — a mail provider is never a prospect', () => {
    // Result hosts genuinely include these; they must never become an entry.
    for (const raw of ['gmail.com', 'https://www.Gmail.com/', 'outlook.com', 'proton.me']) {
      expect(companyCandidateKey(raw), raw).toBeNull()
    }
    // The rejection rides the ONE exported list, not a local copy.
    expect(isPersonalDomain('gmail.com')).toBe(true)
    expect(isPersonalDomain('acme.com')).toBe(false)
  })
})

describe('personCandidateKey', () => {
  it('prefers the LinkedIn slug over every other signal', () => {
    const key = personCandidateKey({
      linkedinUrl: 'https://www.linkedin.com/in/Jane-Doe/?trk=x',
      email: 'jane@acme.com',
      name: 'Jane Doe',
      domain: 'acme.com',
    })
    expect(key).toBe('linkedin.com/in/jane-doe')
  })

  it('produces the same LinkedIn key from every URL spelling', () => {
    const expected = 'linkedin.com/in/jane-doe'
    for (const url of [
      'https://www.linkedin.com/in/jane-doe',
      'http://linkedin.com/in/Jane-Doe',
      'linkedin.com/in/jane-doe/',
      'https://uk.linkedin.com/in/jane-doe?utm=1',
    ]) {
      expect(personCandidateKey({ linkedinUrl: url }), url).toBe(expected)
    }
  })

  it('falls back to the lowercased email when there is no LinkedIn URL', () => {
    expect(personCandidateKey({ email: '  Jane@Acme.COM ', name: 'Jane Doe', domain: 'acme.com' }))
      .toBe('jane@acme.com')
  })

  it('never accepts a display label standing in for an email', () => {
    // The exact class of value the calendar sync writes, and the reason
    // findOrCreateContact hard-refuses it. It must not become an identity here
    // either — it falls through to the name@domain tier instead.
    expect(personCandidateKey({ email: 'Sarah Hale (ext)', name: 'Sarah Hale', domain: 'acme.com' }))
      .toBe('sarah hale@acme.com')
    expect(personCandidateKey({ email: 'Sarah Hale (ext)' })).toBeNull()
  })

  it('uses name@domain only as a last resort, and scopes it to the account', () => {
    // Two people with the same name at two companies are TWO people.
    const atAcme = personCandidateKey({ name: 'Jane Doe', domain: 'acme.com' })
    const atBeta = personCandidateKey({ name: 'Jane Doe', domain: 'beta.io' })
    expect(atAcme).toBe('jane doe@acme.com')
    expect(atBeta).toBe('jane doe@beta.io')
    expect(atAcme).not.toBe(atBeta)
  })

  it('normalizes the weak key so one person written two ways collides', () => {
    const a = personCandidateKey({ name: "Dr. Sarah  O'Brien ", domain: 'https://www.acme.com/team' })
    const b = personCandidateKey({ name: 'dr sarah obrien', domain: 'ACME.com' })
    expect(a).toBe('dr sarah obrien@acme.com')
    expect(b).toBe(a)
  })

  it('returns null when no tier can produce a key', () => {
    expect(personCandidateKey({})).toBeNull()
    // A bare name is not an identity.
    expect(personCandidateKey({ name: 'Jane Doe' })).toBeNull()
    // Neither is a name at an unusable or personal-domain "account".
    expect(personCandidateKey({ name: 'Jane Doe', domain: 'not a domain' })).toBeNull()
    expect(personCandidateKey({ name: 'Jane Doe', domain: 'gmail.com' })).toBeNull()
    // A LinkedIn URL that is not a /in/ profile yields nothing on tier 1 and
    // has nothing to fall back to.
    expect(personCandidateKey({ linkedinUrl: 'https://linkedin.com/company/acme' })).toBeNull()
  })
})
