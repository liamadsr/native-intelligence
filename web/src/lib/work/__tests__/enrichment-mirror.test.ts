/**
 * CRM enrichment → the work ledger (Sequence row 11, plan §1.1): a row per
 * request (an Enrich click, a yes to the chat's enrich_contact), owned by the
 * person who asked and settled by the handler with the run's own outcome.
 * Enrichment no longer runs on its own, so there is no sweep row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
import { resetAgentRunMirrorCaches } from '../agent-run-mirror'
import { openManualEnrichment, settleManualEnrichment, stepManualEnrichment } from '../enrichment-mirror'

const W = '11111111-1111-4111-8111-000000000001'
const C1 = '22222222-2222-4222-8222-000000000001'

function seeded() {
  const fake = makeFakeSupabase({ unique: { tracked_job: ['kind,run_key'] } })
  fake.seed('member', [
    { id: 'm-clicker', workspace_id: W, user_id: 'u-clicker' },
  ])
  return fake
}
const jobs = (fake: ReturnType<typeof seeded>) => fake.rows('tracked_job')

beforeEach(() => {
  resetAgentRunMirrorCaches()
  hoisted.createNotification.mockClear()
})

describe('a manual Enrich', () => {
  async function clicked(fake: ReturnType<typeof seeded>) {
    const key = await openManualEnrichment(fake as never, { workspaceId: W, userId: 'u-clicker', table: 'contact', recordId: C1, name: 'Dana Lee' })
    expect(key).toMatch(/^manual:contact:/)
    return key!
  }

  it('is queued for the clicker, and running once the handler picks it up', async () => {
    const fake = seeded()
    const key = await clicked(fake)
    expect(jobs(fake)[0]).toMatchObject({
      kind: 'crm_enrichment',
      status: 'queued',
      member_id: 'm-clicker',
      title: 'Enriching Dana Lee',
      source: { table: 'contact', record_id: C1, entity_type: 'contact', entity_id: C1 },
    })
    await stepManualEnrichment(fake as never, key)
    expect(jobs(fake)[0]).toMatchObject({ status: 'running', current_step: 'Searching the web' })
  })

  it('settles with the run: enriched is done with a touch, skipped is skipped, failed is failed without a push', async () => {
    const fake = seeded()
    const done = await clicked(fake)
    await settleManualEnrichment(fake as never, done, { status: 'enriched', applied: [{}, {}] }, { workspaceId: W, table: 'contact', recordId: C1 })
    expect(jobs(fake)[0]).toMatchObject({ status: 'done', result_summary: 'Filled 2 fields' })
    expect(fake.rows('work_touch')).toEqual([expect.objectContaining({ entity_type: 'contact', entity_id: C1, verb: 'wrote' })])

    const skipped = await clicked(fake)
    await settleManualEnrichment(fake as never, skipped, { status: 'skipped', reason: 'insufficient_identity_signal' }, { workspaceId: W, table: 'contact', recordId: C1 })
    expect(jobs(fake).find((j) => j.run_key === skipped)).toMatchObject({ status: 'skipped', skip_reason: 'Insufficient identity signal' })

    const failed = await clicked(fake)
    await settleManualEnrichment(fake as never, failed, { status: 'failed', error: 'Exa 502' }, { workspaceId: W, table: 'contact', recordId: C1 })
    expect(jobs(fake).find((j) => j.run_key === failed)).toMatchObject({ status: 'failed', error_message: 'Exa 502' })
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('an event with no run key (Prospecting establishing a company) touches no ledger row', async () => {
    const fake = seeded()
    await stepManualEnrichment(fake as never, undefined)
    await settleManualEnrichment(fake as never, null, { status: 'enriched' }, { workspaceId: W, table: 'contact', recordId: C1 })
    expect(jobs(fake)).toHaveLength(0)
    expect(fake.rows('work_touch')).toHaveLength(0)
  })
})
