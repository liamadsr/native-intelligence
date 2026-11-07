import { describe, it, expect } from 'vitest'
import {
  MAX_RECONCILES_PER_CAPTURE,
  RECONCILE_SETTLE_MS,
  captureReadiness,
  collectCandidateCaptureIds,
  exhaustedCaptureIds,
  extractDecidedProposalIds,
  selectEligibleCaptures,
  type PendingProposalRow,
} from '../triage-reconciler'

/**
 * Triage-reconciler eligibility tests (Phase 3, WS-4a). The convergence
 * guarantee lives here: a capture is fired only when it has a genuinely
 * un-triaged pending proposal — one NOT already decided in a verdict ledger and
 * NOT already holding a live card — and only while it is under the lifetime
 * reconcile cap, finished, settled, not private, and in a workspace that passes
 * the usage gate.
 * These are the exact re-fire loops the plan calls out as divergent.
 */

const p = (id: string, capture_id: string | null, workspace_id = 'w1'): PendingProposalRow => ({
  id,
  capture_id,
  workspace_id,
})

const eligibility = (over: Partial<Parameters<typeof selectEligibleCaptures>[0]> = {}) =>
  selectEligibleCaptures({
    pendingProposals: [],
    decidedProposalIds: new Set(),
    liveCardProposalIds: new Set(),
    exhaustedCaptureIds: new Set(),
    cap: 5,
    ...over,
  })

describe('selectEligibleCaptures', () => {
  it('includes a capture with a fresh, undecided, un-carded pending proposal', () => {
    const out = eligibility({ pendingProposals: [p('p-good', 'cap-good')] })
    expect(out).toEqual([{ workspace_id: 'w1', capture_id: 'cap-good' }])
  })

  it('EXCLUDES a capture whose only pending proposal was decided in a ledger', () => {
    const out = eligibility({
      pendingProposals: [p('p-decided', 'cap-decided')],
      decidedProposalIds: new Set(['p-decided']),
    })
    expect(out).toEqual([])
  })

  it('EXCLUDES a capture whose only pending proposal already holds a live card', () => {
    const out = eligibility({
      pendingProposals: [p('p-carded', 'cap-carded')],
      liveCardProposalIds: new Set(['p-carded']),
    })
    expect(out).toEqual([])
  })

  it('EXCLUDES a capture at the lifetime reconcile cap, even with a good proposal', () => {
    const out = eligibility({
      pendingProposals: [p('p-good', 'cap-done')],
      exhaustedCaptureIds: new Set(['cap-done']),
    })
    expect(out).toEqual([])
  })

  it('EXCLUDES a proposal with no capture (the PROD null-capture re-fire loop)', () => {
    const out = eligibility({ pendingProposals: [p('p-null', null), p('p-good', 'cap-good')] })
    expect(out).toEqual([{ workspace_id: 'w1', capture_id: 'cap-good' }])
  })

  it('EXCLUDES an unready capture (private / recording / settling)', () => {
    const out = eligibility({
      pendingProposals: [p('p1', 'cap-private'), p('p2', 'cap-good')],
      unreadyCaptureIds: new Set(['cap-private']),
    })
    expect(out).toEqual([{ workspace_id: 'w1', capture_id: 'cap-good' }])
  })

  it('EXCLUDES every capture of a workspace blocked by the usage gate', () => {
    const out = eligibility({
      pendingProposals: [p('p1', 'cap-1', 'w-unpaid'), p('p2', 'cap-2', 'w-paid')],
      blockedWorkspaceIds: new Set(['w-unpaid']),
    })
    expect(out).toEqual([{ workspace_id: 'w-paid', capture_id: 'cap-2' }])
  })

  it('skipped captures do not use up the per-tick cap', () => {
    const out = eligibility({
      pendingProposals: [p('p1', 'cap-done'), p('p2', 'cap-a'), p('p3', 'cap-b')],
      exhaustedCaptureIds: new Set(['cap-done']),
      cap: 1,
    })
    expect(out).toEqual([{ workspace_id: 'w1', capture_id: 'cap-a' }])
  })

  it('includes a capture that has a decided proposal AND an undecided one', () => {
    // The gate-miss branch leaves carded proposals pending; a capture must still
    // qualify on its OTHER genuinely-untriaged proposal.
    const out = eligibility({
      pendingProposals: [p('p-decided', 'cap-mixed'), p('p-good', 'cap-mixed')],
      decidedProposalIds: new Set(['p-decided']),
    })
    expect(out).toEqual([{ workspace_id: 'w1', capture_id: 'cap-mixed' }])
  })

  it('dedupes: two qualifying proposals on one capture yield one entry', () => {
    const out = eligibility({
      pendingProposals: [p('p1', 'cap-x'), p('p2', 'cap-x')],
    })
    expect(out).toEqual([{ workspace_id: 'w1', capture_id: 'cap-x' }])
  })

  it('caps the result and keeps input (oldest-first) order', () => {
    const out = eligibility({
      pendingProposals: [
        p('p1', 'cap-1'),
        p('p2', 'cap-2'),
        p('p3', 'cap-3'),
      ],
      cap: 2,
    })
    expect(out).toEqual([
      { workspace_id: 'w1', capture_id: 'cap-1' },
      { workspace_id: 'w1', capture_id: 'cap-2' },
    ])
  })

  it('carries each proposal\'s own workspace through', () => {
    const out = eligibility({
      pendingProposals: [p('p1', 'cap-1', 'wa'), p('p2', 'cap-2', 'wb')],
    })
    expect(out).toEqual([
      { workspace_id: 'wa', capture_id: 'cap-1' },
      { workspace_id: 'wb', capture_id: 'cap-2' },
    ])
  })
})

describe('extractDecidedProposalIds', () => {
  it('collects every proposal_id across all runs\' verdict ledgers', () => {
    const runs = [
      {
        action_results: [
          { verdict: { entries: [{ proposal_id: 'a' }, { proposal_id: 'b' }] } },
          { verdict: { entries: [{ proposal_id: 'c' }] } },
        ],
      },
      { action_results: [{ verdict: { entries: [{ proposal_id: 'd' }] } }] },
    ]
    expect(extractDecidedProposalIds(runs)).toEqual(new Set(['a', 'b', 'c', 'd']))
  })

  it('ignores runs with no verdict / non-array action_results / missing ids', () => {
    const runs = [
      { action_results: [{ condition_met: true }] }, // no verdict
      { action_results: 'not-an-array' }, // malformed jsonb
      { action_results: [{ verdict: { entries: [{}, { proposal_id: 42 }] } }] }, // non-string ids
      {}, // no action_results at all
      { action_results: [{ verdict: { entries: [{ proposal_id: 'real' }] } }] },
    ]
    expect(extractDecidedProposalIds(runs)).toEqual(new Set(['real']))
  })

  it('a needs_user item the run left to the user counts as judged (it is not a re-fire trigger)', () => {
    // The Sep 29 d6af9249 shape: the writer work proposal is only in
    // submitted.needs_user (no entry, no attempt: it overflowed the rail).
    const runs = [
      {
        action_results: [
          {
            verdict: {
              entries: [{ proposal_id: 'decided' }],
              submitted: {
                decisions: [{ proposal_id: 'decided', verdict: 'accept', reason: 'r' }],
                needs_user: [
                  { kind: 'work_proposal', proposal_id: 'left-to-user', title: 'Draft the plan', why: 'w' },
                  { kind: 'question', title: 'No proposal behind this one' },
                ],
                summary: 's',
              },
              cards_overflow: 3,
            },
          },
        ],
      },
    ]
    const decided = extractDecidedProposalIds(runs)
    expect(decided).toEqual(new Set(['decided', 'left-to-user']))
    expect(
      eligibility({ pendingProposals: [p('left-to-user', 'cap-1')], decidedProposalIds: decided }),
    ).toEqual([])
  })

  it('tolerates a malformed submitted block', () => {
    const runs = [
      { action_results: [{ verdict: { submitted: null } }] },
      { action_results: [{ verdict: { submitted: { needs_user: 'nope' } } }] },
      { action_results: [{ verdict: { submitted: { needs_user: [null, { proposal_id: 7 }, { proposal_id: '' }] } } }] },
      { action_results: [{ verdict: { submitted: { needs_user: [{ proposal_id: 'ok' }] } } }] },
    ]
    expect(extractDecidedProposalIds(runs)).toEqual(new Set(['ok']))
  })
})

describe('collectCandidateCaptureIds', () => {
  it('drops null captures, judged and carded proposals, and dedupes in order', () => {
    const out = collectCandidateCaptureIds({
      pendingProposals: [
        p('p-null', null),
        p('p-decided', 'cap-a'),
        p('p-carded', 'cap-b'),
        p('p1', 'cap-c', 'w2'),
        p('p2', 'cap-c', 'w2'),
        p('p3', 'cap-a'),
      ],
      decidedProposalIds: new Set(['p-decided']),
      liveCardProposalIds: new Set(['p-carded']),
    })
    expect(out).toEqual([
      { capture_id: 'cap-c', workspace_id: 'w2' },
      { capture_id: 'cap-a', workspace_id: 'w1' },
    ])
  })
})

describe('exhaustedCaptureIds', () => {
  it(`caps a capture at ${MAX_RECONCILES_PER_CAPTURE} reconciles, ever`, () => {
    expect(MAX_RECONCILES_PER_CAPTURE).toBe(2)
    const jobs = [
      { source: { capture_id: 'twice' } },
      { source: { capture_id: 'twice' } },
      { source: { capture_id: 'once' } },
      { source: { capture_id: null } }, // a pre-fix null-capture fire
      { source: null },
    ]
    expect(exhaustedCaptureIds(jobs)).toEqual(new Set(['twice']))
  })
})

describe('captureReadiness', () => {
  const NOW = Date.parse('2026-10-15T12:00:00Z')
  const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
  const row = (over: Partial<Parameters<typeof captureReadiness>[0] & object> = {}) => ({
    id: 'c',
    visibility: 'workspace',
    ended_at: at(60 * 60 * 1000),
    batch_processed_at: at(55 * 60 * 1000),
    ...over,
  })

  it('a finished, settled workspace capture is ready', () => {
    expect(captureReadiness(row(), NOW)).toBe('ready')
  })

  it('a private capture is never ready (the dispatcher skips it)', () => {
    expect(captureReadiness(row({ visibility: 'private' }), NOW)).toBe('private')
  })

  it('a capture still recording (no ended_at) is not ready', () => {
    expect(captureReadiness(row({ ended_at: null, batch_processed_at: null }), NOW)).toBe('recording')
  })

  it('a capture the abandoned sweep retired is never ready; any other server close is', () => {
    const finalized = (reason: string) => ({ metadata: { finalized: { by: 'server', reason, at: at(60 * 60 * 1000) } } })
    expect(captureReadiness(row({ batch_processed_at: null, ...finalized('stale') }), NOW)).toBe('retired')
    expect(captureReadiness(row({ batch_processed_at: null, ...finalized('recorder_quiet') }), NOW)).toBe('ready')
    expect(captureReadiness(row({ metadata: null }), NOW)).toBe('ready')
  })

  it('a capture that ended under 15 minutes ago is settling', () => {
    expect(captureReadiness(row({ ended_at: at(RECONCILE_SETTLE_MS - 1000), batch_processed_at: null }), NOW)).toBe(
      'settling',
    )
  })

  it('settles from the LATER of ended_at and batch_processed_at', () => {
    expect(
      captureReadiness(row({ ended_at: at(60 * 60 * 1000), batch_processed_at: at(5 * 60 * 1000) }), NOW),
    ).toBe('settling')
  })

  it('an ended capture whose batch never stamped is ready once settled (the heal)', () => {
    expect(captureReadiness(row({ ended_at: at(RECONCILE_SETTLE_MS + 1000), batch_processed_at: null }), NOW)).toBe(
      'ready',
    )
  })

  it('an eval capture is never ready (it never fires loops)', () => {
    expect(captureReadiness(row({ is_eval: true }), NOW)).toBe('eval')
    expect(captureReadiness(row({ is_eval: null }), NOW)).toBe('ready')
  })

  it('a missing capture row is never ready', () => {
    expect(captureReadiness(null, NOW)).toBe('missing')
  })
})
