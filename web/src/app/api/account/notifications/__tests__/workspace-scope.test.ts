/**
 * The opt-in `all` scope on the notification routes.
 *
 * Two halves, and the first matters more than the second — the same split the
 * views query engine's personal scope is pinned under (lib/views/__tests__/
 * workspace-scope.test.ts), because the risk is identical:
 *
 *  1. THE DEFAULT PATH DOES NOT MOVE. Every caller that existed before this
 *     feature sends no scope at all, and must keep emitting the query it always
 *     emitted — the same member lookup, the same `eq('recipient_id', …)`, the
 *     same archived/order/limit chain, the same select string with no workspace
 *     embed, and a response body with no extra keys. A cross-workspace feature
 *     that quietly rewrites the single-workspace list is a regression in the
 *     one query the notification provider fires on every dashboard load, so the
 *     chain is asserted WHOLE and in order here, not sampled.
 *
 *  2. `all` WIDENS BY THE RESOLVED MEMBER IDS, never by anything a caller
 *     invented: `in('recipient_id', …)` over `resolveMemberIdsForUser`'s result.
 *     Nothing in a query string or body names a workspace or a member id, so the
 *     scope flag cannot become a way to ask for someone else's notices.
 *
 * And the `[id]` PATCH, which is the one route that widens UNCONDITIONALLY:
 * "is this addressed to me" is a question the client cannot answer (the same
 * person is a different member row per workspace), so the server answers it
 * against every member row the caller holds.
 *
 * And the plain notices' rule (bots-v4 Phase 4c, decision 8): a bot's notice
 * (its row names a teammate, `metadata->>teammate_id`) lives with the bot, so
 * the list carries `or(is.null)` on it, and a bot out of the caller's reach (an
 * orphan: notice-reach.ts) keeps its notices in the list through
 * `or(is.null, in.(orphans))`. A failed run's notice is its bot's only: the
 * bell's exception for it went with the bell. The first read of `notification`
 * is the teammates the caller's notices name. `include_bots=1` adds the bots'
 * notices (the newest, and every unread one) and the teammates split, as keys
 * only that ask returns.
 *
 * The notifications page went (docs/plans/retire-notifications-page.md): the
 * route counts nothing any more (no `unread_count`), and its bulk verbs
 * (mark-all-read, archive-read) are deleted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Call = { method: string; args: unknown[] }

/** Chain methods the notification routes reach for. Each records and returns `this`. */
const CHAIN_METHODS = ['select', 'eq', 'in', 'is', 'not', 'or', 'order', 'range', 'limit', 'single', 'update'] as const

/**
 * A recording query builder. `single()` is terminal (it resolves rather than
 * chaining) and everything else returns itself, so a whole chain is one flat
 * ordered list of calls — which is what makes a reordered or swapped predicate
 * visible instead of merely absent.
 */
function makeChain(results: { list?: unknown; single?: unknown; singleFn?: (calls: Call[]) => unknown }) {
  const calls: Call[] = []
  const chain: Record<string, unknown> = {
    // The non-.single() chains are awaited directly.
    then: (cb: (v: unknown) => unknown) =>
      Promise.resolve(results.list ?? { data: [], count: 0, error: null }).then(cb),
  }
  for (const method of CHAIN_METHODS) {
    chain[method] = vi.fn((...args: unknown[]) => {
      calls.push({ method, args })
      if (method === 'single') {
        // `singleFn` sees the filters the route actually applied, so a test can
        // answer the way the DATABASE would — the row comes back only when the
        // predicate covers it — instead of asserting on the chain alone.
        return Promise.resolve(
          results.singleFn ? results.singleFn(calls) : results.single ?? { data: null, error: null },
        )
      }
      return chain
    })
  }
  return { chain, calls }
}

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  // Per-table results and recorded calls, keyed by table name.
  tables: {} as Record<
    string,
    { result?: unknown; single?: unknown; singleFn?: (calls: { method: string; args: unknown[] }[]) => unknown }
  >,
  calls: [] as { table: string; calls: Call[] }[],
  workspaceId: null as string | null | Response,
  memberIds: [] as { id: string; workspace_id: string }[],
  memberIdsError: null as unknown,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: hoisted.getUser },
    from: (table: string) => {
      const spec = hoisted.tables[table] ?? {}
      const { chain, calls } = makeChain({
        list: spec.result,
        single: spec.single,
        singleFn: spec.singleFn,
      })
      hoisted.calls.push({ table, calls })
      return chain
    },
  }),
}))

vi.mock('@/lib/workspace', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/workspace')>()
  return {
    ...actual,
    getCurrentWorkspaceIdOrResponse: async () => hoisted.workspaceId,
    resolveMemberIdsForUser: async () => {
      if (hoisted.memberIdsError) throw hoisted.memberIdsError
      return hoisted.memberIds.map((m) => ({ memberId: m.id, workspaceId: m.workspace_id }))
    },
  }
})

const { GET } = await import('@/app/api/account/notifications/route')
const { PATCH } = await import('@/app/api/account/notifications/[id]/route')

const USER = { id: 'user-1' }
const MEMBERSHIPS = [
  { id: 'member-a', workspace_id: 'ws-a' },
  { id: 'member-b', workspace_id: 'ws-b' },
]

/** The calls recorded against one table, in order (first read of that table). */
function callsFor(table: string): Call[] {
  return hoisted.calls.find((c) => c.table === table)?.calls ?? []
}

/** Every read of a table, in order — the teammates named, the list and the bots'
 *  reads all hit `notification`, so they have to be told apart by position. */
function allCallsFor(table: string): Call[][] {
  return hoisted.calls.filter((c) => c.table === table).map((c) => c.calls)
}

/** NextRequest's `nextUrl` is what the route reads; a plain Request has none. */
function getRequest(query = '') {
  const url = new URL(`https://dial8.ai/api/account/notifications${query}`)
  return { nextUrl: url } as never
}

beforeEach(() => {
  hoisted.getUser.mockReset()
  hoisted.getUser.mockResolvedValue({ data: { user: USER } })
  hoisted.tables = {
    member: { single: { data: { id: 'member-a' }, error: null } },
    notification: { result: { data: [], count: 3, error: null } },
  }
  hoisted.calls = []
  hoisted.workspaceId = 'ws-a'
  hoisted.memberIds = MEMBERSHIPS
  hoisted.memberIdsError = null
})

// ── The single-workspace regression guard ───────────────────────────────────

describe('GET /notifications — the default scope is untouched', () => {
  it('emits exactly the chain it emitted before cross-workspace existed', async () => {
    await GET(getRequest('?limit=50'))

    // The member lookup: the active workspace's ONE member row.
    expect(callsFor('member').map((c) => ({ method: c.method, args: c.args }))).toEqual([
      { method: 'select', args: ['id'] },
      { method: 'eq', args: ['user_id', 'user-1'] },
      { method: 'eq', args: ['workspace_id', 'ws-a'] },
      { method: 'single', args: [] },
    ])

    // The list query: WHOLE chain, in order. An `in` where an `eq` used to be, a
    // reordered predicate, or a lost `limit` would all show up here.
    // First, the teammates the notices name (notice-reach.ts); then the list. No count.
    const reads = allCallsFor('notification')
    expect(reads).toHaveLength(2)
    const [named, list] = reads
    expect(named.map((c) => ({ method: c.method, args: c.args }))).toEqual([
      { method: 'select', args: ['teammate_id:metadata->>teammate_id'] },
      { method: 'eq', args: ['recipient_id', 'member-a'] },
      { method: 'eq', args: ['is_archived', false] },
      { method: 'not', args: ['metadata->>teammate_id', 'is', null] },
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'limit', args: [1000] },
    ])
    expect(list.map((c) => ({ method: c.method, args: c.args.slice(1) }))).toEqual([
      { method: 'select', args: [] },
      { method: 'eq', args: ['member-a'] },
      { method: 'eq', args: [false] },
      { method: 'or', args: [] },
      { method: 'order', args: [{ ascending: false }] },
      { method: 'limit', args: [] },
    ])
    expect(list.map((c) => c.args[0])).toEqual([
      expect.stringContaining('id, workspace_id, recipient_id'),
      'recipient_id',
      'is_archived',
      // The plain notices only: a bot's lives with the bot (Phase 4c), a failed run's too.
      'metadata->>teammate_id.is.null',
      'created_at',
      50,
    ])
  })

  it('does NOT embed the workspace — nothing on a single-workspace list would draw it', async () => {
    await GET(getRequest())
    const select = allCallsFor('notification')[1][0].args[0] as string
    expect(select).not.toContain('workspace:workspace')
    // The actor embed it has always carried is still there.
    expect(select).toContain('actor:member!actor_id(id, display_name, avatar_url)')
  })

  it('returns the notices alone (no unread count any more)', async () => {
    const res = await GET(getRequest())
    expect(Object.keys(await res.json()).sort()).toEqual(['notifications'])
    // And reads no bot's notices unasked: the teammates named, and the list.
    expect(allCallsFor('notification')).toHaveLength(2)
  })

  it("passing workspace_scope=workspace explicitly changes nothing", async () => {
    await GET(getRequest('?limit=50'))
    const bare = JSON.stringify(hoisted.calls)
    hoisted.calls = []
    await GET(getRequest('?limit=50&workspace_scope=workspace'))
    expect(JSON.stringify(hoisted.calls)).toEqual(bare)
  })

  it('still 403s when the caller is not a member of the active workspace', async () => {
    hoisted.tables.member = { single: { data: null, error: null } }
    const res = await GET(getRequest())
    expect(res.status).toBe(403)
  })
})

// ── The widened scope ───────────────────────────────────────────────────────

describe("GET /notifications — workspace_scope=all", () => {
  it('replaces the recipient equality with the resolved member-id set', async () => {
    await GET(getRequest('?workspace_scope=all'))
    const [named, list] = allCallsFor('notification')
    expect(list).toContainEqual({ method: 'in', args: ['recipient_id', ['member-a', 'member-b']] })
    // The active workspace's member id must not survive as a second predicate —
    // that would intersect the two and hand back a single-workspace list.
    expect(list).not.toContainEqual({ method: 'eq', args: ['recipient_id', 'member-a'] })
    // The teammates named span the same set.
    expect(named).toContainEqual({ method: 'in', args: ['recipient_id', ['member-a', 'member-b']] })
  })

  it('never resolves the active workspace at all — the membership set IS the scope', async () => {
    hoisted.workspaceId = null // would 400 the default path
    const res = await GET(getRequest('?workspace_scope=all'))
    expect(res.status).toBe(200)
    // No per-workspace member lookup either.
    expect(hoisted.calls.some((c) => c.table === 'member')).toBe(false)
  })

  it('embeds the workspace on every row, naming the FK as the hint', async () => {
    await GET(getRequest('?workspace_scope=all'))
    const select = allCallsFor('notification')[1][0].args[0] as string
    expect(select).toContain('workspace:workspace!workspace_id(id, name, slug, logo_url)')
    // Row-sized — a name, a slug and a logo, not the settings blob.
    const fields = select
      .match(/workspace:workspace!workspace_id\(([^)]*)\)/)![1]
      .split(',')
      .map((f) => f.trim())
    expect(fields).toEqual(['id', 'name', 'slug', 'logo_url'])
  })

  it('reads one page, the newest, the limit last: nothing pages further', async () => {
    await GET(getRequest('?workspace_scope=all&offset=50&unread_only=true'))
    const list = allCallsFor('notification')[1]
    expect(list.filter((c) => c.method === 'order').map((c) => c.args)).toEqual([['created_at', { ascending: false }]])
    expect(list[list.length - 1]).toMatchObject({ method: 'limit', args: [50] })
    // Paging and the unread filter went with the notifications page.
    expect(list.some((c) => c.method === 'range')).toBe(false)
    expect(list.some((c) => c.method === 'eq' && c.args[0] === 'is_read')).toBe(false)
  })

  it('returns the membership set so the client can subscribe one channel per member', async () => {
    const res = await GET(getRequest('?workspace_scope=all'))
    expect((await res.json()).memberships).toEqual([
      { memberId: 'member-a', workspaceId: 'ws-a' },
      { memberId: 'member-b', workspaceId: 'ws-b' },
    ])
  })

  it('flattens the embedded workspace onto the row', async () => {
    hoisted.tables.notification = {
      result: {
        data: [
          {
            id: 'n-1',
            target_type: null,
            target_id: null,
            context_type: null,
            context_id: null,
            actor: null,
            // PostgREST returns a many-to-one embed as an object; older
            // supabase-js typings surfaced an array. Both must land the same.
            workspace: [{ id: 'ws-b', name: 'Other', slug: 'other', logo_url: null }],
          },
        ],
        count: 0,
        error: null,
      },
    }
    const res = await GET(getRequest('?workspace_scope=all'))
    const [row] = (await res.json()).notifications
    expect(row.workspace).toEqual({ id: 'ws-b', name: 'Other', slug: 'other', logo_url: null })
  })

  it('answers directly for a user with no memberships — never an empty `in`', async () => {
    hoisted.memberIds = []
    const res = await GET(getRequest('?workspace_scope=all'))
    expect(await res.json()).toEqual({ notifications: [], memberships: [] })
    expect(hoisted.calls.some((c) => c.table === 'notification')).toBe(false)
  })

  it('maps a half-expired session to 401, not an unexplained 500', async () => {
    const { WorkspaceLookupError } = await import('@/lib/workspace')
    hoisted.memberIdsError = new WorkspaceLookupError('session_expired')
    const res = await GET(getRequest('?workspace_scope=all'))
    expect(res.status).toBe(401)
  })
})

describe('invalid workspace_scope', () => {
  it('400s rather than silently falling back to the narrow scope', async () => {
    for (const value of ['everything', '', 'ALL', 'all,workspace']) {
      hoisted.calls = []
      const res = await GET(getRequest(`?workspace_scope=${encodeURIComponent(value)}`))
      expect(res.status, value).toBe(400)
      expect((await res.json()).code, value).toBe('BAD_REQUEST')
      // Rejected BEFORE any read — a bad scope must not half-run the handler.
      expect(hoisted.calls, value).toEqual([])
    }
  })
})

// ── A bot's notices (bots-v4 Phase 4c) ─────────────────────────────────────

describe('GET /notifications — a bot’s notices live with the bot', () => {
  it('include_bots=1 reads the bots’ newest notices apart, in the same recipient set', async () => {
    const bot = {
      id: 'n-bot',
      workspace_id: 'ws-a',
      recipient_id: 'member-a',
      metadata: { teammate_id: 'tm-1', sentence: 'I drafted a reply.' },
      created_at: '2026-10-07T10:00:00.000Z',
    }
    hoisted.tables.notification = { result: { data: [bot], count: 0, error: null } }
    const res = await GET(getRequest('?limit=50&include_bots=1'))
    const body = await res.json()
    expect(Object.keys(body).sort()).toEqual(['bot_notifications', 'bot_teammate_ids', 'notifications', 'orphan_teammate_ids'])
    // The newest and the unread read the same row here: it comes once.
    expect(body.bot_notifications).toEqual([expect.objectContaining({ id: 'n-bot', actor_name: null, actor_avatar: null })])
    expect(body.orphan_teammate_ids).toEqual([])

    const [, , newest, unread] = allCallsFor('notification')
    expect(newest.map((c) => ({ method: c.method, args: c.args }))).toEqual([
      { method: 'select', args: [expect.not.stringContaining('actor:')] },
      { method: 'eq', args: ['recipient_id', 'member-a'] },
      { method: 'eq', args: ['is_archived', false] },
      { method: 'not', args: ['metadata->>teammate_id', 'is', null] },
      { method: 'order', args: ['created_at', { ascending: false }] },
      { method: 'order', args: ['id', { ascending: false }] },
      { method: 'limit', args: [50] },
    ])
    // And every unread one (an unread failed run lights its bot's dot; the overlay lists them).
    expect(unread).toContainEqual({ method: 'eq', args: ['is_read', false] })
    expect(unread).toContainEqual({ method: 'limit', args: [100] })
  })

  it('an orphaned bot (named, out of reach: here deleted) keeps its notices in the plain list, and out of the bots’ reads', async () => {
    const GONE = '44444444-4444-4444-8444-444444444444'
    hoisted.tables.notification = { result: { data: [{ id: 'n-gone', teammate_id: GONE }], count: 1, error: null } }
    const res = await GET(getRequest('?limit=50&include_bots=1'))
    const body = await res.json()
    expect(body.orphan_teammate_ids).toEqual([GONE])
    const [, list, newest] = allCallsFor('notification')
    const plain = { method: 'or', args: [`metadata->>teammate_id.is.null,metadata->>teammate_id.in.(${GONE})`] }
    expect(list).toContainEqual(plain)
    expect(list).not.toContainEqual({ method: 'is', args: ['metadata->>teammate_id', null] })
    expect(newest).toContainEqual({ method: 'not', args: ['metadata->>teammate_id', 'in', `(${GONE})`] })
  })

  it('include_bots=1 in the `all` scope reads every membership’s', async () => {
    await GET(getRequest('?workspace_scope=all&include_bots=1'))
    const [named, , newest] = allCallsFor('notification')
    expect(named).toContainEqual({ method: 'in', args: ['recipient_id', ['member-a', 'member-b']] })
    expect(newest).toContainEqual({ method: 'in', args: ['recipient_id', ['member-a', 'member-b']] })
  })

  it('a user with no memberships gets an empty bots list too, never an empty `in`', async () => {
    hoisted.memberIds = []
    const res = await GET(getRequest('?workspace_scope=all&include_bots=1'))
    expect(await res.json()).toEqual({
      notifications: [],
      memberships: [],
      bot_notifications: [],
      orphan_teammate_ids: [],
      bot_teammate_ids: [],
    })
  })
})

// ── Per-notification ownership ──────────────────────────────────────────────

describe('PATCH /notifications/[id] — ownership widened to every member row', () => {
  function patchRequest(body: unknown) {
    return { json: async () => body } as never
  }

  it('filters on the whole member-id set, not the active workspace member alone', async () => {
    await PATCH(patchRequest({ is_read: true }), { params: Promise.resolve({ id: 'n-1' }) })
    const calls = callsFor('notification')
    expect(calls).toContainEqual({ method: 'eq', args: ['id', 'n-1'] })
    expect(calls).toContainEqual({
      method: 'in',
      args: ['recipient_id', ['member-a', 'member-b']],
    })
    // The narrow predicate is GONE — it is what broke marking a foreign row read.
    expect(calls).not.toContainEqual({ method: 'eq', args: ['recipient_id', 'member-a'] })
    // And no per-workspace member lookup is needed to answer the question.
    expect(hoisted.calls.some((c) => c.table === 'member')).toBe(false)
  })

  /** A `notification` table that behaves like the database: the row comes back
   *  only when the recipient predicate the route applied actually covers it. */
  function addressedTo(recipientId: string) {
    return {
      singleFn: (calls: Call[]) => {
        const filter = calls.find((c) => c.method === 'in' && c.args[0] === 'recipient_id')
        const covered = Boolean(filter && (filter.args[1] as string[]).includes(recipientId))
        return covered
          ? { data: { id: 'n-1', is_read: true, read_at: 'now', is_archived: false }, error: null }
          : { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } }
      },
    }
  }

  it("accepts a row addressed to ANOTHER of the caller's member rows", async () => {
    // member-b is the caller's row in ws-b — a workspace that is NOT active.
    // Before the widening this update matched nothing and the row stayed unread.
    hoisted.tables.notification = addressedTo('member-b')
    const res = await PATCH(patchRequest({ is_read: true }), {
      params: Promise.resolve({ id: 'n-1' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).notification.id).toBe('n-1')
  })

  it("rejects a stranger's row — the set never reaches outside the caller's memberships", async () => {
    hoisted.tables.notification = addressedTo('member-stranger')
    const res = await PATCH(patchRequest({ is_read: true }), {
      params: Promise.resolve({ id: 'n-1' }),
    })
    // The widened set is EXACTLY the caller's own member rows, so the update
    // matches nothing and surfaces as PostgREST's single-row error — the same
    // shape a foreign id produced before, unchanged by the widening. (The DB's
    // own RLS, notification_update in migration 031, rejects it regardless.)
    expect(res.status).toBe(500)
    const inCall = callsFor('notification').find((c) => c.method === 'in')!
    expect(inCall.args[1]).toEqual(['member-a', 'member-b'])
  })

  it('403s a caller with no memberships rather than emitting an empty `in`', async () => {
    hoisted.memberIds = []
    const res = await PATCH(patchRequest({ is_read: true }), {
      params: Promise.resolve({ id: 'n-1' }),
    })
    expect(res.status).toBe(403)
    expect(hoisted.calls.some((c) => c.table === 'notification')).toBe(false)
  })

  it('still rejects an empty update body before touching anything', async () => {
    const res = await PATCH(patchRequest({}), { params: Promise.resolve({ id: 'n-1' }) })
    expect(res.status).toBe(400)
    expect(hoisted.calls.some((c) => c.table === 'notification')).toBe(false)
  })
})
