/**
 * Orphaned bots' notices are plain notices (bots-v4 Phase 4c, Liam on #653;
 * review F1): only the notices of a bot the caller can REACH leave the plain
 * list (`notifications`). One whose teammate is deleted, or behind a private
 * team the caller isn't on, stays in it; the bots' notices the shell holds
 * (`bot_notifications`) leave it out.
 *
 * A failed run's notice (`work_failed`) is a bot's notice like any other: the
 * bell's exception for it went with the bell (2026-10-20,
 * docs/plans/retire-notifications-page.md). The route counts nothing any more
 * (no `unread_count`), and its bulk verbs (mark-all-read, archive-read) went.
 *
 * On the shared double (columns projected), with the real reach rule
 * (callerReachableTeammateIds) over its team, member and team_member rows, in
 * the `all` scope (one membership).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const PUBLIC = '11111111-1111-4111-8111-111111111111'
const PRIVATE_OFF = '22222222-2222-4222-8222-222222222222'
const PRIVATE_ON = '33333333-3333-4333-8333-333333333333'
const DELETED = '44444444-4444-4444-8444-444444444444'
const SYSTEM = '55555555-5555-4555-8555-555555555555'

const hoisted = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: string) => (hoisted.db as FakeSupabase).from(table),
  }),
}))
vi.mock('@/app/api/account/notifications/scope', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api/account/notifications/scope')>()
  return { ...actual, resolveMemberships: vi.fn(async () => [{ memberId: 'm1', workspaceId: 'w1' }]) }
})

const { GET } = await import('@/app/api/account/notifications/route')

function notice(id: string, teammate: string | null, minute: number, over: Record<string, unknown> = {}) {
  return {
    id,
    workspace_id: 'w1',
    recipient_id: 'm1',
    type: teammate ? 'work_needs_you' : 'action_assigned',
    title: teammate ? 'Bot' : `Plain ${id}`,
    body: null,
    actor_id: null,
    target_type: null,
    target_id: null,
    context_type: null,
    context_id: null,
    is_read: false,
    read_at: null,
    is_archived: false,
    group_key: null,
    metadata: teammate ? { teammate_id: teammate, sentence: `Said by ${id}.` } : {},
    created_at: `2026-10-07T10:${String(minute).padStart(2, '0')}:00.000Z`,
    ...over,
  }
}

let db: FakeSupabase

beforeEach(() => {
  db = makeFakeSupabase({ project: true })
  hoisted.db = db
  db.seed('notification', [
    notice('plain', null, 1),
    notice('plain-read', null, 2, { is_read: true }),
    notice('pub', PUBLIC, 3),
    notice('off', PRIVATE_OFF, 4),
    notice('on', PRIVATE_ON, 5),
    notice('gone', DELETED, 6),
    notice('sys', SYSTEM, 7),
  ])
  db.seed('ai_team_member', [
    { id: PUBLIC, workspace_id: 'w1', team_id: 'team-pub', is_system: false },
    { id: PRIVATE_OFF, workspace_id: 'w1', team_id: 'team-off', is_system: false },
    { id: PRIVATE_ON, workspace_id: 'w1', team_id: 'team-on', is_system: false },
    { id: SYSTEM, workspace_id: 'w1', team_id: null, is_system: true },
    // DELETED: no row (hard-deleted).
  ])
  db.seed('team', [
    { id: 'team-pub', workspace_id: 'w1', is_private: false },
    { id: 'team-off', workspace_id: 'w1', is_private: true },
    { id: 'team-on', workspace_id: 'w1', is_private: true },
  ])
  db.seed('member', [{ id: 'm1', user_id: 'user-1', workspace_id: 'w1' }])
  db.seed('team_member', [{ team_id: 'team-on', member_id: 'm1' }])
})

function getRequest(query: string) {
  return { nextUrl: new URL(`https://nativeintelligence.dev/api/account/notifications${query}`) } as never
}

describe('an orphaned bot’s notices are plain ones', () => {
  it('a deleted bot’s and an unreachable private team’s stay in the plain list; a reachable bot’s leave it', async () => {
    const res = await GET(getRequest('?workspace_scope=all&limit=50&include_bots=1'))
    const body = (await res.json()) as {
      notifications: Array<{ id: string }>
      bot_notifications: Array<{ id: string }>
      orphan_teammate_ids: string[]
      bot_teammate_ids: string[]
    }
    expect(body.notifications.map((n) => n.id)).toEqual(['gone', 'off', 'plain-read', 'plain'])
    // Nothing counts any more.
    expect(body).not.toHaveProperty('unread_count')
    expect(body.bot_notifications.map((n) => n.id)).toEqual(['sys', 'on', 'pub'])
    expect([...body.orphan_teammate_ids].sort()).toEqual([PRIVATE_OFF, DELETED].sort())
    expect([...body.bot_teammate_ids].sort()).toEqual([PUBLIC, PRIVATE_ON, SYSTEM].sort())
  })

  it('reads the teammates’ names in one batch: one read of the notices, one of the teammates, one each of teams, members and seats', async () => {
    await GET(getRequest('?workspace_scope=all'))
    const reads = db.calls.map((c) => c.table)
    expect(reads.filter((t) => t === 'ai_team_member')).toHaveLength(1)
    expect(reads.filter((t) => t === 'team')).toHaveLength(1)
    expect(reads.filter((t) => t === 'team_member')).toHaveLength(1)
  })

  it('with every bot reachable, the list is exactly the plain notices', async () => {
    db.seed('team_member', [{ team_id: 'team-off', member_id: 'm1' }])
    db.rows('notification').splice(
      db.rows('notification').findIndex((n) => n.id === 'gone'),
      1,
    )
    const body = (await (await GET(getRequest('?workspace_scope=all&include_bots=1'))).json()) as {
      notifications: Array<{ id: string }>
      orphan_teammate_ids: string[]
    }
    expect(body.notifications.map((n) => n.id)).toEqual(['plain-read', 'plain'])
    expect(body.orphan_teammate_ids).toEqual([])
  })

  it('a reachable bot’s failed run is its bot’s only: held with the bots’ notices, never in the plain list', async () => {
    db.seed('notification', [
      notice('failed', PUBLIC, 8, { type: 'work_failed', target_type: 'work_item', target_id: 'job-1' }),
      notice('failed-read', PUBLIC, 9, { type: 'work_failed', is_read: true }),
    ])
    const body = (await (await GET(getRequest('?workspace_scope=all&limit=50&include_bots=1'))).json()) as {
      notifications: Array<{ id: string }>
      bot_notifications: Array<{ id: string }>
    }
    expect(body.notifications.map((n) => n.id)).toEqual(['gone', 'off', 'plain-read', 'plain'])
    expect(body.bot_notifications.map((n) => n.id)).toEqual(['failed-read', 'failed', 'sys', 'on', 'pub'])
  })
})
