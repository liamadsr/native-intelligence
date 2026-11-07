/**
 * GET /api/account/notifications/bot?teammate=<id> — one bot's notices
 * (bots-v4 Phase 4c, decision 8): the notices the bell leaves out, for the
 * Notices part of the bot's bubble and page.
 *
 * What we lock in:
 *   - only that bot's notices (`metadata->>teammate_id` is its id), only the
 *     caller's (their member in the teammate's own workspace, whichever is on
 *     screen), never archived ones, newest first, with how many are unread;
 *   - `unread_only=1` lists the unread ones, and the count is the same;
 *   - a teammate the caller can't reach (hidden, another workspace's, a
 *     private team's: resolveVisibleTeammate says null) is a 404, the same as
 *     none, and nothing of the notifications is read; a bad id is a 400;
 *   - the read selects the columns the client draws (the fake projects them);
 *   - `except_items` leaves the notices about those runs out of the list AND
 *     the count (the bubble's "N more" counts what it doesn't say); one naming
 *     no run is never left out; anything but a few uuids is a 400;
 *   - POST /notifications/bot/mark-all-read reads that bot's unread notices
 *     for the caller only, and refuses a bot out of reach (404) or a bad id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const TM = '11111111-1111-4111-8111-111111111111'
const OTHER_TM = '22222222-2222-4222-8222-222222222222'

const hoisted = vi.hoisted(() => ({
  session: null as unknown,
  mate: null as null | { id: string; workspaceId: string; memberId: string; name: string; isSystem: boolean; systemKey: string | null },
  resolveError: null as Error | null,
  resolved: [] as string[],
}))

vi.mock('@/lib/api-auth', () => ({
  requireUser: vi.fn(async () => ({ supabase: hoisted.session, user: { id: 'user-1' } })),
}))
vi.mock('@/lib/chat/teammate-chat', () => ({
  resolveVisibleTeammate: vi.fn(async (_s: unknown, _u: string, id: string) => {
    hoisted.resolved.push(id)
    if (hoisted.resolveError) throw hoisted.resolveError
    return hoisted.mate && hoisted.mate.id === id ? hoisted.mate : null
  }),
}))

const { GET } = await import('@/app/api/account/notifications/bot/route')
const { POST: markAllRead } = await import('@/app/api/account/notifications/bot/mark-all-read/route')

function req(query: string) {
  return new Request(`http://localhost/api/account/notifications/bot${query}`)
}

function notice(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: 'w2',
    recipient_id: 'm2',
    type: 'work_failed',
    title: 'Writer',
    body: 'I couldn’t finish.',
    actor_id: null,
    target_type: 'work_item',
    target_id: `job-${id}`,
    context_type: null,
    context_id: null,
    is_read: false,
    read_at: null,
    is_archived: false,
    group_key: null,
    metadata: { teammate_id: TM, sentence: 'I couldn’t finish.', work_item_id: `job-${id}` },
    created_at: `2026-10-07T10:0${id.slice(-1)}:00.000Z`,
    // Not a column the route asks for: projection drops it.
    secret_column: 'never sent',
    ...over,
  }
}

let session: FakeSupabase

beforeEach(() => {
  session = makeFakeSupabase({ project: true })
  hoisted.session = session
  hoisted.mate = { id: TM, workspaceId: 'w2', memberId: 'm2', name: 'Writer', isSystem: false, systemKey: null }
  hoisted.resolveError = null
  hoisted.resolved = []
  session.seed('notification', [
    notice('n1', { is_read: true }),
    notice('n2'),
    notice('n3'),
    // Another bot's, a plain one (the bell's), an archived one, someone else's.
    notice('n4', { metadata: { teammate_id: OTHER_TM, sentence: 'Other.' } }),
    notice('n5', { metadata: {}, type: 'action_assigned' }),
    notice('n6', { is_archived: true }),
    notice('n7', { recipient_id: 'm9' }),
  ])
})

describe('GET /api/account/notifications/bot', () => {
  it('lists that bot’s notices for the caller, newest first, with how many are unread', async () => {
    const res = await GET(req(`?teammate=${TM}`))
    expect(res.status).toBe(200)
    const body = await readJson<{ teammate_id: string; workspace_id: string; notices: Array<Record<string, unknown>>; unread: number }>(res)
    expect(body.teammate_id).toBe(TM)
    expect(body.workspace_id).toBe('w2')
    expect(body.notices.map((n) => n.id)).toEqual(['n3', 'n2', 'n1'])
    expect(body.unread).toBe(2)
    // The columns the client draws, and no actor to name.
    expect(body.notices[0]).toMatchObject({ metadata: { teammate_id: TM }, is_read: false, target_id: 'job-n3', actor_name: null, actor_avatar: null })
    expect(body.notices[0]).not.toHaveProperty('secret_column')
    // Read as the caller's member in the teammate's own workspace.
    const reads = session.calls.filter((c) => c.table === 'notification')
    expect(reads).toHaveLength(2)
    for (const r of reads) expect(r.filters).toContainEqual(['recipient_id', 'm2'])
  })

  it('unread_only=1 lists the unread ones; limit caps them', async () => {
    const unread = await readJson<{ notices: Array<{ id: string }>; unread: number }>(await GET(req(`?teammate=${TM}&unread_only=1`)))
    expect(unread.notices.map((n) => n.id)).toEqual(['n3', 'n2'])
    expect(unread.unread).toBe(2)
    const one = await readJson<{ notices: Array<{ id: string }>; unread: number }>(await GET(req(`?teammate=${TM}&limit=1`)))
    expect(one.notices.map((n) => n.id)).toEqual(['n3'])
    expect(one.unread).toBe(2)
  })

  it('a bot the caller can’t reach (a private team, another workspace, hidden) is a 404, and no notice is read', async () => {
    hoisted.mate = null
    const res = await GET(req(`?teammate=${TM}`))
    expect(res.status).toBe(404)
    expect(session.calls.some((c) => c.table === 'notification')).toBe(false)
  })

  it('a bad id is a 400, before any read', async () => {
    const res = await GET(req('?teammate=writer'))
    expect(res.status).toBe(400)
    expect(hoisted.resolved).toEqual([])
  })

  it('a failed teammate check is a 500', async () => {
    hoisted.resolveError = new Error('boom')
    const res = await GET(req(`?teammate=${TM}`))
    expect(res.status).toBe(500)
  })
})

describe('GET /api/account/notifications/bot — except_items', () => {
  const RUN2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
  beforeEach(() => {
    session.rows('notification').splice(0)
    session.seed('notification', [
      notice('n1', { metadata: { teammate_id: TM, sentence: 'one', work_item_id: 'job-n1' } }),
      notice('n2', { metadata: { teammate_id: TM, sentence: 'two', work_item_id: RUN2 } }),
      notice('n3', { metadata: { teammate_id: TM, sentence: 'no run' } }),
    ])
  })

  it('leaves the listed runs’ notices out of the list and the count; one with no run stays', async () => {
    const body = await readJson<{ notices: Array<{ id: string }>; unread: number }>(await GET(req(`?teammate=${TM}&unread_only=1&except_items=${RUN2}`)))
    expect(body.notices.map((n) => n.id)).toEqual(['n3', 'n1'])
    expect(body.unread).toBe(2)
  })

  it('anything but a few uuids is a 400', async () => {
    expect((await GET(req(`?teammate=${TM}&except_items=job-n1`))).status).toBe(400)
    const many = Array.from({ length: 31 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`).join(',')
    expect((await GET(req(`?teammate=${TM}&except_items=${many}`))).status).toBe(400)
  })
})

describe('POST /api/account/notifications/bot/mark-all-read', () => {
  const post = (body: unknown) => markAllRead(new Request('http://localhost/api/account/notifications/bot/mark-all-read', { method: 'POST', body: JSON.stringify(body) }))

  it('reads that bot’s unread notices for the caller, and nothing else', async () => {
    const res = await post({ teammate: TM })
    expect(res.status).toBe(200)
    expect(await readJson<{ success: boolean; read: number }>(res)).toEqual({ success: true, read: 2 })
    const unread = session
      .rows('notification')
      .filter((n) => !n.is_read)
      .map((n) => n.id)
      .sort()
    // Another bot's, the bell's, an archived one, someone else's: untouched.
    expect(unread).toEqual(['n4', 'n5', 'n6', 'n7'])
  })

  it('a bot out of reach is a 404 and reads nothing; a bad id is a 400', async () => {
    hoisted.mate = null
    expect((await post({ teammate: TM })).status).toBe(404)
    expect(session.rows('notification').filter((n) => n.is_read).map((n) => n.id)).toEqual(['n1'])
    expect((await post({ teammate: 'writer' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
  })
})

// One face (always-on-agent §2c): the agent's notices are its own and every area face's of its workspace.
describe('the agent’s Notices cover its workspace’s area faces', () => {
  const MAIL = '33333333-3333-4333-8333-333333333333'
  const W1_MAIL = '44444444-4444-4444-8444-444444444444'

  beforeEach(() => {
    hoisted.mate = { id: TM, workspaceId: 'w2', memberId: 'm2', name: 'Assistant', isSystem: true, systemKey: 'assistant' }
    session.seed('ai_team_member', [
      { id: TM, workspace_id: 'w2', is_system: true, system_key: 'assistant' },
      { id: MAIL, workspace_id: 'w2', is_system: true, system_key: 'mail' },
      // Another workspace's area face: never the agent's here.
      { id: W1_MAIL, workspace_id: 'w1', is_system: true, system_key: 'mail' },
    ])
    session.seed('notification', [
      notice('n8', { metadata: { teammate_id: MAIL, sentence: 'I drafted two replies.', area: 'mail' } }),
      notice('n9', { metadata: { teammate_id: W1_MAIL, sentence: 'Elsewhere.' } }),
    ])
  })

  it('lists and counts the area faces’ notices with its own, never another workspace’s', async () => {
    const body = await readJson<{ teammate_id: string; notices: Array<{ id: string }>; unread: number }>(await GET(req(`?teammate=${TM}`)))
    expect(body.teammate_id).toBe(TM)
    expect(body.notices.map((n) => n.id)).toEqual(['n8', 'n3', 'n2', 'n1'])
    expect(body.unread).toBe(3)
  })

  it('Mark all read reads them too', async () => {
    const res = await markAllRead(new Request('http://localhost/api/account/notifications/bot/mark-all-read', { method: 'POST', body: JSON.stringify({ teammate: TM }) }))
    expect(await readJson<{ read: number }>(res)).toMatchObject({ read: 3 })
  })

  it('another bot’s Notices stay its own', async () => {
    hoisted.mate = { id: TM, workspaceId: 'w2', memberId: 'm2', name: 'Writer', isSystem: false, systemKey: null }
    const body = await readJson<{ notices: Array<{ id: string }> }>(await GET(req(`?teammate=${TM}`)))
    expect(body.notices.map((n) => n.id)).toEqual(['n3', 'n2', 'n1'])
  })
})
