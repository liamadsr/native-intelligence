/**
 * Tests for `gateModeForCapture` — the extraction authority's capture-derived
 * run mode (evals spec §5.1).
 *
 * WHAT THIS GUARDS: an EVAL capture is a synthetic mock meeting. If its
 * extraction pass ran in 'act' mode, a mock sales call would auto-file real
 * actions onto a real board — the feature's worst failure mode. The two things
 * that matter are the mapping itself and, just as much, that it is TOTAL: a
 * capture row read back without the column, or with a null/undefined/0/'' in
 * it, must resolve to 'act' (a REAL capture behaves exactly as it did before
 * migration 252) rather than to some third state.
 */
import { describe, it, expect } from 'vitest'
import { decideAutoApply, gateModeForCapture } from '../auto-apply-gate'
import { DEFAULT_TRUST_POLICY } from '../trust-policy'

describe('gateModeForCapture', () => {
  it("returns 'report' for an eval capture", () => {
    expect(gateModeForCapture({ is_eval: true })).toBe('report')
  })

  it("returns 'act' for a real capture", () => {
    expect(gateModeForCapture({ is_eval: false })).toBe('act')
  })

  it("returns 'act' when the flag is absent, null or undefined", () => {
    // A capture row selected before migration 252 landed, or a select that
    // forgot the column, must NOT silently become an eval capture — nor stop
    // auto-applying. Both degrade to today's behavior.
    expect(gateModeForCapture({})).toBe('act')
    expect(gateModeForCapture({ is_eval: null })).toBe('act')
    expect(gateModeForCapture({ is_eval: undefined })).toBe('act')
  })

  it('is strictly === true, never truthy-coerced', () => {
    // PostgREST hands back real booleans, but a hand-built fixture or a jsonb
    // round-trip can carry a string. Only a real `true` fences the capture; and
    // a truthy-but-not-true value must not accidentally fence a REAL capture
    // out of auto-apply either.
    const loose = { is_eval: 'true' } as unknown as { is_eval?: boolean | null }
    expect(gateModeForCapture(loose)).toBe('act')
    expect(gateModeForCapture({ is_eval: 0 as unknown as boolean })).toBe('act')
  })
})

describe('gateModeForCapture — fed into decideAutoApply', () => {
  // The end-to-end point of the helper: the SAME proposal that auto-applies on
  // a real capture stages on an eval one, with nothing else changed.
  const proposal = { change_type: 'create', entity_type: 'action', confidence: 0.99 }
  const gate = (capture: { is_eval?: boolean | null }) =>
    decideAutoApply(proposal, DEFAULT_TRUST_POLICY, {
      authority: 'extraction' as const,
      mode: gateModeForCapture(capture),
      isMineExplicit: true,
    })

  it('applies a high-confidence verified-mine action on a real capture', () => {
    expect(gate({ is_eval: false })).toBe('apply')
  })

  it('STAGES that same action on an eval capture', () => {
    expect(gate({ is_eval: true })).toBe('stage')
  })
})
