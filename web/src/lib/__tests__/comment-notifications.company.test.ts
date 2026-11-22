/**
 * A comment on a company (migration 679) has the company's own visibility:
 * a mentioned teammate, an earlier commenter, the company's owner and the
 * author of a replied-to comment hear of it only while company_visible_to
 * lets them see the company. Made-up people.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ db: null as unknown, notify: vi.fn(), visible: new Set<string>() }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.db }))
vi.mock('@/lib/notifications', () => ({ createNotification: (n: unknown) => hoisted.notify(n) }))

const { sendCommentNotifications } = await import('../comment-notifications')

const OWNER = 'm-owner'
const KIM = 'm-kim' // commented earlier, can't see the company now
const LEE = 'm-lee' // the author
const SAM = 'm-sam' // mentioned, can see it
const RAE = 'm-rae' // mentioned, can't see it

function world() {
  const db = makeFakeSupabase()
  db.seed('member', [
    { id: OWNER, display_name: 'Olu', user_id: 'u-owner', workspace_id: 'ws-1' },
    { id: KIM, display_name: 'Kim', user_id: 'u-kim', workspace_id: 'ws-1' },
    { id: LEE, display_name: 'Lee', user_id: 'u-lee', workspace_id: 'ws-1' },
    { id: SAM, display_name: 'Sam', user_id: 'u-sam', workspace_id: 'ws-1' },
    { id: RAE, display_name: 'Rae', user_id: 'u-rae', workspace_id: 'ws-1' },
  ])
  db.seed('company', [{ id: 'co-1', name: 'Acme Example', owner_member_id: OWNER }])
  db.seed('comment', [{ id: 'c-kim', commentable_type: 'company', commentable_id: 'co-1', author_id: KIM }])
  hoisted.db = {
    from: (table: string) => {
      const q = db.from(table) as unknown as Record<string, unknown>
      q.single = q.maybeSingle
      return q
    },
    rpc: async (fn: string, args: { p_company_id: string; p_user_id: string }) =>
      fn === 'company_visible_to' ? { data: hoisted.visible.has(args.p_user_id), error: null } : { data: null, error: { message: 'unknown' } },
  }
}

const send = (extra: { parentId?: string; mentionedMemberIds?: string[] } = {}) =>
  sendCommentNotifications({
    supabase: hoisted.db as never,
    workspaceId: 'ws-1',
    commentableType: 'company',
    commentableId: 'co-1',
    authorMemberId: LEE,
    commentBody: 'renewal call moved to Friday',
    commentId: 'c-new',
    ...extra,
  })

const notices = () => hoisted.notify.mock.calls.map((c) => c[0] as { recipientId: string; type: string; title: string; targetType: string })

describe('comment notifications on a company', () => {
  beforeEach(() => {
    hoisted.notify.mockReset()
    hoisted.visible = new Set(['u-owner', 'u-sam', 'u-lee'])
    world()
  })

  it('tells only those who can see the company: the mentioned, the owner; never the others', async () => {
    await send({ mentionedMemberIds: [SAM, RAE], parentId: 'c-kim' })
    const got = notices()
    expect(got.map((n) => n.recipientId).sort()).toEqual([OWNER, SAM])
    expect(got.find((n) => n.recipientId === SAM)).toMatchObject({ type: 'mentioned', title: 'Lee mentioned you on Acme Example', targetType: 'company' })
    expect(got.find((n) => n.recipientId === OWNER)?.type).toBe('comment_added')
  })

  it('an earlier commenter who can see it again hears of it', async () => {
    hoisted.visible.add('u-kim')
    await send({ parentId: 'c-kim' })
    expect(notices().map((n) => `${n.recipientId}:${n.type}`).sort()).toEqual([`${KIM}:comment_reply`, `${OWNER}:comment_added`])
  })
})
