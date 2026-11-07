/**
 * The two spend gates (spec §9).
 *
 * These are the arithmetic behind real money leaving the building, so the
 * tests are deliberately boundary-obsessed: the cases that matter are the ones
 * exactly ON a cap, one cent either side of it, and the corrupt-input cases
 * where the tempting reading ("unknown budget means no limit") is the
 * expensive one.
 */
import { describe, expect, it } from 'vitest'
import {
  ESTIMATED_DISCOVERY_CALL_DOLLARS,
  MAX_RUN_BUDGET_DOLLARS,
  MIN_RUN_BUDGET_DOLLARS,
  PROSPECTING_MONTHLY_CAP_DOLLARS,
  budgetVerdict,
  clampRunBudget,
  monthStartIso,
  monthlyCapVerdict,
  sumSpend,
} from '../spend'

describe('budgetVerdict — the per-run cap, checked BEFORE each call', () => {
  it('admits a call that fits', () => {
    const v = budgetVerdict(0.11, 2.0)
    expect(v.ok).toBe(true)
    expect(v.projected).toBeCloseTo(0.14, 6)
    expect(v.remaining).toBeCloseTo(1.89, 6)
  })

  it('refuses the call that would OVERSHOOT, not the one that already did', () => {
    // This is the whole point of a pre-call gate: at $1.98 spent against a
    // $2.00 cap, the run has money left but not enough for the NEXT call.
    // Checking after the call would have billed $2.01.
    const v = budgetVerdict(1.98, 2.0)
    expect(v.ok).toBe(false)
    expect(v.projected).toBeCloseTo(2.01, 6)
    expect(v.remaining).toBeCloseTo(0.02, 6)
  })

  it('allows a call that lands EXACTLY on the cap', () => {
    // A $2.00 budget that refuses the call making the total exactly $2.00 is a
    // $1.97 budget with a misleading label.
    expect(budgetVerdict(2.0 - ESTIMATED_DISCOVERY_CALL_DOLLARS, 2.0).ok).toBe(true)
  })

  it('refuses everything on a zero budget', () => {
    expect(budgetVerdict(0, 0).ok).toBe(false)
  })

  it('treats a corrupt budget as ZERO, never as unlimited', () => {
    // The expensive misreading. A NaN/negative/absent budget must stop the
    // run, not unbind it.
    for (const bad of [Number.NaN, -5, Infinity, undefined, null, 'oops']) {
      expect(budgetVerdict(0, bad as unknown as number).ok).toBe(false)
    }
  })

  it('accepts the numeric-as-string shape PostgREST can return', () => {
    expect(budgetVerdict('0.11' as unknown as number, '2.0' as unknown as number).ok).toBe(true)
  })

  it('takes an explicit per-call estimate for a differently-priced call', () => {
    // The account card is ≈$0.013 (§12), not $0.03. A gate that could only
    // reason about discovery prices would refuse affordable work.
    expect(budgetVerdict(1.985, 2.0, 0.013).ok).toBe(true)
    expect(budgetVerdict(1.985, 2.0, 0.03).ok).toBe(false)
  })
})

describe('monthlyCapVerdict — the workspace ceiling', () => {
  it('is a documented first guess at $20', () => {
    expect(PROSPECTING_MONTHLY_CAP_DOLLARS).toBe(20)
  })

  it('admits a workspace under the cap', () => {
    const v = monthlyCapVerdict(4.2)
    expect(v.ok).toBe(true)
    expect(v.remaining).toBeCloseTo(15.8, 6)
  })

  it('refuses a workspace EXACTLY at the cap', () => {
    // `>=`, not `>`: a workspace at exactly $20 has no room for a call, and a
    // run admitted there spends past the ceiling on its first search.
    const v = monthlyCapVerdict(PROSPECTING_MONTHLY_CAP_DOLLARS)
    expect(v.ok).toBe(false)
    expect(v.remaining).toBe(0)
  })

  it('refuses a workspace over the cap and never reports negative headroom', () => {
    expect(monthlyCapVerdict(31.5).ok).toBe(false)
    expect(monthlyCapVerdict(31.5).remaining).toBe(0)
  })
})

describe('monthStartIso — the UTC calendar month', () => {
  it('is the first instant of the UTC month, whatever the time of day', () => {
    expect(monthStartIso(new Date('2026-09-04T17:31:02.123Z'))).toBe(
      '2026-09-01T00:00:00.000Z',
    )
  })

  it('does not roll back into the previous month for a UTC-early timestamp', () => {
    // The trap a local-timezone implementation falls into: 00:30 UTC on the
    // 1st is still "last month" in the Americas, and a workspace's ceiling
    // must not move when its owner travels.
    expect(monthStartIso(new Date('2026-09-01T00:30:00Z'))).toBe('2026-09-01T00:00:00.000Z')
  })

  it('handles January without underflowing the year', () => {
    expect(monthStartIso(new Date('2026-01-15T12:00:00Z'))).toBe('2026-01-01T00:00:00.000Z')
  })
})

describe('sumSpend', () => {
  it('sums and tolerates nulls, strings and junk', () => {
    expect(
      sumSpend([
        { spent_dollars: 0.11 },
        { spent_dollars: '0.22' },
        { spent_dollars: null },
        {},
        { spent_dollars: -3 },
      ]),
    ).toBeCloseTo(0.33, 6)
  })

  it('is zero for an empty month', () => {
    expect(sumSpend([])).toBe(0)
  })
})

describe('clampRunBudget', () => {
  it('passes a sane request through', () => {
    expect(clampRunBudget(3.5, 2.0)).toBe(3.5)
  })

  it('clamps to the band at both ends', () => {
    expect(clampRunBudget(0.01, 2.0)).toBe(MIN_RUN_BUDGET_DOLLARS)
    expect(clampRunBudget(999, 2.0)).toBe(MAX_RUN_BUDGET_DOLLARS)
  })

  it('falls back to the list default when nothing usable was requested', () => {
    for (const bad of [undefined, null, 0, -1, 'x', Number.NaN]) {
      expect(clampRunBudget(bad, 2.0)).toBe(2.0)
    }
  })

  it('never produces an unbounded run from a corrupt list default', () => {
    expect(clampRunBudget(undefined, Number.NaN)).toBe(MIN_RUN_BUDGET_DOLLARS)
    expect(clampRunBudget(undefined, 10_000)).toBe(MAX_RUN_BUDGET_DOLLARS)
  })
})
