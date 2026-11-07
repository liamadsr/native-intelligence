/**
 * createNotification's `isRead` (bots-v4 Phase 4c, review F2 on #653): a
 * bot's quiet "I skipped it" notice is written already read, so it sits in its
 * bot's Notices muted and never piles up as unread (it targets the empty-state
 * document, so opening the item would never read it). Without `isRead` the row
 * is written as ever (the column's default: unread).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({
  db: null as unknown,
  deferred: [] as Promise<unknown>[],
  recordNoticeEvent: vi.fn(async (..._args: unknown[]) => 1),
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db }))
vi.mock('@/lib/log/agent-log', () => ({ deferLogWrite: (work: Promise<unknown>) => hoisted.deferred.push(work) }))
vi.mock('@/lib/agent-events/notice', () => ({ recordNoticeEvent: hoisted.recordNoticeEvent }))

const { createNotification } = await import('@/lib/notifications')

let db: FakeSupabase
let tablesRead: string[]

beforeEach(() => {
  hoisted.deferred.length = 0
  hoisted.recordNoticeEvent.mockClear()
  db = makeFakeSupabase()
  tablesRead = []
  hoisted.db = { from: (table: string) => { tablesRead.push(table); return db.from(table) } }
})

const base = {
  workspaceId: 'w1',
  recipientId: 'm1',
  type: 'flow_run_output' as const,
  title: 'Writer',
  body: "I skipped 'Weekly brief' this time. Connect a calendar first.",
}

describe('createNotification', () => {
  it('writes every notice: there is no per-type mute to read', async () => {
    await createNotification({ ...base, type: 'reminder' })
    expect(db.rows('notification')).toHaveLength(1)
    expect(tablesRead).not.toContain('notification_preference')
  })

  it('writes a quiet notice already read when asked (isRead)', async () => {
    await createNotification({ ...base, metadata: { teammate_id: 'tm-1', sentence: 'x', quiet: true }, isRead: true })
    const [row] = db.rows('notification')
    expect(row).toMatchObject({ is_read: true, metadata: { quiet: true } })
    expect(typeof row.read_at).toBe('string')
  })

  it('leaves the read state to the column’s default otherwise', async () => {
    await createNotification(base)
    const [row] = db.rows('notification')
    expect(row).not.toHaveProperty('is_read')
    expect(row).not.toHaveProperty('read_at')
  })

  it('taps a notice the agent hears about: its id minted here, one event for the recipient with its target, off the path', async () => {
    await createNotification({ ...base, type: 'comment_reply', title: 'Dana replied to your comment', targetType: 'comment', targetId: 'c1' })
    const [row] = db.rows('notification')
    expect(typeof row.id).toBe('string')
    while (hoisted.deferred.length) await hoisted.deferred.shift()
    expect(hoisted.recordNoticeEvent).toHaveBeenCalledWith(
      { notificationId: row.id, workspaceId: 'w1', recipientMemberId: 'm1', type: 'comment_reply', title: 'Dana replied to your comment', targetType: 'comment', targetId: 'c1' },
      hoisted.db,
    )
  })

  it('taps a teammate’s change too (retire-notifications-page phase 1)', async () => {
    await createNotification({ ...base, type: 'action_status_changed', title: 'Sam completed GEN-4', targetType: 'action', targetId: 'a1' })
    while (hoisted.deferred.length) await hoisted.deferred.shift()
    expect(hoisted.recordNoticeEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'action_status_changed', targetType: 'action', targetId: 'a1' }), hoisted.db)
  })

  it('taps nothing for a type the agent hears of elsewhere, and nothing when the insert fails', async () => {
    await createNotification(base)
    await createNotification({ ...base, type: 'work_failed', title: 'Failed' })
    db.failNextInsert('notification', { message: 'check violation' })
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await createNotification({ ...base, type: 'action_assigned', title: 'Assigned' })
    err.mockRestore()
    expect(hoisted.deferred).toHaveLength(0)
    expect(hoisted.recordNoticeEvent).not.toHaveBeenCalled()
  })
})
