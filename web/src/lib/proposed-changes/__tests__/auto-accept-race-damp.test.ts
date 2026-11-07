import { describe, it, expect } from 'vitest'
import {
  shouldRefuseAutoAccept,
  appendAppliedToPool,
  RACE_WINDOW_MS,
  type RaceCandidateAction,
  type RaceDampProposal,
} from '../auto-accept-race-damp'

/**
 * Race-damp tests (loop-closure E3).
 *
 * The load-bearing property: this withholds auto-accept ONLY on a strong,
 * recent, unambiguous duplicate — and must NEVER refuse the GEN-137 distinct-
 * task cases that a fuzzy matcher folds ("Add API logging" vs "Add BFF logging").
 * A false refusal is recoverable (the item stays a pending card) but still
 * annoying, so the bar is deliberately high.
 */

const NOW = Date.parse('2026-07-03T12:00:00Z')
const RECENT = new Date(NOW - 10 * 60 * 1000).toISOString() // 10 min ago
const OLD = new Date(NOW - RACE_WINDOW_MS - 60 * 60 * 1000).toISOString() // 7h ago

function proposal(title: string, displayText?: string): RaceDampProposal {
  return {
    change_type: 'create',
    entity_type: 'action',
    title,
    display_text: displayText ?? title,
  }
}

function action(
  id: string,
  title: string,
  overrides: Partial<RaceCandidateAction> = {},
): RaceCandidateAction {
  return {
    id,
    title,
    identifier: overrides.identifier ?? null,
    created_at: overrides.created_at ?? RECENT,
    status_category: overrides.status_category ?? 'unstarted',
  }
}

describe('shouldRefuseAutoAccept', () => {
  it('refuses a create:action that exactly re-titles a just-created action', () => {
    const d = shouldRefuseAutoAccept(
      proposal('Send the recap email to the APIM team'),
      [action('a1', 'Send the recap email to the APIM team')],
      NOW,
    )
    expect(d.refuse).toBe(true)
    expect(d.matched_action_id).toBe('a1')
  })

  it('does NOT refuse when the only match is OLD (recurring work, not the race)', () => {
    const d = shouldRefuseAutoAccept(
      proposal('Send the weekly status update'),
      [action('a1', 'Send the weekly status update', { created_at: OLD })],
      NOW,
    )
    expect(d.refuse).toBe(false)
  })

  it('does NOT refuse the GEN-137 one-load-bearing-word cases (distinct tasks)', () => {
    // These score high on token overlap (0.75-0.80) — the exact fold GEN-137's
    // silent drop produced. The strong-match gate must keep them auto-applying.
    const cases: Array<[string, string]> = [
      ['Add API logging to the gateway', 'Add BFF logging to the gateway'],
      ['Set up the staging database', 'Set up the production database'],
      ['Fix the login bug in checkout', 'Fix the logout bug in checkout'],
    ]
    for (const [proposedTitle, existingTitle] of cases) {
      const d = shouldRefuseAutoAccept(
        proposal(proposedTitle),
        [action('a1', existingTitle)],
        NOW,
      )
      expect(d.refuse, `${proposedTitle} vs ${existingTitle}`).toBe(false)
    }
  })

  it('does NOT refuse a NEW follow-up that merely references an existing action’s identifier', () => {
    // "write tests for GEN-42" is distinct work from the action GEN-42 itself.
    // The identifier tier used to (wrongly) refuse this — exact-title-only fixes it.
    const d = shouldRefuseAutoAccept(
      proposal('Write regression tests for GEN-42'),
      [action('a1', 'Refactor the auth module', { identifier: 'GEN-42' })],
      NOW,
    )
    expect(d.refuse).toBe(false)
  })

  it('does NOT refuse a scoped/combined variant that merely NESTS a recent title', () => {
    // A broad task + a scoped variant are DISTINCT work. Containment used to
    // (wrongly) refuse these — exact-title-only fixes it.
    const cases: Array<[string, string]> = [
      ['Update the onboarding checklist and record the loom walkthrough', 'Update the onboarding checklist'],
      ['Review the capture-stop pull request before Friday', 'Review the capture-stop pull request'],
      ['Deploy to staging and run smoke tests', 'Deploy to staging'],
    ]
    for (const [proposedTitle, existingTitle] of cases) {
      const d = shouldRefuseAutoAccept(proposal(proposedTitle), [action('a1', existingTitle)], NOW)
      expect(d.refuse, `${proposedTitle} vs ${existingTitle}`).toBe(false)
    }
  })

  it('refuses only on EXACT normalized title (punctuation/case-insensitive)', () => {
    // Same title differing only in case/punctuation IS the same action.
    const d = shouldRefuseAutoAccept(
      proposal('Review the Capture-Stop pull request!'),
      [action('a1', 'review the capture stop pull request')],
      NOW,
    )
    expect(d.refuse).toBe(true)
  })

  it('does NOT refuse when the recent match is completed/canceled', () => {
    const d = shouldRefuseAutoAccept(
      proposal('Ship the v2 API schema'),
      [action('a1', 'Ship the v2 API schema', { status_category: 'completed' })],
      NOW,
    )
    expect(d.refuse).toBe(false)
  })

  it('does NOT refuse non-create or non-action proposals', () => {
    const update = { change_type: 'update', entity_type: 'action', title: 'x', display_text: 'x' }
    const decision = { change_type: 'create', entity_type: 'decision', title: 'x', display_text: 'x' }
    expect(shouldRefuseAutoAccept(update, [action('a1', 'x')], NOW).refuse).toBe(false)
    expect(shouldRefuseAutoAccept(decision, [action('a1', 'x')], NOW).refuse).toBe(false)
  })

  it('does NOT refuse when the candidate pool is empty', () => {
    expect(shouldRefuseAutoAccept(proposal('anything at all here'), [], NOW).refuse).toBe(false)
  })

  it('refuses when MULTIPLE recent actions already share the title (clearly a dup)', () => {
    // Exact-title-only has no ambiguity problem: two identical recent actions +
    // an identical proposal is unambiguously a duplicate → withhold auto-accept.
    const d = shouldRefuseAutoAccept(
      proposal('Update the onboarding docs'),
      [
        action('a1', 'Update the onboarding docs'),
        action('a2', 'Update the onboarding docs'),
      ],
      NOW,
    )
    expect(d.refuse).toBe(true)
  })

  it('real PROD sequence: refuses the 20s-apart race copy, allows the recurring >6h copies', () => {
    // From PROD (2026-06-20+): "Ship the guided onboarding tour to dev" was
    // created 8× — twice 20s apart (the overlapping-capture race) and the rest
    // spread hours/days apart (recurring standup work). The damp must refuse the
    // race copy and leave the recurring copies to auto-apply (Triage dedupes
    // those cross-capture). We replay the real timestamps.
    const title = 'Ship the guided onboarding tour to dev'
    const t0 = Date.parse('2026-06-20T13:58:20Z') // first copy
    // Second copy staged 20s later — first copy is a recent exact-title dup.
    const at20s = shouldRefuseAutoAccept(
      proposal(title),
      [action('first', title, { created_at: new Date(t0).toISOString() })],
      t0 + 20 * 1000,
    )
    expect(at20s.refuse).toBe(true)
    // A copy staged ~7h after the last one — outside the window → auto-applies.
    const laterCopyTime = t0 + 7 * 60 * 60 * 1000 + 60 * 1000
    const at7h = shouldRefuseAutoAccept(
      proposal(title),
      [action('prev', title, { created_at: new Date(laterCopyTime - 7 * 60 * 60 * 1000 - 60 * 1000).toISOString() })],
      laterCopyTime,
    )
    expect(at7h.refuse).toBe(false)
  })

  it('boundary: a match exactly at the window edge still counts as recent', () => {
    const edge = new Date(NOW - RACE_WINDOW_MS + 1000).toISOString()
    const d = shouldRefuseAutoAccept(
      proposal('Draft the incident postmortem'),
      [action('a1', 'Draft the incident postmortem', { created_at: edge })],
      NOW,
    )
    expect(d.refuse).toBe(true)
  })

  it('within-batch: appendAppliedToPool makes a same-batch identical proposal refuse', () => {
    // The DB pool starts empty. First proposal auto-applies → we feed the created
    // action back in. A second identical proposal in the SAME batch is now caught.
    const pool: RaceCandidateAction[] = []
    const title = 'Send the recap to the design team'
    // Proposal #1: nothing recent → not refused → applied → fed back in.
    expect(shouldRefuseAutoAccept(proposal(title), pool, NOW).refuse).toBe(false)
    appendAppliedToPool(pool, { entityId: 'act-1', title }, NOW)
    // Proposal #2 (same batch, same title): now refused.
    const d2 = shouldRefuseAutoAccept(proposal(title), pool, NOW)
    expect(d2.refuse).toBe(true)
    expect(d2.matched_action_id).toBe('act-1')
  })

  it('does NOT refuse a FUTURE-dated candidate (one-directional window, no clock-skew leak)', () => {
    const future = new Date(NOW + 5 * 60 * 60 * 1000).toISOString() // 5h ahead
    const d = shouldRefuseAutoAccept(
      proposal('Draft the incident postmortem'),
      [action('a1', 'Draft the incident postmortem', { created_at: future })],
      NOW,
    )
    expect(d.refuse).toBe(false)
  })
})
