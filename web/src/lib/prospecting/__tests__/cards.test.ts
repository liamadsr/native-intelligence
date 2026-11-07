/**
 * `hasAccountCard` — the ONE predicate for "has this company been researched?"
 *
 * The behavioural cases live next to the page gate that has always used it
 * (`src/app/account/(dashboard)/prospecting/__tests__/gate-estimates.test.ts`,
 * which also pins the fallback key list against the account-card schema). What
 * this file adds is the reason the function MOVED here: three call sites — the
 * page gate, the agent's `entrySummary`, and `find_prospects`'s decision about
 * which companies a card run may skip — must be looking at the same function.
 * A second copy that disagreed about the fallback would either re-bill a
 * pre-stamp company on every call or leave it permanently unresearchable.
 */
import { describe, it, expect } from 'vitest'
import { hasAccountCard, PROSPECT_ACCOUNT_CARD_KEYS } from '../cards'
import * as uiHelpers from '@/app/account/(dashboard)/prospecting/ui-helpers'

describe('hasAccountCard', () => {
  it('is true on the explicit stamp', () => {
    expect(hasAccountCard({ candidate: { account_card_at: '2026-09-04T00:00:00Z' } })).toBe(true)
  })

  it('is FALSE for a discovery blob, which every entry has from the moment it is found', () => {
    // The inverted-gate bug: discovery writes `one_liner` / `why_match` /
    // `signal`, so "the research blob is non-empty" is true for every company
    // that has never had a card.
    expect(
      hasAccountCard({
        candidate: { name: 'Vanta', domain: 'vanta.com' },
        research: { one_liner: 'Compliance automation', why_match: 'SOC2', signal: 'Series B' },
      }),
    ).toBe(false)
  })

  it('falls back to the card keys for pre-stamp rows, in both blob shapes', () => {
    expect(hasAccountCard({ research: { employee_count: { value: 400 } } })).toBe(true)
    expect(hasAccountCard({ research: { fields: { funding_stage: { value: 'Series C' } } } })).toBe(
      true,
    )
  })

  it('never throws on a malformed row', () => {
    expect(hasAccountCard({})).toBe(false)
    expect(hasAccountCard({ candidate: null, research: null })).toBe(false)
    expect(hasAccountCard({ candidate: 'nonsense', research: [] })).toBe(false)
    expect(hasAccountCard({ candidate: { account_card_at: '   ' }, research: {} })).toBe(false)
  })
})

describe('the page re-export is the SAME function', () => {
  it('ui-helpers re-exports this module rather than carrying a second copy', () => {
    // Identity, not equivalence: two implementations that agree today are
    // exactly the setup that produced the inverted gate. The page's callers
    // (`list-detail.tsx`) import through ui-helpers and must
    // reach this function.
    expect(uiHelpers.hasAccountCard).toBe(hasAccountCard)
    expect(uiHelpers.PROSPECT_ACCOUNT_CARD_KEYS).toBe(PROSPECT_ACCOUNT_CARD_KEYS)
  })
})
