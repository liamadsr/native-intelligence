import { describe, it, expect } from 'vitest'
import {
  emailLocalPart,
  nameTokens,
  namesCompatible,
  nameSimilarity,
  scoreContactPair,
  choosePrimary,
  type DedupContact,
} from '../contact-dedup'

/**
 * Tests for the deterministic contact-dedup matching engine.
 *
 * The invariant that matters most: a person who joins meetings from two
 * different addresses with the SAME local-part (sarah.fletcher@ledgerline.com vs
 * sarah.fletcher@corvanne.com) is auto-merged, while genuinely different people who
 * merely share a common first name or a role mailbox are NOT.
 */

function contact(partial: Partial<DedupContact>): DedupContact {
  return {
    id: partial.id ?? crypto.randomUUID(),
    full_name: partial.full_name ?? null,
    first_name: partial.first_name ?? null,
    last_name: partial.last_name ?? null,
    email: partial.email ?? null,
    secondary_emails: partial.secondary_emails ?? [],
    phone: partial.phone ?? null,
    company_id: partial.company_id ?? null,
    member_id: partial.member_id ?? null,
    interaction_count: partial.interaction_count ?? 0,
    last_interaction_at: partial.last_interaction_at ?? null,
    created_at: partial.created_at ?? '2026-01-01T00:00:00Z',
  }
}

describe('emailLocalPart', () => {
  it('lowercases, strips +tags and dots', () => {
    expect(emailLocalPart('Sarah.Fletcher+crm@ledgerline.com')).toBe('sarahfletcher')
    expect(emailLocalPart('sarah.fletcher@corvanne.com')).toBe('sarahfletcher')
  })

  it('returns null for malformed addresses', () => {
    expect(emailLocalPart('not-an-email')).toBeNull()
    expect(emailLocalPart('@nolocal.com')).toBeNull()
  })
})

describe('nameTokens', () => {
  it('drops titles and accents', () => {
    expect(nameTokens(contact({ full_name: 'Dr. Sàrah Fletcher' }))).toEqual(['sarah', 'fletcher'])
  })

  it('treats a bare email as no real name', () => {
    expect(nameTokens(contact({ full_name: 'sarah.fletcher@ledgerline.com' }))).toEqual([])
  })

  it('strips parenthetical / bracketed qualifiers added by sync sources', () => {
    expect(nameTokens(contact({ full_name: 'Sarah Hale (us)' }))).toEqual(['sarah', 'hale'])
    expect(nameTokens(contact({ full_name: 'Sarah Hale (ext)' }))).toEqual(['sarah', 'hale'])
    expect(nameTokens(contact({ full_name: 'Sarah Hale [Ledgerline]' }))).toEqual(['sarah', 'hale'])
    expect(nameTokens(contact({ full_name: 'sarah.hale' }))).toEqual(['sarah', 'hale'])
  })

  it('makes qualifier-tagged variants of the same person name-compatible', () => {
    const us = contact({ full_name: 'Sarah Hale (us)' })
    const ext = contact({ full_name: 'Sarah Hale (ext)' })
    expect(namesCompatible(us, ext)).toBe(true)
  })
})

describe('namesCompatible', () => {
  it('matches exact and abbreviated names', () => {
    const a = contact({ full_name: 'Sarah Fletcher' })
    expect(namesCompatible(a, contact({ full_name: 'Fletcher, Sarah' }))).toBe(true)
    expect(namesCompatible(a, contact({ full_name: 'Sarah F' }))).toBe(true)
    expect(namesCompatible(a, contact({ full_name: 'S Fletcher' }))).toBe(true)
  })

  it('rejects different surnames', () => {
    expect(namesCompatible(contact({ full_name: 'Sarah Fletcher' }), contact({ full_name: 'Sarah Barnes' }))).toBe(false)
  })

  it('is lenient when one side has no real name', () => {
    expect(namesCompatible(contact({ full_name: 'Sarah Fletcher' }), contact({ full_name: 'sarah@x.com' }))).toBe(true)
  })
})

describe('scoreContactPair — the Sarah scenario', () => {
  it('auto-merges the same local-part across domains with a compatible name', () => {
    const pwc = contact({ id: 'a', full_name: 'Sarah Fletcher', email: 'sarah.fletcher@ledgerline.com' })
    const corvanne = contact({ id: 'b', full_name: 'Sarah Fletcher', email: 'sarah.fletcher@corvanne.com' })
    const match = scoreContactPair(pwc, corvanne)
    expect(match?.tier).toBe('auto')
    expect(match?.matchType).toBe('auto:local_part')
  })

  it('only suggests (never auto-merges) when one contact only carries the address as a name', () => {
    // A bare-email name carries no independent identity confirmation, so a
    // shared local-part alone must not silently fold two possibly-different
    // people together — it drops to the review queue instead.
    const named = contact({ id: 'a', full_name: 'Sarah Fletcher', email: 'sarah.fletcher@ledgerline.com' })
    const bare = contact({ id: 'b', full_name: 'sarah.fletcher@corvanne.com', email: 'sarah.fletcher@corvanne.com' })
    const match = scoreContactPair(named, bare)
    expect(match?.tier).toBe('suggest')
    expect(match?.matchType).toBe('suggest:local_part')
  })

  it('auto-merges a known alias (address already on the other contact)', () => {
    const a = contact({ id: 'a', full_name: 'Sarah Fletcher', email: 'sarah.fletcher@ledgerline.com', secondary_emails: ['sb@corvanne.com'] })
    const b = contact({ id: 'b', full_name: 'Sarah B', email: 'sb@corvanne.com' })
    const match = scoreContactPair(a, b)
    expect(match?.tier).toBe('auto')
    expect(match?.matchType).toBe('auto:alias')
  })
})

describe('scoreContactPair — guards against false merges', () => {
  it('does NOT auto-merge a shared role mailbox', () => {
    const a = contact({ id: 'a', full_name: 'Sales Team', email: 'sales@ledgerline.com' })
    const b = contact({ id: 'b', full_name: 'Sales Desk', email: 'sales@corvanne.com' })
    expect(scoreContactPair(a, b)).toBeNull()
  })

  it('does NOT auto-merge a shared local-part when either side has no real name', () => {
    // bob.smith@acme.com (named) vs bob.smith@gmail.com (name is just the
    // address → no tokens). Same handle across unrelated domains is not enough
    // to auto-merge without a real name on both sides.
    const named = contact({ id: 'a', full_name: 'Bob Smith', email: 'bob.smith@acme.com' })
    const bare = contact({ id: 'b', full_name: 'bob.smith@gmail.com', email: 'bob.smith@gmail.com' })
    const match = scoreContactPair(named, bare)
    expect(match?.tier).not.toBe('auto')

    // Both sides empty-named (two bare addresses) also must not auto-merge.
    const bareA = contact({ id: 'c', full_name: null, email: 'bob.smith@acme.com' })
    const bareB = contact({ id: 'd', full_name: null, email: 'bob.smith@gmail.com' })
    expect(scoreContactPair(bareA, bareB)?.tier).not.toBe('auto')
  })

  it('still auto-merges when both sides carry a real, compatible name', () => {
    // The fix only downgrades the no-name path — real names on both sides
    // preserve the original auto-merge behavior.
    const a = contact({ id: 'a', full_name: 'Bob Smith', email: 'bob.smith@acme.com' })
    const b = contact({ id: 'b', full_name: 'Bob Smith', email: 'bob.smith@corvanne.com' })
    expect(scoreContactPair(a, b)?.tier).toBe('auto')
  })

  it('does NOT auto-merge same local-part but conflicting surnames', () => {
    // Different people who happen to share a handle: still not auto-merged.
    const a = contact({ id: 'a', full_name: 'Sarah Fletcher', email: 'sfletcher@ledgerline.com' })
    const b = contact({ id: 'b', full_name: 'Steve Fletcher', email: 'sfletcher@corvanne.com' })
    const match = scoreContactPair(a, b)
    // shared handle "sfletcher" but incompatible first names → suggestion at most
    expect(match?.tier).not.toBe('auto')
  })

  it('does NOT auto-merge two distinct internal members', () => {
    const a = contact({ id: 'a', full_name: 'Sarah Fletcher', email: 'sarah.fletcher@corvanne.com', member_id: 'm1' })
    const b = contact({ id: 'b', full_name: 'Sarah Fletcher', email: 'sarah.fletcher@ledgerline.com', member_id: 'm2' })
    const match = scoreContactPair(a, b)
    expect(match?.tier).not.toBe('auto')
  })

  it('only suggests (never auto-merges) two people who merely share a name', () => {
    const a = contact({ id: 'a', full_name: 'John Smith', email: 'john.smith@acme.com' })
    const b = contact({ id: 'b', full_name: 'John Smith', email: 'jsmith2@acme.com' })
    const match = scoreContactPair(a, b)
    expect(match?.tier).toBe('suggest')
  })

  it('returns null for clearly unrelated contacts', () => {
    const a = contact({ id: 'a', full_name: 'Sarah Fletcher', email: 'sarah@ledgerline.com' })
    const b = contact({ id: 'b', full_name: 'Mike Jones', email: 'mike@corvanne.com' })
    expect(scoreContactPair(a, b)).toBeNull()
  })
})

describe('nameSimilarity', () => {
  it('scores identical normalized names as 1', () => {
    expect(nameSimilarity(contact({ full_name: 'Sarah Fletcher' }), contact({ full_name: 'Fletcher, Sarah' }))).toBe(1)
  })

  it('scores unrelated names low', () => {
    expect(nameSimilarity(contact({ full_name: 'Sarah Fletcher' }), contact({ full_name: 'Mike Jones' }))).toBeLessThan(0.3)
  })
})

describe('choosePrimary', () => {
  it('prefers the internal member as the survivor', () => {
    const member = contact({ id: 'a', member_id: 'm1', interaction_count: 1 })
    const ext = contact({ id: 'b', member_id: null, interaction_count: 50 })
    expect(choosePrimary(member, ext).target.id).toBe('a')
  })

  it('prefers the richer history when neither is a member', () => {
    const busy = contact({ id: 'a', interaction_count: 50 })
    const quiet = contact({ id: 'b', interaction_count: 2 })
    expect(choosePrimary(quiet, busy).target.id).toBe('a')
  })
})
