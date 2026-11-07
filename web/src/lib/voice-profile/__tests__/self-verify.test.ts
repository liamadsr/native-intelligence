import { describe, it, expect } from 'vitest'

/**
 * Tests for src/lib/voice-profile/self-verify.ts — the live self-verification
 * vote machine ("is this speaker ME?").
 *
 * Scenarios encode the contract in §7 of the implementation plan:
 * - GRANT is 2 qualifying votes of the last 3, latched (never un-grants).
 * - A vote only qualifies when selfSim clears SELF_VERIFY_THRESHOLD AND beats
 *   the best contact by SELF_VERIFY_MARGIN — so a strong contact competing for
 *   the same segment blocks the self grant even at high selfSim.
 * - DEMOTION of the default label needs 3 CONSECUTIVE sub-floor votes; a single
 *   good vote resets the streak. Non-default labels never demote.
 * - An un-enrolled user never reaches this machine (the caller skips it), so
 *   there is no "no profile" path to test here — it's inert by construction.
 */

import {
  createSelfVoteState,
  recordSelfVote,
  selfVoteIsClose,
  selfVoteQualifies,
  ungrantSelfVote,
  SELF_DEFAULT_LABEL,
  SELF_VOTE_WINDOW,
  SELF_MISMATCH_STREAK,
  type SelfVote,
} from '@/lib/voice-profile/self-verify'
import {
  SELF_VERIFY_THRESHOLD,
  SELF_VERIFY_MARGIN,
  SELF_MISMATCH_THRESHOLD,
  SELF_SUGGEST_THRESHOLD,
} from '@/lib/voice-profile/types'

// ── Helpers ──────────────────────────────────────────────────

/** A vote that clears both gates by a comfortable margin. */
function goodVote(selfSim = 0.9, bestContactSim = 0.5): SelfVote {
  return { selfSim, bestContactSim }
}

// ── selfVoteQualifies ────────────────────────────────────────

describe('selfVoteQualifies', () => {
  it('qualifies when selfSim clears the threshold and beats contacts by margin', () => {
    expect(selfVoteQualifies({ selfSim: 0.85, bestContactSim: 0.5 })).toBe(true)
  })

  it('rejects selfSim below the threshold even with a huge margin', () => {
    expect(
      selfVoteQualifies({ selfSim: SELF_VERIFY_THRESHOLD - 0.001, bestContactSim: 0 }),
    ).toBe(false)
  })

  it('rejects when a contact scores within the margin (ambiguous)', () => {
    // selfSim above threshold, but only 0.01 over the contact → under margin.
    expect(selfVoteQualifies({ selfSim: 0.9, bestContactSim: 0.9 - 0.01 })).toBe(false)
  })

  it('treats a missing contact gallery (bestContactSim 0) as a plain threshold', () => {
    expect(selfVoteQualifies({ selfSim: SELF_VERIFY_THRESHOLD, bestContactSim: 0 })).toBe(true)
  })

  it('honors exact boundary values (>=, not >)', () => {
    expect(
      selfVoteQualifies({
        selfSim: SELF_VERIFY_THRESHOLD,
        bestContactSim: SELF_VERIFY_THRESHOLD - SELF_VERIFY_MARGIN,
      }),
    ).toBe(true)
  })
})

// ── Grant: 2-of-3 window, latched ────────────────────────────

describe('recordSelfVote — grant', () => {
  it('grants after 2 qualifying votes within the window', () => {
    const state = createSelfVoteState()
    const r1 = recordSelfVote(state, goodVote(), false)
    expect(r1.granted).toBe(false)
    const r2 = recordSelfVote(state, goodVote(), false)
    expect(r2.granted).toBe(true)
    expect(state.granted).toBe(true)
  })

  it('fires granted:true only on the transition, never again (latch)', () => {
    const state = createSelfVoteState()
    recordSelfVote(state, goodVote(), false)
    const grant = recordSelfVote(state, goodVote(), false)
    expect(grant.granted).toBe(true)
    // Further votes must not re-fire the grant transition.
    const after = recordSelfVote(state, goodVote(), false)
    expect(after.granted).toBe(false)
    expect(state.granted).toBe(true)
  })

  it('does not grant on a single qualifying vote surrounded by non-qualifiers', () => {
    const state = createSelfVoteState()
    recordSelfVote(state, { selfSim: 0.5, bestContactSim: 0 }, false)
    const r = recordSelfVote(state, goodVote(), false)
    expect(r.granted).toBe(false)
    expect(state.granted).toBe(false)
  })

  it('needs 2 qualifiers within the SAME last-3 window (older ones slide off)', () => {
    const state = createSelfVoteState()
    // one qualifier, then two non-qualifiers push the window past it
    recordSelfVote(state, goodVote(), false)
    recordSelfVote(state, { selfSim: 0.5, bestContactSim: 0 }, false)
    recordSelfVote(state, { selfSim: 0.5, bestContactSim: 0 }, false)
    // window now holds [good, bad, bad]; a 4th vote drops the good one
    const r = recordSelfVote(state, goodVote(), false)
    // last-3 window is [bad, bad, good] → only 1 qualifier → no grant
    expect(r.granted).toBe(false)
    expect(state.window.length).toBe(SELF_VOTE_WINDOW)
  })

  it('does not grant when a strong contact blocks the margin on every vote', () => {
    const state = createSelfVoteState()
    // High selfSim, but contact is nearly as high → margin fails.
    recordSelfVote(state, { selfSim: 0.92, bestContactSim: 0.91 }, false)
    const r = recordSelfVote(state, { selfSim: 0.92, bestContactSim: 0.91 }, false)
    expect(r.granted).toBe(false)
    expect(state.granted).toBe(false)
  })
})

// ── Demotion: 3 consecutive sub-floor votes on the default label ─

describe('recordSelfVote — demotion', () => {
  it('demotes local_1 after 3 consecutive sub-floor votes', () => {
    const state = createSelfVoteState()
    const low: SelfVote = { selfSim: SELF_MISMATCH_THRESHOLD - 0.1, bestContactSim: 0 }
    expect(recordSelfVote(state, low, true).demoted).toBe(false)
    expect(recordSelfVote(state, low, true).demoted).toBe(false)
    expect(recordSelfVote(state, low, true).demoted).toBe(true)
    expect(state.mismatchStreak).toBe(SELF_MISMATCH_STREAK)
  })

  it('resets the streak on a single at-floor vote (needs SUSTAINED mismatch)', () => {
    const state = createSelfVoteState()
    const low: SelfVote = { selfSim: 0.4, bestContactSim: 0 }
    recordSelfVote(state, low, true)
    recordSelfVote(state, low, true)
    // A vote at/above the floor resets the streak.
    const reset = recordSelfVote(state, { selfSim: SELF_MISMATCH_THRESHOLD, bestContactSim: 0 }, true)
    expect(reset.demoted).toBe(false)
    expect(state.mismatchStreak).toBe(0)
    // Now it takes a fresh run of 3 to demote.
    recordSelfVote(state, low, true)
    recordSelfVote(state, low, true)
    expect(recordSelfVote(state, low, true).demoted).toBe(true)
  })

  it('never demotes a non-default label (isDefaultLabel false)', () => {
    const state = createSelfVoteState()
    const low: SelfVote = { selfSim: 0.2, bestContactSim: 0 }
    for (let i = 0; i < 5; i++) {
      expect(recordSelfVote(state, low, false).demoted).toBe(false)
    }
    expect(state.mismatchStreak).toBe(0)
  })

  it('does not demote on the boundary value (< is strict)', () => {
    const state = createSelfVoteState()
    const atFloor: SelfVote = { selfSim: SELF_MISMATCH_THRESHOLD, bestContactSim: 0 }
    recordSelfVote(state, atFloor, true)
    recordSelfVote(state, atFloor, true)
    expect(recordSelfVote(state, atFloor, true).demoted).toBe(false)
    expect(state.mismatchStreak).toBe(0)
  })

  it('a grant and a demotion are independent signals on the same label', () => {
    // A default label can accrue a grant and separately not be demoted.
    const state = createSelfVoteState()
    recordSelfVote(state, goodVote(), true)
    const g = recordSelfVote(state, goodVote(), true)
    expect(g.granted).toBe(true)
    expect(g.demoted).toBe(false)
    expect(state.mismatchStreak).toBe(0)
  })
})

// ── Provisional grant reset (finding 1) ──────────────────────

describe('ungrantSelfVote', () => {
  it('un-grants a granted label so a LATER window can re-fire', () => {
    const state = createSelfVoteState()
    // Grant it.
    recordSelfVote(state, goodVote(), false)
    expect(recordSelfVote(state, goodVote(), false).granted).toBe(true)
    expect(state.granted).toBe(true)

    // A failed server POST resets the provisional grant.
    ungrantSelfVote(state)
    expect(state.granted).toBe(false)
    // The window is cleared so a fresh 2-of-3 must re-accrue (no stale
    // qualifiers instantly re-grant on the next single vote).
    expect(state.window.length).toBe(0)

    // One more good vote alone must NOT re-grant (window was cleared).
    expect(recordSelfVote(state, goodVote(), false).granted).toBe(false)
    // A second qualifying vote re-fires the grant transition.
    expect(recordSelfVote(state, goodVote(), false).granted).toBe(true)
    expect(state.granted).toBe(true)
  })

  it('is a no-op-safe reset on a never-granted state', () => {
    const state = createSelfVoteState()
    recordSelfVote(state, goodVote(), false)
    ungrantSelfVote(state)
    expect(state.granted).toBe(false)
    expect(state.window.length).toBe(0)
  })
})

describe('SELF_DEFAULT_LABEL', () => {
  it('matches the default "You" speaker label', () => {
    expect(SELF_DEFAULT_LABEL).toBe('local_1')
  })
})

describe('recordSelfVote — "Is this you?" (followups issue 11)', () => {
  const close = (selfSim = 0.74, bestContactSim = 0.5): SelfVote => ({ selfSim, bestContactSim })

  it('suggests once after 2 close votes that did not qualify for a grant', () => {
    const state = createSelfVoteState()
    expect(recordSelfVote(state, close(), false).suggested).toBe(false)
    expect(recordSelfVote(state, close(0.76), false)).toEqual({ granted: false, demoted: false, suggested: true })
    expect(recordSelfVote(state, close(0.77), false).suggested).toBe(false) // latched
    expect(state.suggested).toBe(true)
  })

  it('a vote closer to a contact, or under the suggestion bar, is not close', () => {
    expect(selfVoteIsClose({ selfSim: 0.75, bestContactSim: 0.76 })).toBe(false)
    expect(selfVoteIsClose({ selfSim: 0.75, bestContactSim: 0.75 })).toBe(false)
    expect(selfVoteIsClose({ selfSim: SELF_SUGGEST_THRESHOLD - 0.001, bestContactSim: 0 })).toBe(false)
    expect(selfVoteIsClose({ selfSim: SELF_SUGGEST_THRESHOLD, bestContactSim: 0 })).toBe(true)
    const state = createSelfVoteState()
    recordSelfVote(state, { selfSim: 0.75, bestContactSim: 0.8 }, false)
    expect(recordSelfVote(state, { selfSim: 0.75, bestContactSim: 0.8 }, false).suggested).toBe(false)
  })

  it('a granted label is never suggested', () => {
    const state = createSelfVoteState()
    recordSelfVote(state, goodVote(), false)
    const second = recordSelfVote(state, goodVote(), false)
    expect(second).toEqual({ granted: true, demoted: false, suggested: false })
    expect(recordSelfVote(state, close(), false).suggested).toBe(false)
  })
})
