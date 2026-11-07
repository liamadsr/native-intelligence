/**
 * The follow-up pass (src/lib/crm/contact-followups.ts): one notice per
 * contact due in the next 24 hours, to its creator only (it used to go to the
 * workspace's first five members), none for a contact with no creator.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async (..._args: unknown[]) => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))

const { checkContactFollowups } = await import('../contact-followups')

const NOW = Date.parse('2026-10-20T09:00:00.000Z')
let db: FakeSupabase

beforeEach(() => {
  db = makeFakeSupabase()
  hoisted.createNotification.mockClear()
})

describe('checkContactFollowups', () => {
  it('notifies only the contact’s creator, and skips a contact with none', async () => {
    db.seed('contact', [
      { id: 'c1', full_name: 'Jane Doe', workspace_id: 'w1', next_followup_at: '2026-10-20T15:00:00.000Z', created_by_member_id: 'm-owner', member_id: 'm-jane' },
      { id: 'c2', full_name: 'No Owner', workspace_id: 'w1', next_followup_at: '2026-10-20T16:00:00.000Z', created_by_member_id: null },
    ])
    db.seed('member', [
      { id: 'm-owner', workspace_id: 'w1' },
      { id: 'm-other', workspace_id: 'w1' },
    ])
    expect(await checkContactFollowups(db as never, NOW)).toBe(1)
    expect(hoisted.createNotification).toHaveBeenCalledTimes(1)
    expect(hoisted.createNotification).toHaveBeenCalledWith({
      workspaceId: 'w1',
      recipientId: 'm-owner',
      type: 'contact_followup_due',
      title: 'Follow up with Jane Doe',
      targetType: 'contact',
      targetId: 'c1',
      groupKey: 'followup_contact:c1:2026-10-20',
    })
  })
})
