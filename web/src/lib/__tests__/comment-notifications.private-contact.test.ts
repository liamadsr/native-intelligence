/**
 * A comment on a contact that is not open to the whole workspace (migration
 * 058: private, team or shared) sends its text to the contact's creator
 * only: a teammate who is mentioned, who commented earlier or whose comment
 * is replied to may not be able to open the contact. A workspace contact
 * notifies as any record does, and its name is never in a notice.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ db: null as unknown, notify: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db }))
vi.mock('@/lib/notifications', () => ({ createNotification: (n: unknown) => hoisted.notify(n) }))

const { sendCommentNotifications } = await import('../comment-notifications')

const OWNER = 'm-owner'
const KIM = 'm-kim' // commented earlier
const LEE = 'm-lee'
const SAM = 'm-sam' // mentioned

function world(contact: Record<string, unknown> | null) {
  const db = makeFakeSupabase()
  db.seed('member', [
    { id: OWNER, display_name: 'Olu' },
    { id: KIM, display_name: 'Kim' },
    { id: LEE, display_name: 'Lee' },
    { id: SAM, display_name: 'Sam' },
  ])
  db.seed('contact', contact ? [{ id: 'contact-1', full_name: 'Maya Okafor', ...contact }] : [])
  db.seed('comment', [{ id: 'c-kim', commentable_type: 'contact', commentable_id: 'contact-1', author_id: KIM }])
  // `.single()` reads one row, as PostgREST's does (the fake's returns a list).
  hoisted.db = {
    from: (table: string) => {
      const q = db.from(table) as unknown as Record<string, unknown>
      q.single = q.maybeSingle
      return q
    },
  }
}

const send = (extra: { parentId?: string; mentionedMemberIds?: string[] } = {}) =>
  sendCommentNotifications({
    supabase: hoisted.db as never,
    workspaceId: 'ws-1',
    commentableType: 'contact',
    commentableId: 'contact-1',
    authorMemberId: LEE,
    commentBody: 'renewal is at risk',
    commentId: 'c-new',
    ...extra,
  })

const notices = () => hoisted.notify.mock.calls.map((c) => c[0] as { recipientId: string; title: string; body: string })
const recipients = () => notices().map((n) => n.recipientId).sort()

describe('comment notifications on a contact', () => {
  beforeEach(() => hoisted.notify.mockReset())

  it('a workspace contact tells the mentioned teammate and earlier commenters, and never names the contact', async () => {
    world({ visibility: 'workspace', created_by_member_id: OWNER })
    await send({ mentionedMemberIds: [SAM] })
    expect(recipients()).toEqual([KIM, SAM])
    for (const notice of notices()) expect(notice.title).not.toContain('Maya')
  })

  it.each(['private', 'team', 'shared'])('a %s contact tells nobody but its creator', async (visibility) => {
    world({ visibility, created_by_member_id: OWNER })
    await send({ mentionedMemberIds: [SAM, OWNER], parentId: 'c-kim' })
    expect(recipients()).toEqual([OWNER])
  })

  it('a private contact with no creator on record tells nobody', async () => {
    world({ visibility: 'private', created_by_member_id: null })
    await send({ mentionedMemberIds: [SAM], parentId: 'c-kim' })
    expect(recipients()).toEqual([])
  })

  it('a contact that cannot be read is treated as not open, never as open', async () => {
    world(null)
    await send({ mentionedMemberIds: [SAM], parentId: 'c-kim' })
    expect(recipients()).toEqual([])
  })
})
