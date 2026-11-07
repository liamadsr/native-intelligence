/**
 * Live self-verification vote machine — pure decision logic.
 *
 * Extracted from VoiceIdService (voice-id-service.ts) so the "is this speaker
 * ME?" decision is unit-testable without a Web Worker or audio pipeline. This
 * deliberately does NOT reuse the CRM contact machinery (evaluateVotes /
 * TIER_THRESHOLDS / getSessionCountBoost): those are tuned for contacts
 * accumulating trust across many meetings, and their session-count boost would
 * permanently penalise a deliberate one-shot enrollment (sessionCount ≤ 1 →
 * +0.04 forever). A scripted ~60s enrollment is HIGHER-confidence evidence than
 * meeting-derived samples, so the whole machine is: flat threshold + margin +
 * a small 2-of-3 sliding window.
 *
 * Two independent per-label signals:
 *   1. GRANT   — a label accrues 2 qualifying votes of its last 3 → this label
 *                is you. Latched: once granted it stays granted for the session.
 *   2. DEMOTE  — local_1 (the default "You") shows 3 CONSECUTIVE votes below the
 *                mismatch floor, OR some OTHER label was granted as you. Display-
 *                only; latched (v1 correction is re-train / remove in Settings).
 *
 * A vote QUALIFIES iff selfSim ≥ SELF_VERIFY_THRESHOLD and
 * selfSim − bestContactSim ≥ SELF_VERIFY_MARGIN. bestContactSim is the best
 * non-self contact candidate for that segment (0 when there is no contact
 * gallery, e.g. web) so the margin gate degrades to a plain threshold there.
 */

import {
  SELF_VERIFY_THRESHOLD,
  SELF_VERIFY_MARGIN,
  SELF_MISMATCH_THRESHOLD,
  SELF_SUGGEST_THRESHOLD,
} from './types'

/** Default "You" speaker label — the only label eligible for demotion. */
export const SELF_DEFAULT_LABEL = 'local_1'

/** Sliding window of recent votes considered for a grant. */
export const SELF_VOTE_WINDOW = 3
/** Qualifying votes needed within the window to grant a label. */
export const SELF_VOTE_MAJORITY = 2
/** Consecutive sub-floor votes on local_1 that trigger display demotion. */
export const SELF_MISMATCH_STREAK = 3

/** One self-similarity vote for a speaker label. */
export interface SelfVote {
  /** max cosine of this segment's embedding against the self prototypes. */
  selfSim: number
  /** Best NON-self contact candidate similarity (0 when no contact gallery). */
  bestContactSim: number
}

/** Per-label vote accounting. Mutated in place by recordSelfVote. */
export interface SelfVoteState {
  /** Recent votes, capped at SELF_VOTE_WINDOW (oldest dropped first). */
  window: SelfVote[]
  /** Consecutive sub-floor votes (only meaningful for the default label). */
  mismatchStreak: number
  /** Latched once this label qualified as self — never un-grants. */
  granted: boolean
  /** Latched once this label was suggested as self ("Is this you?"). */
  suggested: boolean
}

/** The outcome of feeding one vote into a label's state. */
export interface SelfVoteResult {
  /** True only on the transition into `granted` (fire the POST once). */
  granted: boolean
  /**
   * True only on the transition into demoted for the DEFAULT label — driven by
   * a sustained self-mismatch streak. A grant of a non-default label demotes
   * local_1 too, but that is applied by the caller (see markDefaultDemoted),
   * not returned here.
   */
  demoted: boolean
  /**
   * True only on the transition into `suggested`: the label is close to the
   * user's voice (SELF_VOTE_MAJORITY of the window at SELF_SUGGEST_THRESHOLD
   * or above, each beating every contact) but has not qualified for a grant.
   * The caller asks "Is this you?" (followups issue 11).
   */
  suggested: boolean
}

/** Fresh per-label state. */
export function createSelfVoteState(): SelfVoteState {
  return { window: [], mismatchStreak: 0, granted: false, suggested: false }
}

/** A vote is close to the user's voice: at the suggestion bar, and no contact is closer. */
export function selfVoteIsClose(vote: SelfVote): boolean {
  return vote.selfSim >= SELF_SUGGEST_THRESHOLD && vote.selfSim > vote.bestContactSim
}

/** A vote qualifies when it clears the threshold AND beats contacts by margin. */
export function selfVoteQualifies(vote: SelfVote): boolean {
  return (
    vote.selfSim >= SELF_VERIFY_THRESHOLD &&
    vote.selfSim - vote.bestContactSim >= SELF_VERIFY_MARGIN
  )
}

/**
 * Feed one vote into a label's state (mutates `state`) and report transitions.
 *
 * `isDefaultLabel` gates the demotion streak — only the default "You" label
 * (local_1) can be demoted, since only it carries a special-cased display name.
 */
export function recordSelfVote(
  state: SelfVoteState,
  vote: SelfVote,
  isDefaultLabel: boolean,
): SelfVoteResult {
  // Mismatch streak (default label only). A vote at/above the mismatch floor
  // resets the streak — demotion requires SUSTAINED mismatch, not a single dip.
  let demoted = false
  if (isDefaultLabel) {
    if (vote.selfSim < SELF_MISMATCH_THRESHOLD) {
      state.mismatchStreak++
      if (state.mismatchStreak >= SELF_MISMATCH_STREAK) {
        demoted = true
      }
    } else {
      state.mismatchStreak = 0
    }
  }

  // Slide the grant window.
  state.window.push(vote)
  if (state.window.length > SELF_VOTE_WINDOW) state.window.shift()

  let granted = false
  if (!state.granted) {
    const qualifying = state.window.filter(selfVoteQualifies).length
    if (qualifying >= SELF_VOTE_MAJORITY) {
      state.granted = true
      granted = true
    }
  }

  // Close but not granted → suggest, once per label.
  let suggested = false
  if (!state.granted && !state.suggested) {
    const close = state.window.filter(selfVoteIsClose).length
    if (close >= SELF_VOTE_MAJORITY) {
      state.suggested = true
      suggested = true
    }
  }

  return { granted, demoted, suggested }
}

/**
 * Un-grant a label's vote state so a LATER qualifying window can re-fire.
 *
 * The client grant is PROVISIONAL until the server confirms
 * (POST /self-binding re-verifies). If that POST fails transiently
 * (network/5xx) or is rejected (422), the caller resets so the binding isn't
 * permanently lost to one flaky request. Clearing the window (not just the
 * `granted` flag) forces a fresh 2-of-3 to re-accrue — the caller pairs this
 * with a cooldown so a persistently-failing server can't be spammed with POSTs.
 */
export function ungrantSelfVote(state: SelfVoteState): void {
  state.granted = false
  state.window = []
}
