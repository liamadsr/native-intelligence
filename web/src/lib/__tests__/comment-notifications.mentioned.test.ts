/**
 * A teammate @-mentioned in a comment is told so (migration 671's
 * `mentioned`), once: never also as a plain comment_added for the same
 * comment, never the author themselves, and on a private document only its
 * creator. Fixtures are made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ db: null as unknown, notify: vi.fn() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db }))
vi.mock('@/lib/notifications', () => ({ createNotification: (n: unknown) => hoisted.notify(n) }))

const { sendCommentNotifications } = await import('../comment-notifications')

const OWNER = 'm-owner'
const KIM = 'm-kim' // commented before
const LEE = 'm-lee' // the author
const SAM = 'm-sam' // never commented

function world(visibility: 'workspace' | 'private') {
  const db = makeFakeSupabase()
  db.seed('member', [
    { id: OWNER, display_name: 'Olu' },
    { id: KIM, display_name: 'Kim' },
    { id: LEE, display_name: 'Lee' },
    { id: SAM, display_name: 'Sam' },
  ])
  db.seed('document', [{ id: 'doc-1', title: 'Board prep', visibility, created_by: OWNER }])
  db.seed('comment', [{ id: 'c-kim', commentable_type: 'document', commentable_id: 'doc-1', author_id: KIM }])
  hoisted.db = {
    from: (table: string) => {
      const q = db.from(table) as unknown as Record<string, unknown>
      q.single = q.maybeSingle
      return q
    },
  }
}

const send = (mentionedMemberIds: string[]) =>
  sendCommentNotifications({
    supabase: hoisted.db as never,
    workspaceId: 'ws-1',
    commentableType: 'document',
    commentableId: 'doc-1',
    authorMemberId: LEE,
    commentBody: '@Sam @Kim see the numbers',
    commentId: 'c-new',
    mentionedMemberIds,
  })

const sent = () =>
  hoisted.notify.mock.calls
    .map((c) => c[0] as { recipientId: string; type: string; title: string; targetType: string; targetId: string })
    .map((n) => `${n.recipientId}:${n.type}`)
    .sort()

describe('a comment that @-mentions teammates', () => {
  beforeEach(() => hoisted.notify.mockReset())

  it('tells each one they were mentioned, once, and the rest that a comment was added', async () => {
    world('workspace')
    await send([SAM, KIM, SAM, LEE])
    // Kim commented before: mentioned, not comment_added as well. Lee wrote it: nothing.
    expect(sent()).toEqual([`${KIM}:mentioned`, `${OWNER}:comment_added`, `${SAM}:mentioned`])
    const note = hoisted.notify.mock.calls.map((c) => c[0] as { recipientId: string; title: string; targetType: string; targetId: string }).find((n) => n.recipientId === SAM)!
    expect(note).toMatchObject({ title: 'Lee mentioned you on Board prep', targetType: 'document', targetId: 'doc-1' })
  })

  it('on a private document tells only its creator', async () => {
    world('private')
    await send([SAM, OWNER])
    expect(sent()).toEqual([`${OWNER}:mentioned`])
  })

  it('with no mention notifies as before', async () => {
    world('workspace')
    await send([])
    expect(sent()).toEqual([`${KIM}:comment_added`, `${OWNER}:comment_added`])
  })
})
