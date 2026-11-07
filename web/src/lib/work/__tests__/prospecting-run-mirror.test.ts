/**
 * prospecting_run → the work ledger (Sequence row 6, plan §1.1), against the
 * stateful fake: one row per run keyed by the run id, a progress write is a
 * live step, each terminal status lands as its ledger status, and a failure or
 * cancel that arrives after the run settled is refused like the run refused it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
// The recorder wakes the agent router (and the home turn) through Inngest: mocked,
// so no test sends a real event (src/test/setup.ts fails any that slip through).
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => ({ ids: [] })) } }))
import { resetAgentRunMirrorCaches } from '../agent-run-mirror'
import {
  createProspectingRunMirror,
  mirrorProspectingRunQueued,
  prospectingStep,
  prospectingSummary,
  prospectingTitle,
  settleProspectingWorkByRun,
} from '../prospecting-run-mirror'

const RUN = { id: 'pr-1', workspace_id: 'w1', list_id: 'list-1', kind: 'discover' as const, started_by: 'u1' }
const REF = { id: 'pr-1', workspaceId: 'w1', listId: 'list-1', kind: 'discover' as const }

function seeded() {
  const fake = makeFakeSupabase({ unique: { tracked_job: ['kind,run_key'] } })
  fake.seed('member', [
    { id: 'm1', workspace_id: 'w1', user_id: 'u1' },
    { id: 'm-creator', workspace_id: 'w1', user_id: 'u-creator' },
  ])
  fake.seed('prospect_list', [{ id: 'list-1', workspace_id: 'w1', name: 'Q3 ICP', created_by: 'u-creator' }])
  return fake
}
const row = (fake: ReturnType<typeof seeded>) => fake.rows('tracked_job')[0]

beforeEach(() => {
  resetAgentRunMirrorCaches()
  hoisted.createNotification.mockClear()
})

describe('mirrorProspectingRunQueued', () => {
  it('creates ONE queued prospecting row keyed by the run, owned by the starter, titled from the list', async () => {
    const fake = seeded()
    await mirrorProspectingRunQueued(fake as never, RUN)
    await mirrorProspectingRunQueued(fake as never, RUN) // idempotent on (kind, run_key)
    expect(fake.rows('tracked_job')).toHaveLength(1)
    expect(row(fake)).toMatchObject({
      kind: 'prospecting',
      status: 'queued',
      actor: 'agent',
      member_id: 'm1',
      run_key: 'pr-1',
      title: 'Finding companies for Q3 ICP',
      source: { prospecting_run_id: 'pr-1', list_id: 'list-1', run_kind: 'discover', entity_type: 'prospect_list', entity_id: 'list-1' },
    })
  })

  it('falls back to the list creator when the starter is gone, and is inert with no owner at all', async () => {
    const fake = seeded()
    await mirrorProspectingRunQueued(fake as never, { ...RUN, started_by: null })
    expect(row(fake).member_id).toBe('m-creator')

    const empty = makeFakeSupabase()
    const handle = await mirrorProspectingRunQueued(empty as never, { ...RUN, started_by: null })
    expect(handle.inert).toBe(true)
    expect(empty.rows('tracked_job')).toHaveLength(0)
  })
})

describe('createProspectingRunMirror (the engine’s deps.work)', () => {
  it('turns progress writes into live steps (queued → running)', async () => {
    const fake = seeded()
    await mirrorProspectingRunQueued(fake as never, RUN)
    const mirror = createProspectingRunMirror(fake as never, REF)
    await mirror.progress({ stage: 'discover', round: 2, max_rounds: 3, found: 40, new: 12 } as never)
    expect(row(fake).status).toBe('running')
    expect(row(fake).current_step).toBe('Round 2 of 3: 12 new of 40 found')
  })

  it.each([
    ['completed', null, 'done', 'Found 12 new companies'],
    ['budget_exhausted', 'run_cap', 'done', 'Stopped at the run budget — Found 12 new companies'],
    ['budget_exhausted', 'monthly_cap', 'skipped', null],
    ['canceled', null, 'canceled', null],
    ['failed', 'Exa is down', 'failed', null],
  ] as const)('settles %s (%s) as %s', async (status, error, ledger, summary) => {
    const fake = seeded()
    await mirrorProspectingRunQueued(fake as never, RUN)
    await createProspectingRunMirror(fake as never, REF).settle({ status, error, newEntries: 12, progress: {} })
    expect(row(fake).status).toBe(ledger)
    if (summary) expect(row(fake).result_summary).toBe(summary)
    if (ledger === 'done') {
      expect(row(fake).deliverables).toEqual([{ type: 'prospect_list', id: 'list-1', label: 'Q3 ICP' }])
    }
    if (ledger === 'skipped') expect(row(fake).skip_reason).toBe('Monthly prospecting budget reached')
    if (ledger === 'failed') expect(row(fake).error_message).toBe('Exa is down')
  })

  it('is a silent no-op for a run with no ledger row', async () => {
    const fake = seeded()
    const mirror = createProspectingRunMirror(fake as never, REF)
    await expect(mirror.progress({ round: 1 } as never)).resolves.toBeUndefined()
    await expect(mirror.settle({ status: 'completed' })).resolves.toBeUndefined()
    expect(fake.rows('tracked_job')).toHaveLength(0)
  })
})

describe('settleProspectingWorkByRun (writes outside the engine)', () => {
  it('cancels or fails an open row', async () => {
    const fake = seeded()
    await mirrorProspectingRunQueued(fake as never, RUN)
    await settleProspectingWorkByRun(fake as never, 'pr-1', { status: 'canceled' })
    expect(row(fake).status).toBe('canceled')
  })

  it('a failure that lands after the run settled is refused, as the run refused it', async () => {
    const fake = seeded()
    await mirrorProspectingRunQueued(fake as never, RUN)
    await createProspectingRunMirror(fake as never, REF).settle({ status: 'completed', newEntries: 3 })
    await settleProspectingWorkByRun(fake as never, 'pr-1', { status: 'failed', error: 'late onFailure' })
    expect(row(fake).status).toBe('done')
  })
})

describe('copy', () => {
  it('titles, steps and summaries per kind', () => {
    expect(prospectingTitle('account_card', 'Q3')).toBe('Researching accounts in Q3')
    expect(prospectingTitle('people', null)).toBe('Finding people in a prospect list')
    expect(prospectingStep('people', { accounts_done: 2, accounts_total: 5, people_found: 7 })?.text).toBe(
      'Finding people: 2 of 5 companies, 7 found',
    )
    expect(prospectingStep('account_card', { accounts_done: 0, accounts_total: 3 })?.text).toBe('Researching account 1 of 3')
    expect(prospectingStep('discover', { stage: 'score', found: 9 })?.text).toBe('Scoring 9 companies')
    expect(prospectingSummary('people', 1, {})).toBe('Found 1 person')
    expect(prospectingSummary('account_card', 0, { accounts_done: 1 })).toBe('Researched 1 company')
    expect(prospectingSummary('discover', 2, {})).toBe('Found 2 new companies')
  })
})
