/**
 * notifySequenceIssue (src/lib/sequences/notify.ts): one grouped notification
 * per sequence per 24 h, and (docs/plans/retire-notifications-page.md phase 1)
 * one `sequence.failed` event for the agent, keyed on that notification, named
 * after the sequence. Nothing for the agent when the insert fails or the day's
 * notification is already out.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ recordNoticeEvent: vi.fn(async (..._args: unknown[]) => 1) }))
vi.mock('@/lib/agent-events/notice', () => ({ recordNoticeEvent: hoisted.recordNoticeEvent }))

const { notifySequenceIssue } = await import('../notify')

let db: FakeSupabase
const sequence = { id: 'seq-1', name: 'Q4 outreach', created_by: 'u1' }

beforeEach(() => {
  db = makeFakeSupabase()
  db.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1', role: 'member' }])
  hoisted.recordNoticeEvent.mockClear()
})

describe('notifySequenceIssue', () => {
  it('writes the notification and tells the agent, keyed on its id and named after the sequence', async () => {
    await notifySequenceIssue(db as never, sequence, 'w1', 'Sequence send failed', 'The mailbox refused it')
    const [row] = db.rows('notification')
    expect(row).toMatchObject({ recipient_id: 'm1', type: 'flow_run_output', target_type: 'sequence', target_id: 'seq-1', group_key: 'sequence:seq-1' })
    expect(typeof row.id).toBe('string')
    expect(hoisted.recordNoticeEvent).toHaveBeenCalledWith(
      {
        notificationId: row.id,
        workspaceId: 'w1',
        recipientMemberId: 'm1',
        type: 'flow_run_output',
        kind: 'sequence.failed',
        title: 'Sequence send failed: Q4 outreach',
        targetType: 'sequence',
        targetId: 'seq-1',
      },
      db,
    )
  })

  it('tells the agent nothing when the insert fails, or when the day’s notification is already out', async () => {
    db.failNextInsert('notification', { message: 'check violation' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await notifySequenceIssue(db as never, sequence, 'w1', 'Sequence paused', 'x')
    err.mockRestore()
    expect(hoisted.recordNoticeEvent).not.toHaveBeenCalled()

    db.seed('notification', [{ id: 'n0', recipient_id: 'm1', group_key: 'sequence:seq-1', created_at: new Date().toISOString() }])
    await notifySequenceIssue(db as never, sequence, 'w1', 'Sequence paused', 'x')
    expect(hoisted.recordNoticeEvent).not.toHaveBeenCalled()
  })
})
