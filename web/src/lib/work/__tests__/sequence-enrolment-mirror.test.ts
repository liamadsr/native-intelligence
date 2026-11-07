/**
 * sequence_enrollment → the work ledger (Sequence row 11, plan §1.1): one row
 * per enrolment, projected by the dispatcher's pass from the enrolment AS
 * STORED — so every exit site (a dozen of them, one in SQL) lands the same way
 * without calling the mirror itself.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
import { resetAgentRunMirrorCaches } from '../agent-run-mirror'
import {
  DEADLINE_SLACK_MS,
  enrolmentDeadlines,
  enrolmentLaunched,
  enrolmentSettle,
  enrolmentStepText,
  syncSequenceEnrolmentLedger,
  type EnrolmentRow,
} from '../sequence-enrolment-mirror'

const NOW = new Date('2026-09-28T12:00:00Z')
// uuid-shaped: the touch writer drops any id that is not.
const W = '11111111-1111-4111-8111-000000000001'
const C1 = '22222222-2222-4222-8222-000000000001'
const C2 = '22222222-2222-4222-8222-000000000002'
const C3 = '22222222-2222-4222-8222-000000000003'
const SEQ = { id: 'seq-1', name: 'Q3 outreach', created_by: 'u1', status: 'active', timezone: 'UTC' }

function enrolment(over: Partial<EnrolmentRow> & { updated_at?: string } = {}): EnrolmentRow & { updated_at: string } {
  return {
    id: 'en-1',
    workspace_id: W,
    sequence_id: 'seq-1',
    contact_id: C1,
    contact_email: 'dana@example.com',
    enrolled_by: 'u2',
    status: 'active',
    exit_reason: null,
    current_step_order: 0,
    next_send_at: '2026-09-29T15:00:00Z',
    sequence: SEQ,
    updated_at: '2026-09-28T11:55:00Z',
    ...over,
  }
}

function seeded(enrolments: Array<ReturnType<typeof enrolment>>, sends: Record<string, unknown>[] = []) {
  const fake = makeFakeSupabase({ unique: { tracked_job: ['kind,run_key'] } })
  fake.seed('member', [
    { id: 'm1', workspace_id: W, user_id: 'u1' },
    { id: 'm2', workspace_id: W, user_id: 'u2' },
  ])
  fake.seed('sequence_step', [1, 2, 3].map((n) => ({ id: `st-${n}`, sequence_id: 'seq-1', step_order: n, is_active: true })))
  fake.seed('sequence_step', [{ id: 'st-x', sequence_id: 'seq-1', step_order: 4, is_active: false }])
  fake.seed('sequence_enrollment', enrolments as unknown as Record<string, unknown>[])
  fake.seed('sequence_send', sends)
  return fake
}
const jobs = (fake: ReturnType<typeof seeded>) => fake.rows('tracked_job')
const touches = (fake: ReturnType<typeof seeded>) => fake.rows('work_touch')
const sent = (n: number, enrollmentId = 'en-1') =>
  Array.from({ length: n }, (_, i) => ({
    id: `s-${enrollmentId}-${i + 1}`,
    enrollment_id: enrollmentId,
    status: 'sent',
    error: null,
    updated_at: `2026-09-2${i + 1}T10:00:00Z`,
  }))

beforeEach(() => {
  resetAgentRunMirrorCaches()
  hoisted.createNotification.mockClear()
})

describe('the pure projection', () => {
  const facts = (s: number, total = 3) => ({ sent: s, total, lastError: null })

  it('says where the drip is, the next due date, and a paused sequence', () => {
    expect(enrolmentStepText(enrolment(), facts(0))).toBe('Step 1 of 3 due Sep 29')
    expect(enrolmentStepText(enrolment({ next_send_at: '2026-10-03T09:00:00Z' }), facts(2))).toBe('Sent 2 of 3 · next due Oct 3')
    expect(enrolmentStepText(enrolment({ next_send_at: null }), facts(2))).toBe('Sent 2 of 3')
    expect(enrolmentStepText(enrolment({ sequence: { ...SEQ, status: 'paused' } }), facts(1))).toBe(
      'Paused after 1 of 3 — the sequence is paused',
    )
  })

  it('settles each exit reason', () => {
    const exited = (reason: EnrolmentRow['exit_reason']) => enrolment({ status: 'exited', exit_reason: reason })
    expect(enrolmentSettle(exited('completed'), facts(3))).toEqual({ kind: 'finish', summary: 'Sent all 3 emails' })
    expect(enrolmentSettle(exited('replied'), facts(1))).toEqual({ kind: 'finish', summary: 'Replied after 1 email — the drip stopped' })
    expect(enrolmentSettle(exited('opted_out'), facts(2))).toEqual({ kind: 'finish', summary: 'Opted out after 2 emails' })
    expect(enrolmentSettle(exited('removed'), facts(0))).toEqual({ kind: 'cancel', reason: 'Removed from the sequence before the first email' })
    expect(enrolmentSettle(exited('failed'), { sent: 1, total: 3, lastError: 'Gmail 429' })).toEqual({
      kind: 'fail',
      message: 'Gmail 429',
      summary: 'Stopped after 1 email',
    })
  })

  it('a staged, never-launched enrolment is not a run', () => {
    expect(enrolmentLaunched(enrolment({ next_send_at: null }), facts(0))).toBe(false)
    expect(enrolmentLaunched(enrolment(), facts(0))).toBe(true)
    expect(enrolmentLaunched(enrolment({ status: 'exited', exit_reason: 'removed', next_send_at: null }), facts(0))).toBe(false)
  })

  it('a running row lives until its next send plus the slack', () => {
    expect(enrolmentDeadlines(enrolment({ next_send_at: '2026-09-29T12:00:00Z' }), NOW).running).toBe(24 * 3600_000 + DEADLINE_SLACK_MS)
    expect(enrolmentDeadlines(enrolment({ next_send_at: '2026-09-01T00:00:00Z' }), NOW).running).toBe(DEADLINE_SLACK_MS)
  })
})

describe('syncSequenceEnrolmentLedger', () => {
  it('opens one running row per launched enrolment, owned by the sequence creator; a staged one gets none', async () => {
    const fake = seeded([enrolment(), enrolment({ id: 'en-staged', contact_id: C2, next_send_at: null })])
    const out = await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(out).toMatchObject({ scanned: 2, started: 1, errored: 0 })
    expect(jobs(fake)).toHaveLength(1)
    expect(jobs(fake)[0]).toMatchObject({
      kind: 'sequence_enrolment',
      run_key: 'en-1',
      member_id: 'm1',
      status: 'running',
      title: 'Emailing dana@example.com · Q3 outreach',
      current_step: 'Step 1 of 3 due Sep 29',
      source: { sequence_id: 'seq-1', enrollment_id: 'en-1', entity_type: 'contact', entity_id: C1, quiet: true },
    })
    // The deadline follows the next send, not the 20-minute default.
    expect(new Date(jobs(fake)[0].deadline_at as string).getTime()).toBeGreaterThan(NOW.getTime() + DEADLINE_SLACK_MS - 60_000)
  })

  it('reads a bulk enrolment in bounded .in() chunks (no oversized GET URL)', async () => {
    const many = Array.from({ length: 150 }, (_, i) =>
      enrolment({ id: `en-${i}`, contact_email: `p${i}@example.com` }),
    )
    const fake = seeded(many)
    const inSizes: number[] = []
    const from = fake.from
    ;(fake as { from: typeof from }).from = (table: string) => {
      const b = from(table) as Record<string, unknown>
      const orig = b.in as (k: string, vs: unknown[]) => unknown
      b.in = (k: string, vs: unknown[]) => {
        inSizes.push(vs.length)
        return orig(k, vs)
      }
      return b
    }
    const out = await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(out).toMatchObject({ scanned: 150, started: 150, errored: 0 })
    expect(Math.max(...inSizes)).toBeLessThanOrEqual(100)
  })

  it('falls back to whoever enrolled the contact when the sequence has no creator', async () => {
    const fake = seeded([enrolment({ sequence: { ...SEQ, created_by: null } })])
    await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(jobs(fake)[0].member_id).toBe('m2')
  })

  it('steps a sent email once (with one touch on the contact), and a second pass writes nothing new', async () => {
    const fake = seeded([enrolment()])
    await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(touches(fake)).toHaveLength(0)

    fake.rows('sequence_enrollment')[0].current_step_order = 1
    fake.rows('sequence_enrollment')[0].next_send_at = '2026-10-02T15:00:00Z'
    fake.seed('sequence_send', sent(1))
    const second = await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(second.stepped).toBe(1)
    expect(jobs(fake)[0]).toMatchObject({ current_step: 'Sent 1 of 3 · next due Oct 2', progress: expect.objectContaining({ done: 1, total: 3 }) })
    expect(touches(fake)).toEqual([
      expect.objectContaining({ entity_type: 'contact', entity_id: C1, verb: 'wrote', tool_name: 'sequence_send', work_item_id: jobs(fake)[0].id }),
    ])

    const third = await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(third).toMatchObject({ stepped: 0, started: 0 })
    expect(touches(fake)).toHaveLength(1)
    expect(jobs(fake)).toHaveLength(1)
  })

  it('settles an exit as stored: completed is done, removed is canceled, a failed send is failed with its error and no push', async () => {
    const fake = seeded(
      [
        enrolment({ id: 'en-done', contact_id: C1, status: 'exited', exit_reason: 'completed', next_send_at: null, current_step_order: 3 }),
        enrolment({ id: 'en-rm', contact_id: C2, status: 'exited', exit_reason: 'removed', next_send_at: null, current_step_order: 1 }),
        enrolment({ id: 'en-fail', contact_id: C3, status: 'exited', exit_reason: 'failed', next_send_at: null, current_step_order: 1 }),
      ],
      [
        ...sent(3, 'en-done'),
        ...sent(1, 'en-rm'),
        ...sent(1, 'en-fail'),
        { id: 'sf', enrollment_id: 'en-fail', status: 'failed', error: 'Gmail rejected the send (550)', updated_at: '2026-09-27T10:00:00Z' },
      ],
    )
    const out = await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(out.settled).toBe(3)
    const byKey = Object.fromEntries(jobs(fake).map((j) => [j.run_key, j]))
    expect(byKey['en-done']).toMatchObject({ status: 'done', result_summary: 'Sent all 3 emails' })
    expect(byKey['en-rm']).toMatchObject({ status: 'canceled' })
    expect(byKey['en-fail']).toMatchObject({ status: 'failed', error_message: 'Gmail rejected the send (550)', result_summary: 'Stopped after 1 email' })
    // The engine already notified its failure (notifySequenceIssue); the ledger row is quiet.
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('the last email and the exit landing in one tick still leave a touch', async () => {
    const fake = seeded([enrolment({ current_step_order: 2, next_send_at: '2026-10-02T15:00:00Z' })], sent(2))
    await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(touches(fake)).toHaveLength(1)

    Object.assign(fake.rows('sequence_enrollment')[0], { status: 'exited', exit_reason: 'completed', next_send_at: null, current_step_order: 3 })
    fake.seed('sequence_send', [{ id: 's-last', enrollment_id: 'en-1', status: 'sent', error: null, updated_at: '2026-09-28T11:58:00Z' }])
    await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(jobs(fake)[0]).toMatchObject({ status: 'done', result_summary: 'Sent all 3 emails' })
    expect(touches(fake)).toHaveLength(2)
  })

  it('an exit with no new send records no touch', async () => {
    const fake = seeded([enrolment({ current_step_order: 1, next_send_at: '2026-10-02T15:00:00Z' })], sent(1))
    await syncSequenceEnrolmentLedger(fake as never, NOW)
    Object.assign(fake.rows('sequence_enrollment')[0], { status: 'exited', exit_reason: 'replied', next_send_at: null })
    await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(jobs(fake)[0]).toMatchObject({ status: 'done' })
    expect(touches(fake)).toHaveLength(1)
  })

  it('a staged enrolment removed before it launched leaves no row', async () => {
    const fake = seeded([enrolment({ status: 'exited', exit_reason: 'removed', next_send_at: null })])
    await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(jobs(fake)).toHaveLength(0)
  })

  it('never reopens a settled row', async () => {
    const fake = seeded([enrolment({ status: 'exited', exit_reason: 'completed', next_send_at: null })], sent(3))
    await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(jobs(fake)[0].status).toBe('done')
    Object.assign(fake.rows('sequence_enrollment')[0], { status: 'active', exit_reason: null, next_send_at: '2026-10-01T00:00:00Z' })
    await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(jobs(fake)).toHaveLength(1)
    expect(jobs(fake)[0].status).toBe('done')
  })

  it('re-arms a quiet row whose deadline is near, even when the enrolment was not written (a paused wait)', async () => {
    const fake = seeded([enrolment({ updated_at: '2026-09-01T00:00:00Z', next_send_at: '2026-09-30T15:00:00Z' })])
    // The row was opened long ago; its deadline is an hour out.
    fake.seed('tracked_job', [
      {
        id: 'job-old',
        kind: 'sequence_enrolment',
        run_key: 'en-1',
        workspace_id: W,
        member_id: 'm1',
        status: 'running',
        current_step: 'Step 1 of 3 due Sep 30',
        progress: { done: 0, total: 3 },
        source: { quiet: true },
        last_beat_at: '2026-09-20T00:00:00Z',
        deadline_at: new Date(NOW.getTime() + 3600_000).toISOString(),
        started_at: '2026-09-20T00:00:00Z',
        created_at: '2026-09-20T00:00:00Z',
      },
    ])
    const out = await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(out).toMatchObject({ scanned: 1, rearmed: 1, stepped: 0 })
    expect(new Date(jobs(fake)[0].deadline_at as string).getTime()).toBeGreaterThan(NOW.getTime() + DEADLINE_SLACK_MS - 60_000)
    expect(jobs(fake)[0].current_step).toBe('Step 1 of 3 due Sep 30')
  })

  it('an enrolment outside the window with no row near its deadline is not read', async () => {
    const fake = seeded([enrolment({ updated_at: '2026-09-01T00:00:00Z' })])
    const out = await syncSequenceEnrolmentLedger(fake as never, NOW)
    expect(out.scanned).toBe(0)
    expect(jobs(fake)).toHaveLength(0)
  })
})
