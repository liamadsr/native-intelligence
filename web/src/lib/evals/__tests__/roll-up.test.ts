import { describe, expect, it } from 'vitest'
import { runRollup, scoresFromChecks, trialOutcomeFromChecks } from '../roll-up'
import type { EvalCheckRow, EvalDimension, Severity } from '../types'

type Check = Pick<EvalCheckRow, 'dimension' | 'severity' | 'outcome'>

function check(
  outcome: EvalCheckRow['outcome'],
  severity: Severity = 'soft',
  dimension: EvalDimension = 'proposals',
): Check {
  return { dimension, severity, outcome }
}

describe('trialOutcomeFromChecks', () => {
  it('fails on any gate failure, whatever else passed', () => {
    expect(
      trialOutcomeFromChecks([check('pass'), check('fail', 'gate'), check('pass')]),
    ).toBe('failed')
  })

  it('scores when only a soft check failed', () => {
    expect(trialOutcomeFromChecks([check('pass', 'gate'), check('fail', 'soft')])).toBe('scored')
  })

  it('passes when nothing failed', () => {
    expect(trialOutcomeFromChecks([check('pass', 'gate'), check('pass')])).toBe('passed')
  })

  it('treats an empty check list as passed — nothing asserted, nothing failed', () => {
    expect(trialOutcomeFromChecks([])).toBe('passed')
  })

  it('never fails on unknown or skipped, at either severity', () => {
    expect(
      trialOutcomeFromChecks([
        check('unknown', 'gate'),
        check('skipped', 'gate'),
        check('unknown', 'soft'),
        check('skipped', 'soft'),
      ]),
    ).toBe('passed')
  })

  it('a gate failure beats a soft failure — one verdict, not both', () => {
    expect(trialOutcomeFromChecks([check('fail', 'soft'), check('fail', 'gate')])).toBe('failed')
  })
})

describe('scoresFromChecks — unknown and skipped stay out of the denominator', () => {
  it('divides passes by DECIDED checks only', () => {
    const scores = scoresFromChecks([
      check('pass'),
      check('pass'),
      check('fail'),
      check('unknown'),
      check('skipped'),
    ])
    expect(scores.proposals).toEqual({
      pass: 2,
      fail: 1,
      unknown: 1,
      skipped: 1,
      rate: 2 / 3,
    })
  })

  it('a dimension with no decided checks scores null, never zero', () => {
    const scores = scoresFromChecks([check('unknown'), check('skipped')])
    expect(scores.proposals.rate).toBeNull()
    // The distinction that matters: 0 would render as "everything failed".
    expect(scores.proposals.rate).not.toBe(0)
  })

  it('a dimension with no checks at all is ABSENT, not an empty tally', () => {
    const scores = scoresFromChecks([check('pass', 'soft', 'summary')])
    expect(Object.keys(scores)).toEqual(['summary'])
    expect(scores.nudges).toBeUndefined()
  })

  it('tallies each dimension independently', () => {
    const scores = scoresFromChecks([
      check('pass', 'soft', 'summary'),
      check('fail', 'gate', 'proposals'),
      check('pass', 'gate', 'gate'),
    ])
    expect(scores.summary.rate).toBe(1)
    expect(scores.proposals.rate).toBe(0)
    expect(scores.gate.rate).toBe(1)
  })
})

describe('runRollup', () => {
  const trial = (
    outcome: 'passed' | 'scored' | 'failed' | 'errored' | null,
    checks: Check[] = [],
    status: 'completed' | 'errored' = outcome === 'errored' ? 'errored' : 'completed',
  ) => ({ status, outcome, checks })

  it('passes when every trial passed', () => {
    const { outcome } = runRollup([trial('passed', [check('pass')]), trial('passed')])
    expect(outcome).toBe('passed')
  })

  it('scores when a trial only scored', () => {
    expect(runRollup([trial('passed'), trial('scored')]).outcome).toBe('scored')
  })

  it('fails when any trial failed', () => {
    expect(runRollup([trial('passed'), trial('scored'), trial('failed')]).outcome).toBe('failed')
  })

  it('an ERRORED trial fails the run — a suite cannot be green while a case never ran', () => {
    expect(runRollup([trial('passed'), trial('errored')]).outcome).toBe('failed')
  })

  it('a run with no trials fails rather than reporting a vacuous green', () => {
    const { outcome, scores } = runRollup([])
    expect(outcome).toBe('failed')
    expect(scores).toEqual({})
  })

  it('aggregates scores across every trial in the run', () => {
    const { scores } = runRollup([
      trial('passed', [check('pass'), check('pass', 'soft', 'summary')]),
      trial('scored', [check('fail')]),
    ])
    expect(scores.proposals).toMatchObject({ pass: 1, fail: 1, rate: 0.5 })
    expect(scores.summary).toMatchObject({ pass: 1, rate: 1 })
  })

  it('still reports scores for a run it marks failed — a stopped sweep is readable', () => {
    const { outcome, scores } = runRollup([
      trial('passed', [check('pass')]),
      trial('errored', []),
    ])
    expect(outcome).toBe('failed')
    expect(scores.proposals.pass).toBe(1)
  })
})
