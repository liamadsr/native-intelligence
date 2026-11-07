/**
 * The gate's arithmetic (§9, "Consent happens once, with real numbers").
 *
 * These four functions are the only place a dollar figure is produced before a
 * run, and every one of them is a promise: the number shown is the number the
 * engine will spend, because it multiplies the SAME per-call constants
 * `budgetVerdict` reserves against. So the assertions below derive their
 * expectations from those constants rather than hard-coding "$0.23" — a test
 * with the string baked in keeps passing when the constant moves and the gate
 * quietly starts quoting last month's price.
 *
 * `peopleYieldLabel` is not arithmetic but it is the same class of promise, in
 * the other direction: §7 Stage 4 requires the People surface to state
 * partiality, because a domain-anchored search over an index that does not
 * contain every profile yields 1–3 people and sometimes zero. A tab that
 * implied a full roster would make a working stage read as broken.
 */
import { describe, it, expect } from 'vitest'
import {
  companiesLabel,
  estimateAccountCardDollars,
  estimateMinutesLabel,
  estimatePeopleDollars,
  hasAccountCard,
  peopleYieldLabel,
  PROSPECT_ACCOUNT_CARD_KEYS,
} from '../ui-helpers'
import {
  ESTIMATED_ACCOUNT_CARD_DOLLARS,
  ESTIMATED_PEOPLE_CALL_DOLLARS,
  ESTIMATED_SECONDS_PER_COMPANY,
} from '@/lib/prospecting/spend'
import { PROSPECT_ACCOUNT_CARD } from '@/lib/prospecting/schemas'

describe('estimateAccountCardDollars', () => {
  it('multiplies the engine’s own per-call reservation', () => {
    expect(estimateAccountCardDollars(18)).toBeCloseTo(18 * ESTIMATED_ACCOUNT_CARD_DOLLARS, 6)
  })

  it('is zero for a selection of nothing, and for nonsense', () => {
    expect(estimateAccountCardDollars(0)).toBe(0)
    expect(estimateAccountCardDollars(-4)).toBe(0)
    expect(estimateAccountCardDollars(Number.NaN)).toBe(0)
  })
})

describe('estimatePeopleDollars', () => {
  it('prices ONE call per company — never per company × person', () => {
    // The whole point: `people_per_company` caps how many people are KEPT, so
    // a list set to 10 costs exactly what one set to 3 costs.
    expect(estimatePeopleDollars(12)).toBeCloseTo(12 * ESTIMATED_PEOPLE_CALL_DOLLARS, 6)
  })
})

describe('estimateMinutesLabel', () => {
  it('rounds up to whole minutes and says "roughly"', () => {
    // 18 × 10s = 180s.
    expect(estimateMinutesLabel(18)).toBe('roughly 3 minutes')
    // 19 × 10s = 190s → still 4 minutes' worth of waiting, not 3.1.
    expect(estimateMinutesLabel(19)).toBe('roughly 4 minutes')
  })

  it('never renders "roughly 0 minutes"', () => {
    expect(estimateMinutesLabel(0)).toBe('under a minute')
    expect(estimateMinutesLabel(3)).toBe('about a minute')
  })

  it('takes the per-company seconds from the shared constant', () => {
    const six = 6 * ESTIMATED_SECONDS_PER_COMPANY
    expect(six).toBe(60)
    expect(estimateMinutesLabel(6)).toBe('about a minute')
  })
})

describe('companiesLabel', () => {
  it('agrees with itself on the singular', () => {
    expect(companiesLabel(1)).toBe('1 company')
    expect(companiesLabel(18)).toBe('18 companies')
    expect(companiesLabel(0)).toBe('0 companies')
  })
})

describe('peopleYieldLabel', () => {
  it('states the shortfall the People tab is required to state', () => {
    expect(peopleYieldLabel(3, 5)).toBe('Found 3 of the 5 roles you asked for')
  })

  it('says so plainly when nothing was missed', () => {
    expect(peopleYieldLabel(5, 5)).toBe('Found all 5 roles you asked for')
    // Over-delivery is still not a shortfall.
    expect(peopleYieldLabel(6, 5)).toBe('Found all 5 roles you asked for')
  })

  it('handles the singular', () => {
    expect(peopleYieldLabel(0, 1)).toBe('Found 0 of the 1 role you asked for')
  })

  it('is empty when no target was ever set — there is no claim to make', () => {
    // A discovery run never sets `people_target`; rendering "Found 0 of the 0"
    // would report a stage that ran and found nobody.
    expect(peopleYieldLabel(0, 0)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// hasAccountCard — the gate's population predicate
// ---------------------------------------------------------------------------

/**
 * THE BUG THIS PINS, observed live on a 45-company list:
 *
 *   > 1 company to research … Find people at 44 companies you have researched
 *
 * The gate asked "is the `research` blob non-empty?". But DISCOVERY writes a
 * research blob too — name, domain, signal, one_liner, why_match,
 * founded_year, employee_range — so that question is true for every company
 * the instant it is discovered. The one company it offered to research was the
 * hand-added entry, the only row with a genuinely empty blob, and the 44 it
 * offered people-search for had never had an account card run at all. Both
 * halves of the gate were pointed at the wrong set.
 *
 * The predicate is now the explicit `candidate.account_card_at` stamp, with
 * the card's own keys as the fallback for rows enriched before the stamp
 * existed.
 */
describe('hasAccountCard', () => {
  /** What discovery actually writes — no account-card key among them. */
  const DISCOVERY_BLOB = {
    name: { value: 'Quoteleaf' },
    domain: { value: 'quoteleaf.com' },
    one_liner: { value: 'Document automation' },
    why_match: { value: 'Sells to sales teams' },
    signal: { value: 'Raised a Series C' },
    founded_year: { value: '2011' },
    employee_range: { value: '700' },
  }

  it('a DISCOVERY-only entry has NOT been carded — the whole bug', () => {
    expect(hasAccountCard({ candidate: { domain: 'quoteleaf.com' }, research: DISCOVERY_BLOB }))
      .toBe(false)
  })

  it('the stamp alone makes an entry carded', () => {
    expect(
      hasAccountCard({
        candidate: { domain: 'quoteleaf.com', account_card_at: '2026-09-04T12:00:00.000Z' },
        research: DISCOVERY_BLOB,
      }),
    ).toBe(true)
  })

  it('a card that yielded NOTHING still counts, on the stamp', () => {
    // The reason the stamp is written unconditionally: an entry the user paid
    // for must leave the queue even when the card came back empty, or the gate
    // re-offers it at full price forever.
    expect(
      hasAccountCard({
        candidate: { account_card_at: '2026-09-04T12:00:00.000Z' },
        research: {},
      }),
    ).toBe(true)
  })

  it('FALLBACK: a pre-stamp row is recognised by the card keys', () => {
    expect(
      hasAccountCard({
        candidate: { domain: 'quoteleaf.com' },
        research: { ...DISCOVERY_BLOB, employee_count: { value: '700+ employees' } },
      }),
    ).toBe(true)
  })

  it('the fallback reads the `{ fields: … }` shape too', () => {
    expect(
      hasAccountCard({
        candidate: {},
        research: { fields: { headquarters: { value: 'San Francisco' } } },
      }),
    ).toBe(true)
  })

  it('every account-card key is on its own sufficient for the fallback', () => {
    for (const key of PROSPECT_ACCOUNT_CARD_KEYS) {
      expect(hasAccountCard({ candidate: {}, research: { [key]: { value: 'x' } } })).toBe(true)
    }
  })

  it('an empty or absent entry is not carded, and does not throw', () => {
    expect(hasAccountCard({})).toBe(false)
    expect(hasAccountCard({ candidate: null, research: null })).toBe(false)
    expect(hasAccountCard({ candidate: 'nonsense', research: [] })).toBe(false)
    expect(hasAccountCard({ candidate: { account_card_at: '   ' }, research: {} })).toBe(false)
  })
})

/**
 * The lockstep `ui-helpers.ts` cannot assert for itself.
 *
 * `PROSPECT_ACCOUNT_CARD_KEYS` is a hand-written literal there rather than a
 * derivation of {@link PROSPECT_ACCOUNT_CARD}, because importing `schemas.ts`
 * into a client module would pull its module-load `assertSchemaWithinCapDeep`
 * calls into the browser bundle for the sake of a nine-element array. A TEST
 * has no such constraint, so the agreement is pinned here — and it is worth
 * pinning: a schema property renamed without the literal following it would
 * silently narrow the fallback, and the only symptom would be a handful of
 * pre-stamp rows drifting back into the research queue.
 */
describe('PROSPECT_ACCOUNT_CARD_KEYS matches the schema', () => {
  it('is exactly the card schema properties, snake-cased — minus fitScore, which is a column', () => {
    // `applyCard` strips `fit_score` out of the card before the research
    // merge (it lands in the `fit_score` column, not the blob), so the blob
    // keys the fallback may look for are every schema property BUT that one.
    const expected = Object.keys(PROSPECT_ACCOUNT_CARD.properties)
      .filter((k) => k !== 'fitScore')
      .map((k) => k.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase())
    expect([...PROSPECT_ACCOUNT_CARD_KEYS].sort()).toEqual(expected.sort())
  })
})
