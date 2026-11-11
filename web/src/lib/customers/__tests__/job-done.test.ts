/**
 * A booked job done (roadmap B → track D's review requests): marking a quote
 * done finds its confirmed booking and sends D's `job/completed` for it, in
 * D's payload shape; no booking, or no customer contact, sends nothing.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { JOB_COMPLETED_EVENT, bookingJobDone, emitBookingJobDone } from '../job-done'

const WS = 'ws-rug'
const Q = 'q-1'
// Customer bookings are meeting_booking rows (source customer) since migration 581.
const db = (bookings: Record<string, unknown>[]) => memoryDb({ meeting_booking: bookings.map((b) => ({ source: 'customer', ...b })) })

describe('bookingJobDone', () => {
  it("names the quote's confirmed booking and its customer", async () => {
    const found = await bookingJobDone(db([
      { id: 'b-old', workspace_id: WS, quote_id: Q, state: 'declined', contact_id: 'c-1', starts_at: '2026-11-01T15:00:00Z' },
      { id: 'b-1', workspace_id: WS, quote_id: Q, state: 'confirmed', contact_id: 'c-1', starts_at: '2026-11-02T15:00:00Z' },
      { id: 'b-other', workspace_id: 'ws-other', quote_id: Q, state: 'confirmed', contact_id: 'c-9', starts_at: '2026-11-03T15:00:00Z' },
    ]), { workspaceId: WS, quoteId: Q, contactId: null, userId: 'user-owner', now: Date.parse('2026-11-05T12:00:00Z') })
    expect(found).toEqual({ workspaceId: WS, contactId: 'c-1', bookingId: 'b-1', completedAt: '2026-11-05T12:00:00.000Z', userId: 'user-owner' })
  })

  it('no confirmed booking, or no customer contact: nothing', async () => {
    expect(await bookingJobDone(db([{ id: 'b-1', workspace_id: WS, quote_id: Q, state: 'requested', contact_id: 'c-1' }]), { workspaceId: WS, quoteId: Q, contactId: 'c-1', userId: null })).toBeNull()
    expect(await bookingJobDone(db([{ id: 'b-1', workspace_id: WS, quote_id: Q, state: 'confirmed', contact_id: null }]), { workspaceId: WS, quoteId: Q, contactId: null, userId: null })).toBeNull()
  })
})

describe('emitBookingJobDone', () => {
  it("sends track D's job/completed, job type booking, and never throws", async () => {
    const send = vi.fn(async () => ({}))
    expect(await emitBookingJobDone({ workspaceId: WS, contactId: 'c-1', bookingId: 'b-1', completedAt: '2026-11-05T12:00:00.000Z', userId: 'u' }, { send })).toBe(true)
    expect(send).toHaveBeenCalledWith({ name: JOB_COMPLETED_EVENT, data: { workspaceId: WS, contactId: 'c-1', jobRef: { type: 'booking', id: 'b-1' }, reason: 'done', completedAt: '2026-11-05T12:00:00.000Z', userId: 'u' } })
    expect(JOB_COMPLETED_EVENT).toBe('job/completed')
    expect(await emitBookingJobDone({ workspaceId: WS, contactId: 'c-1', bookingId: 'b-1', completedAt: '', userId: null }, { send: async () => { throw new Error('down') } })).toBe(false)
  })
})
