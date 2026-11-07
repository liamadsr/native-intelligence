/**
 * The cost quote a user sees before anything runs (spec §10).
 *
 * The number matters because it is the ONLY thing standing between "run the
 * suite" and a surprise bill — `max_cost_usd` is a multiple of it, and the
 * `/create-eval` skill quotes it out loud before starting a run. So the tests
 * lock the SHAPE of the bill (judges dominate; live costs more than batch;
 * trials multiply) rather than the exact constants, which are first guesses.
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_JUDGE_COUNT,
  DEFAULT_LIVE_JUDGE_COUNT,
  defaultJudgeCount,
  ESTIMATED_BATCH_TRIAL_USD,
  ESTIMATED_JUDGE_CALL_USD,
  ESTIMATED_LIVE_TRIAL_USD,
  estimateRunCostUsd,
} from '../estimate'

describe('estimateRunCostUsd', () => {
  it('costs one batch trial as the target call plus the default judges', () => {
    expect(estimateRunCostUsd({ caseCount: 1, mode: 'batch', trialsPerCase: 1 })).toBeCloseTo(
      ESTIMATED_BATCH_TRIAL_USD + DEFAULT_JUDGE_COUNT * ESTIMATED_JUDGE_CALL_USD,
      6,
    )
  })

  it('costs a live trial more than a batch one — twelve route calls, not one', () => {
    const live = estimateRunCostUsd({ caseCount: 1, mode: 'live', trialsPerCase: 1, judgeCount: 0 })
    const batch = estimateRunCostUsd({ caseCount: 1, mode: 'batch', trialsPerCase: 1, judgeCount: 0 })
    expect(live).toBeGreaterThan(batch)
    expect(live).toBeCloseTo(ESTIMATED_LIVE_TRIAL_USD, 6)
  })

  it('makes judges the dominant term, which is the whole point of the parameter', () => {
    const withJudges = estimateRunCostUsd({ caseCount: 1, mode: 'live', trialsPerCase: 1 })
    const without = estimateRunCostUsd({ caseCount: 1, mode: 'live', trialsPerCase: 1, judgeCount: 0 })
    expect(withJudges).toBeGreaterThan(without * 5)
  })

  it('scales linearly in cases and in attempts', () => {
    const one = estimateRunCostUsd({ caseCount: 1, mode: 'batch', trialsPerCase: 1 })
    expect(estimateRunCostUsd({ caseCount: 20, mode: 'batch', trialsPerCase: 1 })).toBeCloseTo(one * 20, 6)
    expect(estimateRunCostUsd({ caseCount: 4, mode: 'batch', trialsPerCase: 3 })).toBeCloseTo(one * 12, 6)
  })

  it('lands a 20-case batch sweep in the spec\'s dollars-not-tens-of-dollars band', () => {
    const sweep = estimateRunCostUsd({ caseCount: 20, mode: 'batch', trialsPerCase: 1 })
    expect(sweep).toBeGreaterThan(1)
    expect(sweep).toBeLessThan(5)
  })

  it('is zero when nothing would execute', () => {
    expect(estimateRunCostUsd({ caseCount: 0, mode: 'live', trialsPerCase: 3 })).toBe(0)
    expect(estimateRunCostUsd({ caseCount: 5, mode: 'live', trialsPerCase: 0 })).toBe(0)
  })

  it('never returns more precision than numeric(10,6) can hold', () => {
    const value = estimateRunCostUsd({ caseCount: 7, mode: 'live', trialsPerCase: 3, judgeCount: 5 })
    expect(value).toBe(Math.round(value * 1_000_000) / 1_000_000)
  })

  it('floors negative or fractional inputs rather than returning nonsense', () => {
    expect(estimateRunCostUsd({ caseCount: -3, mode: 'batch', trialsPerCase: 2 })).toBe(0)
    expect(estimateRunCostUsd({ caseCount: 2.9, mode: 'batch', trialsPerCase: 1, judgeCount: 0 })).toBeCloseTo(
      ESTIMATED_BATCH_TRIAL_USD * 2,
      6,
    )
  })
})

describe('the default judge count follows the mode', () => {
  // judge_nudges runs on live trials only, so a live quote (and the 3x
  // max_cost_usd headroom on top of it) counts one judge more than batch.
  it('counts judge_nudges on a live run and not on a batch one', () => {
    expect(defaultJudgeCount('batch')).toBe(DEFAULT_JUDGE_COUNT)
    expect(defaultJudgeCount('live')).toBe(DEFAULT_LIVE_JUDGE_COUNT)
    expect(DEFAULT_LIVE_JUDGE_COUNT).toBe(DEFAULT_JUDGE_COUNT + 1)
    expect(estimateRunCostUsd({ caseCount: 1, mode: 'live', trialsPerCase: 1 })).toBeCloseTo(
      ESTIMATED_LIVE_TRIAL_USD + DEFAULT_LIVE_JUDGE_COUNT * ESTIMATED_JUDGE_CALL_USD,
      6,
    )
  })

  it('still honours an explicit judge count in either mode', () => {
    expect(estimateRunCostUsd({ caseCount: 1, mode: 'live', trialsPerCase: 1, judgeCount: 0 })).toBeCloseTo(
      ESTIMATED_LIVE_TRIAL_USD,
      6,
    )
  })
})
