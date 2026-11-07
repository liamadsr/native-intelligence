/**
 * An unread failed run lights its bot's dot (bots-v4 Phase 4c, Liam on #653;
 * failed-notices.ts):
 *
 *   • an unread `work_failed` notice of a bot is one entry in that bot's
 *     `beckoning` (its run's), so its "1 new" shows; `needsYou` and
 *     `running` don't move (Phase 4b);
 *   • read, archived, another kind, or naming no teammate: nothing;
 *   • never counted twice: two notices about one run are one entry, and a run
 *     whose own row already calls for you adds nothing;
 *   • the lists of items skip it (bubbleItems): the dot only.
 */
import { describe, it, expect } from 'vitest'
import { countByOwner } from '@/lib/work/agent-work-lanes'
import { bubbleItems } from '../bubble-items'
import { failedKey, isFailedKey, withFailedNotices, type FailedNoticeLike } from '../failed-notices'

function failed(id: string, over: Partial<FailedNoticeLike> = {}): FailedNoticeLike {
  return {
    id,
    type: 'work_failed',
    is_read: false,
    is_archived: false,
    metadata: { teammate_id: 'writer', sentence: 'I couldn’t finish.', work_item_id: `job-${id}` },
    target_type: 'work_item',
    target_id: `job-${id}`,
    ...over,
  }
}

describe('withFailedNotices', () => {
  it('puts an unread failed run in its bot’s beckoning, and moves nothing else', () => {
    const base = countByOwner([])
    const counts = withFailedNotices(base, [failed('n1')])
    expect(counts.get('tm:writer')).toEqual({ running: 0, needsYou: 0, beckoning: [failedKey('job-n1')] })
    expect(isFailedKey(counts.get('tm:writer')!.beckoning[0])).toBe(true)
    // The shared map isn't written to.
    expect(base.get('tm:writer')).toBeUndefined()
  })

  it('a read, archived, other-kind or teammate-less notice adds nothing (and hands the same counts back)', () => {
    const base = countByOwner([])
    const quiet = [
      failed('a', { is_read: true }),
      failed('b', { is_archived: true }),
      failed('c', { type: 'work_needs_you' }),
      failed('d', { metadata: { sentence: 'x' } }),
    ]
    expect(withFailedNotices(base, quiet)).toBe(base)
  })

  it('never counts a run twice: two notices about one run, or a run whose row already calls for you', () => {
    const rows = [
      {
        id: 'job-waiting',
        workspace_id: 'w1',
        member_id: 'm1',
        kind: 'work_run',
        status: 'needs_review',
        ai_team_member_id: 'writer',
        parent_id: null,
        root_id: null,
        opened_at: null,
      },
    ]
    const base = countByOwner(rows as never)
    const counts = withFailedNotices(base, [
      failed('n1'),
      failed('n2', { metadata: { teammate_id: 'writer', sentence: 'again', work_item_id: 'job-n1' }, target_id: 'job-n1' }),
      failed('n3', { metadata: { teammate_id: 'writer', sentence: 'x', work_item_id: 'job-waiting' }, target_id: 'job-waiting' }),
    ])
    expect(counts.get('tm:writer')!.beckoning).toEqual(['job-waiting', failedKey('job-n1')])
    expect(counts.get('tm:writer')!.needsYou).toBe(1)
  })
})

describe('what an unread failed run lights', () => {
  const counts = withFailedNotices(countByOwner([]), [failed('n1')])

  it('its bot’s “1 new”, with nothing waiting or running', () => {
    expect(counts.get('tm:writer')).toMatchObject({ needsYou: 0, running: 0 })
    expect(counts.get('tm:writer')!.beckoning).toHaveLength(1)
  })

  it('nothing in the lists of items (they read rows and cards only)', () => {
    expect(bubbleItems('writer', counts, [], [])).toEqual([])
  })
})
