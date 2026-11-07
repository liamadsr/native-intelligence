import { describe, it, expect } from 'vitest'
import {
  hasEnoughSignIns,
  MIN_SIGN_INS_FOR_NUDGES,
  SIGN_IN_COUNT_CEILING,
} from '../sign-in-count'

/**
 * The gate that keeps first-run nudges (currently the voice-enrollment card)
 * away from brand-new users.
 *
 * The invariant that matters most is the FAIL-OPEN on a missing count: existing
 * users predate the counter, and treating absent-as-ineligible would silence
 * the nudge for them permanently.
 */
describe('hasEnoughSignIns', () => {
  it('holds the nudge back for the first sessions', () => {
    // 1 = the signup session itself, when the wizard/guide/arrival dashboard
    // are already competing for attention.
    for (let count = 1; count < MIN_SIGN_INS_FOR_NUDGES; count++) {
      expect(hasEnoughSignIns(count)).toBe(false)
    }
  })

  it('allows the nudge once the threshold is reached', () => {
    expect(hasEnoughSignIns(MIN_SIGN_INS_FOR_NUDGES)).toBe(true)
    expect(hasEnoughSignIns(MIN_SIGN_INS_FOR_NUDGES + 1)).toBe(true)
    expect(hasEnoughSignIns(999)).toBe(true)
  })

  it('FAILS OPEN for users with no count recorded', () => {
    // Everyone who signed up before the counter existed. Absent must not mean
    // "brand new", or the nudge never shows for them again.
    expect(hasEnoughSignIns(undefined)).toBe(true)
    expect(hasEnoughSignIns(null)).toBe(true)
  })

  it('fails open on a corrupt value rather than silencing forever', () => {
    // user_metadata is loosely typed and client-writable; a junk value must not
    // permanently suppress the nudge.
    expect(hasEnoughSignIns('3')).toBe(true)
    expect(hasEnoughSignIns({})).toBe(true)
    expect(hasEnoughSignIns(NaN)).toBe(true)
    expect(hasEnoughSignIns(Infinity)).toBe(true)
  })

  it('treats 0 as a brand-new user, not a missing value', () => {
    // 0 is a real recorded count (finite number), so it must gate — this is the
    // case a loose `!rawCount` check would get wrong.
    expect(hasEnoughSignIns(0)).toBe(false)
  })

  it('keeps the write ceiling above the threshold', () => {
    // The route stops incrementing at the ceiling; if it sat below the
    // threshold the counter could never reach it and the nudge would never show.
    expect(SIGN_IN_COUNT_CEILING).toBeGreaterThanOrEqual(MIN_SIGN_INS_FOR_NUDGES)
  })
})
