/**
 * A comment on a private document (migration 369) notifies its creator only:
 * someone who commented while it was shared, or whose comment is being replied
 * to, hears nothing of a document they can no longer see. A workspace
 * document notifies as before.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ db: null as unknown, notify: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db }))
vi.mock('@/lib/notifications', () => ({ createNotification: (n: unknown) => hoisted.notify(n) }))

const { sendCommentNotifications } = await import('../comment-notifications')

const WS = 'ws-1'
const OWNER = 'm-owner'
const KIM = 'm-kim' // commented while it was shared
const LEE = 'm-lee'

function world(visibility: 'workspace' | 'private'): FakeSupabase {
  const db = makeFakeSupabase()
  db.seed('member', [
    { id: OWNER, display_name: 'Olu' },
    { id: KIM, display_name: 'Kim' },
    { id: LEE, display_name: 'Lee' },
  ])
  db.seed('document', [{ id: 'doc-1', title: 'Board prep', visibility, created_by: OWNER }])
  db.seed('comment', [
    { id: 'c-kim', commentable_type: 'document', commentable_id: 'doc-1', author_id: KIM },
    { id: 'c-lee', commentable_type: 'document', commentable_id: 'doc-1', author_id: LEE },
  ])
  // `.single()` reads one row, as PostgREST's does (the fake's returns a list).
  hoisted.db = {
    from: (table: string) => {
      const q = db.from(table) as unknown as Record<string, unknown>
      q.single = q.maybeSingle
      return q
    },
  }
  return db
}

const send = (parentId?: string) =>
  sendCommentNotifications({
    supabase: hoisted.db as never,
    workspaceId: WS,
    commentableType: 'document',
    commentableId: 'doc-1',
    authorMemberId: LEE,
    commentBody: 'see the numbers',
    commentId: 'c-new',
    ...(parentId ? { parentId } : {}),
  })

const recipients = () => hoisted.notify.mock.calls.map((c) => (c[0] as { recipientId: string }).recipientId).sort()

describe('comment notifications on a private document', () => {
  beforeEach(() => hoisted.notify.mockReset())

  it('a workspace document notifies its creator and earlier commenters', async () => {
    world('workspace')
    await send()
    expect(recipients()).toEqual([KIM, OWNER])
  })

  it('a private document notifies its creator only', async () => {
    world('private')
    await send()
    expect(recipients()).toEqual([OWNER])
  })

  it('a reply notifies the parent author once (the reply notice), not again as comment_added', async () => {
    world('workspace')
    await send('c-kim')
    const toKim = hoisted.notify.mock.calls
      .map((c) => c[0] as { recipientId: string; type: string })
      .filter((n) => n.recipientId === KIM)
    expect(toKim.map((n) => n.type)).toEqual(['comment_reply'])
    expect(recipients()).toEqual([KIM, OWNER])
  })

  it('a reply on a private document never reaches a parent author who is not its creator', async () => {
    world('private')
    await send('c-kim')
    expect(recipients()).toEqual([OWNER])
    expect(JSON.stringify(hoisted.notify.mock.calls)).not.toContain(KIM)
  })
})
