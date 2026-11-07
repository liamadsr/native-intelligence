/**
 * Unit coverage for the wizard's pure step-resume logic — the seam that decides
 * where a reloading/returning member lands from their durable onboarding state
 * alone. The reattach-mid-research path (reload during setup → back on
 * 'working') is the load-bearing behavior here, so it's pinned explicitly.
 *
 * These are pure functions, so no jsdom/render harness is needed — importing the
 * wizard module is cheap (its React/next imports don't execute at import time).
 */
import { describe, it, expect } from 'vitest'
import {
  resumeStepIndex,
  isTerminalResearch,
  COMPLETE_INDEX,
} from '../onboarding-wizard'
import type { DurableResearch } from '../onboarding-wizard'

// STEPS = ['source','meetings','prime','permissions','working'] → indices 0-4.
// PERMISSIONS sits between prime and working (research kicks off at prime and
// runs in the background while the user grants) and is desktop-shell-only:
// resume visits it only when the runtime `desktop` parameter is true (web
// members never accumulate its flag, so it must never gate them). CAPTURE was
// cut from the flow (desktop is the only advertised capture route); a durable
// `capture` flag from the old flow must be ignored by resume. There is no
// READY step; a member whose work is already done resolves to COMPLETE_INDEX
// (past the last step), which the wizard shell reads as "stamp completion +
// go to dashboard".
const SOURCE = 0
const MEETINGS = 1
const PRIME = 2
const PERMISSIONS = 3
const WORKING = 4

type Progress = Record<string, boolean> & { research?: DurableResearch }

// The real progress type is `Record<string, boolean> & { research? }`, an
// intersection an object literal can't be cast to directly — go through unknown
// once here so the fixtures stay literal and readable.
function progress(p: {
  permissions?: boolean
  source?: boolean
  meetings?: boolean
  capture?: boolean
  prime?: boolean
  research?: DurableResearch
}): Progress {
  return p as unknown as Progress
}

describe('isTerminalResearch', () => {
  it('treats done/skipped/error as terminal', () => {
    expect(isTerminalResearch('done')).toBe(true)
    expect(isTerminalResearch('skipped')).toBe(true)
    expect(isTerminalResearch('error')).toBe(true)
  })

  it('treats starting/running/undefined as in-flight', () => {
    expect(isTerminalResearch('starting')).toBe(false)
    expect(isTerminalResearch('running')).toBe(false)
    expect(isTerminalResearch(undefined)).toBe(false)
  })
})

describe('resumeStepIndex', () => {
  it('lands a fresh member on the first question step', () => {
    expect(resumeStepIndex(progress({}))).toBe(SOURCE)
    // A research blob without prime should still gate on the questionnaire.
    expect(resumeStepIndex(progress({ research: { status: 'running' } }))).toBe(
      SOURCE,
    )
  })

  it('resumes at the first unanswered question step', () => {
    expect(resumeStepIndex(progress({ source: true }))).toBe(MEETINGS)
    expect(resumeStepIndex(progress({ source: true, meetings: true }))).toBe(
      PRIME,
    )
  })

  it('ignores a persisted capture flag from the retired capture step', () => {
    // Members who answered the old capture question carry `capture: true`
    // durably — resume must neither crash on it nor try to visit the step.
    expect(
      resumeStepIndex(progress({ source: true, meetings: true, capture: true })),
    ).toBe(PRIME)
    expect(resumeStepIndex(progress({ capture: true }))).toBe(SOURCE)
  })

  it('never resumes backwards into the questionnaire once primed', () => {
    // Members who primed before the question steps existed have no question
    // flags at all — prime:true must still short-circuit past them.
    expect(
      resumeStepIndex(progress({ prime: true, research: { status: 'running' } })),
    ).toBe(WORKING)
    expect(resumeStepIndex(progress({ prime: true }))).toBe(COMPLETE_INDEX)
  })

  it('reattaches on working when primed and research is still in flight', () => {
    for (const status of ['starting', 'running', undefined] as const) {
      expect(
        resumeStepIndex(progress({ prime: true, research: { status } })),
      ).toBe(WORKING)
    }
  })

  it('resolves to COMPLETE_INDEX when primed and research is terminal', () => {
    for (const status of ['done', 'skipped', 'error'] as const) {
      expect(
        resumeStepIndex(progress({ prime: true, research: { status } })),
      ).toBe(COMPLETE_INDEX)
    }
  })

  it('resolves to COMPLETE_INDEX when primed with no research blob at all', () => {
    // A run that never started (kickoff swallowed) must not trap the user on a
    // working screen forever — with no in-flight research, we complete and go to
    // the dashboard.
    expect(resumeStepIndex(progress({ prime: true }))).toBe(COMPLETE_INDEX)
  })

  it('COMPLETE_INDEX is past the last real step (the wizard has no READY step)', () => {
    // A persisted legacy 'ready' (from before Arrival) is a terminal-ish state:
    // it must resolve to advance/complete, never index a nonexistent step. Any
    // terminal research → COMPLETE_INDEX, which is out of STEPS' bounds by design.
    expect(COMPLETE_INDEX).toBe(5)
    expect(resumeStepIndex(progress({ prime: true, research: { status: 'done' } }))).toBe(
      COMPLETE_INDEX,
    )
  })

  describe('permissions step (desktop runtime only, between prime and working)', () => {
    it('keeps the questionnaire first — a fresh desktop member starts on source', () => {
      expect(resumeStepIndex(progress({}), true)).toBe(SOURCE)
      expect(resumeStepIndex(progress({ source: true, meetings: true }), true)).toBe(
        PRIME,
      )
    })

    it('gates a primed desktop member on permissions before working', () => {
      // Research in flight keeps streaming in the background while the cards
      // are up — resume still lands on permissions, not working.
      expect(
        resumeStepIndex(progress({ prime: true, research: { status: 'running' } }), true),
      ).toBe(PERMISSIONS)
    })

    it('gates a primed desktop member on permissions even when research is already terminal', () => {
      // The gate is the step's whole point; WORKING auto-advances on its
      // already-terminal status right after Continue.
      for (const status of ['done', 'skipped', 'error'] as const) {
        expect(
          resumeStepIndex(progress({ prime: true, research: { status } }), true),
        ).toBe(PERMISSIONS)
      }
      expect(resumeStepIndex(progress({ prime: true }), true)).toBe(PERMISSIONS)
    })

    it('resumes past permissions once handled', () => {
      expect(
        resumeStepIndex(
          progress({ prime: true, permissions: true, research: { status: 'running' } }),
          true,
        ),
      ).toBe(WORKING)
      expect(
        resumeStepIndex(
          progress({ prime: true, permissions: true, research: { status: 'done' } }),
          true,
        ),
      ).toBe(COMPLETE_INDEX)
    })

    it('never visits permissions on web, even with no flag persisted', () => {
      // Web members cannot grant desktop permissions, so the absent flag must
      // not strand them — desktop=false (and the default) skips the step.
      expect(resumeStepIndex(progress({}), false)).toBe(SOURCE)
      expect(
        resumeStepIndex(progress({ prime: true, research: { status: 'running' } }), false),
      ).toBe(WORKING)
      expect(resumeStepIndex(progress({ prime: true }))).toBe(COMPLETE_INDEX)
    })
  })
})
