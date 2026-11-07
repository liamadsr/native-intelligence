import { describe, it, expect } from 'vitest'
import {
  DEFAULT_POLICY,
  shouldPromoteByCorroboration,
  CORROBORATION_MIN_SOURCES,
  CORROBORATION_CONFIDENCE_SLACK,
} from '../auto-accept'

/**
 * Corroboration promotion: a suggested claim re-asserted by independent
 * sources clears a RELAXED confidence bar — but only with the policy enabled,
 * only with enough distinct sources, and never for unscored claims.
 */

describe('shouldPromoteByCorroboration', () => {
  const policy = { ...DEFAULT_POLICY } // claims threshold 0.85

  it('promotes a multi-sourced claim just under the normal threshold', () => {
    const conf = policy.claims - CORROBORATION_CONFIDENCE_SLACK + 0.01
    expect(
      shouldPromoteByCorroboration('claims', conf, CORROBORATION_MIN_SOURCES, policy),
    ).toBe(true)
  })

  it('rejects below the relaxed threshold even with many sources', () => {
    const conf = policy.claims - CORROBORATION_CONFIDENCE_SLACK - 0.05
    expect(shouldPromoteByCorroboration('claims', conf, 6, policy)).toBe(false)
  })

  it('requires the minimum distinct source count', () => {
    expect(
      shouldPromoteByCorroboration('claims', 0.9, CORROBORATION_MIN_SOURCES - 1, policy),
    ).toBe(false)
    expect(shouldPromoteByCorroboration('claims', 0.9, 0, policy)).toBe(false)
  })

  it('never promotes unscored claims, regardless of evidence', () => {
    expect(shouldPromoteByCorroboration('claims', null, 5, policy)).toBe(false)
    expect(shouldPromoteByCorroboration('claims', undefined, 5, policy)).toBe(false)
    expect(shouldPromoteByCorroboration('claims', Number.NaN, 5, policy)).toBe(false)
  })

  it('respects the kill-switch', () => {
    expect(
      shouldPromoteByCorroboration('claims', 0.95, 4, { ...policy, enabled: false }),
    ).toBe(false)
  })
})
