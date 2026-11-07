/**
 * The job-done event (roadmap D3): one contract for every sender (the owner's
 * complete_job, bookings, track C's paid payment links), keyed per job and
 * customer, and pinned to migration 460's job types.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const hoisted = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))

const { JOB_TYPES, emitJobCompleted, jobRefOf } = await import('../events')

describe('the job-done event', () => {
  it('reads jobRef (and an early sender\'s job), refusing an unknown type or a missing id', () => {
    expect(jobRefOf({ jobRef: { type: 'payment_request', id: 'pr-1' } })).toEqual({ type: 'payment_request', id: 'pr-1' })
    expect(jobRefOf({ job: { type: 'booking', id: 'b-1' } })).toEqual({ type: 'booking', id: 'b-1' })
    for (const bad of [{}, { jobRef: { type: 'invoice', id: 'x' } }, { jobRef: { type: 'quote', id: '' } }, { jobRef: { type: 'quote', id: 'x'.repeat(201) } }, null]) {
      expect(jobRefOf(bad)).toBeNull()
    }
  })

  it('is keyed per job AND customer: two customers\' manual jobs on one day are two events', async () => {
    await emitJobCompleted({ workspaceId: 'ws-1', contactId: 'c-1', jobRef: { type: 'manual', id: '2026-11-04' }, completedAt: 'x' })
    await emitJobCompleted({ workspaceId: 'ws-1', contactId: 'c-2', jobRef: { type: 'manual', id: '2026-11-04' }, completedAt: 'x' })
    expect(hoisted.send.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual(['job-completed:manual:2026-11-04:c-1', 'job-completed:manual:2026-11-04:c-2'])
  })

  it('names exactly the job types migration 460 admits', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/460_outreach_sends.sql'), 'utf8')
    const check = /job_type\s+text NOT NULL CHECK \(job_type IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? ''
    expect([...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual([...JOB_TYPES].sort())
  })
})

describe("migration 460's interaction types", () => {
  it("keep 459's payment types (track C) beside review_request, so applying 460 after 459 drops none", () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/460_outreach_sends.sql'), 'utf8')
    const check = /CHECK \(interaction_type IN \(([^)]*)\)\)/.exec(sql)?.[1] ?? ''
    const types = [...check.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    for (const t of ['capture', 'email_sent', 'email_received', 'action_assigned', 'action_completed', 'note_added', 'payment_requested', 'payment_received', 'review_request']) {
      expect(types).toContain(t)
    }
  })
})
