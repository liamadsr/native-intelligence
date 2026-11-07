/**
 * Extraction's undo of ONE pass (bots v3 Phase 5, undo_extraction_pass): the
 * plan's test is "Undo touches only that pass's entries".
 *
 *  - only the APPLIED entries of THAT pass are un-applied (entity deleted,
 *    proposal back to pending); a staged entry, another pass's entries on the
 *    same capture, and anything outside the pass stay exactly as they were;
 *  - a proposal re-applied since (another entity), dismissed since, or an
 *    update (it changed something that already existed) is skipped, not undone;
 *  - owner-only: the pass's work item must be the caller's (else, with no work
 *    item, the capture must be theirs);
 *  - an entity the person worked on since (edited after applied_at, commented
 *    on, given a sub-action) is skipped, never deleted;
 *  - a second run undoes nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const deleted: string[] = []
vi.mock('@/lib/proposed-changes/apply-engine', () => ({
  deleteAppliedEntity: vi.fn(async (_sb: unknown, changeType: string, _et: string, id: string) => {
    if (changeType !== 'create') return { success: false, code: 'NOT_CREATED_BY_PROPOSAL', error: 'no' }
    deleted.push(id)
    return { success: true, entity_id: id }
  }),
}))

import { undoExtractionPass, appliedEntriesOf } from '../undo-extraction-pass'

const WS = 'a1000000-0000-4000-8000-000000000001'
const CAPTURE = 'c1000000-0000-4000-8000-000000000001'
const PASS_A = 'e1000000-0000-4000-8000-00000000000a'
const PASS_B = 'e1000000-0000-4000-8000-00000000000b'
const P1 = 'b1000000-0000-4000-8000-000000000001'
const P2 = 'b1000000-0000-4000-8000-000000000002'
const P3 = 'b1000000-0000-4000-8000-000000000003'
const P4 = 'b1000000-0000-4000-8000-000000000004'
const P5 = 'b1000000-0000-4000-8000-000000000005'
const P6 = 'b1000000-0000-4000-8000-000000000006'

let fake: FakeSupabase
const sb = () => fake as never

function seed() {
  fake.seed('member', [
    { id: 'mem-liam', workspace_id: WS, user_id: 'user-liam' },
    { id: 'mem-ana', workspace_id: WS, user_id: 'user-ana' },
  ])
  fake.seed('extraction_pass', [
    {
      id: PASS_A,
      workspace_id: WS,
      capture_id: CAPTURE,
      ledger: {
        entries: [
          { proposal_id: P1, decision: 'accept', outcome: 'applied', entity_id: 'act-1' },
          { proposal_id: P2, decision: 'accept', outcome: 'applied', entity_id: 'act-2' },
          { proposal_id: P3, decision: 'accept', outcome: 'carded' },
          { proposal_id: P5, decision: 'accept', outcome: 'applied', entity_id: 'act-5' },
          { proposal_id: P6, decision: 'accept', outcome: 'applied', entity_id: 'act-6' },
        ],
      },
    },
    {
      id: PASS_B,
      workspace_id: WS,
      capture_id: CAPTURE,
      ledger: { entries: [{ proposal_id: P4, decision: 'accept', outcome: 'applied', entity_id: 'act-4' }] },
    },
  ])
  fake.seed('tracked_job', [
    { id: 'job-a', workspace_id: WS, kind: 'extraction', member_id: 'mem-liam', source: { capture_id: CAPTURE, extraction_pass_id: PASS_A } },
    { id: 'job-b', workspace_id: WS, kind: 'extraction', member_id: 'mem-liam', source: { capture_id: CAPTURE, extraction_pass_id: PASS_B } },
  ])
  fake.seed('captures', [{ id: CAPTURE, workspace_id: WS, user_id: 'user-liam' }])
  const applied = (id: string, entity: string, extra: Record<string, unknown> = {}) => ({
    id,
    workspace_id: WS,
    capture_id: CAPTURE,
    status: 'applied',
    change_type: 'create',
    entity_type: 'action',
    result_entity_id: entity,
    auto_accepted: true,
    ...extra,
  })
  fake.seed('proposed_change', [
    applied(P1, 'act-1'),
    applied(P2, 'act-2-again'), // re-applied since: another entity
    { id: P3, workspace_id: WS, capture_id: CAPTURE, status: 'pending', change_type: 'create', entity_type: 'action' },
    applied(P4, 'act-4'), // pass B's
    { ...applied(P5, 'act-5'), status: 'dismissed' }, // dismissed since
    applied(P6, 'act-6', { change_type: 'update' }), // changed something that existed
  ])
}

const status = (id: string) => fake.rows('proposed_change').find((r) => r.id === id)?.status

beforeEach(() => {
  fake = makeFakeSupabase()
  deleted.length = 0
  seed()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('undoExtractionPass', () => {
  it('undoes only the applied entries of THAT pass, and only while they still name what it created', async () => {
    const out = await undoExtractionPass(sb(), 'user-liam', WS, PASS_A)
    expect(out.success).toBe(true)
    if (!out.success) return
    expect(out.undone).toBe(1)
    expect(deleted).toEqual(['act-1'])
    expect(status(P1)).toBe('pending')
    expect(fake.rows('proposed_change').find((r) => r.id === P1)?.result_entity_id).toBeNull()
    // Skipped, each with why.
    const why = Object.fromEntries(out.entries.map((e) => [e.proposal_id, e.why ?? e.outcome]))
    expect(why[P2]).toMatch(/applied again/)
    expect(why[P5]).toMatch(/dismissed/)
    expect(why[P6]).toMatch(/already existed/)
    // The staged entry is not an applied one: never read as one.
    expect(why[P3]).toBeUndefined()
    expect(status(P2)).toBe('applied')
    expect(status(P3)).toBe('pending')
    expect(status(P5)).toBe('dismissed')
    expect(status(P6)).toBe('applied')
    // Pass B's entry on the same capture is untouched.
    expect(status(P4)).toBe('applied')
    expect(deleted).not.toContain('act-4')
  })

  it('leaves alone what the person worked on since: an edit after the apply, a comment, a sub-action', async () => {
    const APPLIED = '2026-10-01T10:00:00.000Z'
    const row = fake.rows('proposed_change').find((r) => r.id === P1)!
    row.applied_at = APPLIED
    // Retitled and moved an hour later.
    fake.seed('actions', [{ id: 'act-1', workspace_id: WS, updated_at: '2026-10-01T11:00:00.000Z' }])
    let out = await undoExtractionPass(sb(), 'user-liam', WS, PASS_A)
    expect(out.success && out.undone).toBe(0)
    expect(out.success && out.entries.find((e) => e.proposal_id === P1)?.why).toMatch(/edited, moved or commented/)
    expect(deleted).toEqual([])
    expect(status(P1)).toBe('applied')

    // The apply's own follow-up write (within the slack) is not the person's.
    fake.rows('actions')[0].updated_at = '2026-10-01T10:00:20.000Z'
    fake.seed('comment', [{ id: 'cm-1', commentable_type: 'action', commentable_id: 'act-1' }])
    out = await undoExtractionPass(sb(), 'user-liam', WS, PASS_A)
    expect(out.success && out.undone).toBe(0)
    expect(deleted).toEqual([])

    fake.rows('comment').length = 0
    fake.seed('actions', [{ id: 'act-1-child', workspace_id: WS, parent_id: 'act-1', updated_at: APPLIED }])
    out = await undoExtractionPass(sb(), 'user-liam', WS, PASS_A)
    expect(out.success && out.undone).toBe(0)
    expect(deleted).toEqual([])

    // Untouched since: undone.
    fake.rows('actions').splice(1, 1)
    out = await undoExtractionPass(sb(), 'user-liam', WS, PASS_A)
    expect(out.success && out.undone).toBe(1)
    expect(deleted).toEqual(['act-1'])
  })

  it('a second run undoes nothing', async () => {
    await undoExtractionPass(sb(), 'user-liam', WS, PASS_A)
    deleted.length = 0
    const again = await undoExtractionPass(sb(), 'user-liam', WS, PASS_A)
    expect(again.success && again.undone).toBe(0)
    expect(deleted).toEqual([])
  })

  it('is owner-only: another member of the workspace is refused, and nothing changes', async () => {
    const out = await undoExtractionPass(sb(), 'user-ana', WS, PASS_A)
    expect(out).toMatchObject({ success: false, code: 'FORBIDDEN' })
    expect(deleted).toEqual([])
    expect(status(P1)).toBe('applied')
  })

  it('a pass with no work item is the capture owner’s', async () => {
    fake.rows('tracked_job').length = 0
    // The capture's owner is Liam; with no work item, Ana is refused and Liam may.
    fake.rows('captures')[0].user_id = 'user-liam'
    expect(await undoExtractionPass(sb(), 'user-ana', WS, PASS_A)).toMatchObject({ code: 'FORBIDDEN' })
    expect((await undoExtractionPass(sb(), 'user-liam', WS, PASS_A)).success).toBe(true)
  })

  it('a pass in another workspace, or no id at all, is not found', async () => {
    expect(await undoExtractionPass(sb(), 'user-liam', 'a1000000-0000-4000-8000-0000000000ff', PASS_A)).toMatchObject({ code: 'NOT_FOUND' })
    expect(await undoExtractionPass(sb(), 'user-liam', WS, 'not-a-uuid')).toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('appliedEntriesOf', () => {
  it('reads applied entries only, once each, and never a malformed one', () => {
    expect(
      appliedEntriesOf({
        entries: [
          { proposal_id: P1, outcome: 'applied', entity_id: 'a' },
          { proposal_id: P1, outcome: 'applied', entity_id: 'a' },
          { proposal_id: P2, outcome: 'carded' },
          { proposal_id: 'x', outcome: 'applied' },
          null,
          'nope',
        ],
      }),
    ).toEqual([{ proposal_id: P1, entity_id: 'a' }])
    expect(appliedEntriesOf(null)).toEqual([])
  })
})
