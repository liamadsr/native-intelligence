/**
 * GET /api/account/chat-history/[id] — newest-first paging (A3: a months-long
 * home thread loads a page at a time; src/lib/chat/history-page.ts).
 *
 * Pinned: `?limit=N` answers the newest N messages oldest first with
 * `hasMore`; `&before=<ui message id>` answers the page before that message
 * (ties on created_at broken by row id), walking back to the start with no
 * gap or repeat; an unknown cursor answers an empty page; no `limit` answers
 * the whole thread with no `hasMore`, as before; every read is scoped to the
 * caller and workspace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseHistoryPage, HISTORY_PAGE_MAX } from '@/lib/chat/history-page'

type Row = { id: string; conversation_id: string; user_id: string; workspace_id: string; created_at: string; ui_message_id: string; ui_message: { id: string } }

const hoisted = vi.hoisted(() => ({
  rows: [] as Row[],
  conv: { title: 'Home', is_home: true } as Record<string, unknown> | null,
  eqs: [] as Array<[string, unknown]>,
}))

/** Applies `created_at.lt."X",and(created_at.eq."X",id.lt.Y)`, the only or-filter the page read writes. */
function orFilter(expr: string): (r: Row) => boolean {
  const m = /^created_at\.lt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.lt\.([^)]+)\)$/.exec(expr)
  if (!m) throw new Error(`unexpected or filter: ${expr}`)
  const [, ts, ts2, id] = m
  return (r) => r.created_at < ts || (r.created_at === ts2 && r.id < id)
}

vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: string) => {
      const preds: Array<(r: Row) => boolean> = []
      const orders: Array<{ col: keyof Row; asc: boolean }> = []
      let limitN = Infinity
      const run = () => {
        const rows = hoisted.rows.filter((r) => preds.every((p) => p(r)))
        rows.sort((a, b) => {
          for (const o of orders) {
            const d = String(a[o.col]).localeCompare(String(b[o.col]))
            if (d) return o.asc ? d : -d
          }
          return 0
        })
        return rows.slice(0, limitN)
      }
      const c: Record<string, unknown> = {}
      c.select = () => c
      c.eq = (col: string, v: unknown) => {
        if (table === 'chat_messages') {
          hoisted.eqs.push([col, v])
          preds.push((r) => (r as unknown as Record<string, unknown>)[col] === v)
        }
        return c
      }
      c.or = (expr: string) => (preds.push(orFilter(expr)), c)
      c.order = (col: keyof Row, o: { ascending: boolean }) => (orders.push({ col, asc: o.ascending }), c)
      c.limit = (n: number) => ((limitN = n), c)
      c.maybeSingle = async () => (table === 'chat_conversations' ? { data: hoisted.conv, error: null } : { data: run()[0] ?? null, error: null })
      c.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve)
      return c
    },
  }),
}))

const { GET } = await import('../route')

const get = async (query = '') => {
  const res = await GET(new Request(`http://localhost/api/account/chat-history/home-1${query}`) as never, { params: Promise.resolve({ id: 'home-1' }) })
  return (await res.json()) as { messages: Array<{ id: string }>; hasMore?: boolean; isHome?: boolean }
}
const ids = (body: { messages: Array<{ id: string }> }) => body.messages.map((m) => m.id)

beforeEach(() => {
  hoisted.eqs.length = 0
  hoisted.conv = { title: 'Home', is_home: true }
  // m00..m24, two pairs sharing a created_at (ties broken by row id).
  hoisted.rows = Array.from({ length: 25 }, (_, i) => {
    const n = String(i).padStart(2, '0')
    const second = i === 11 || i === 12 ? 10 : i
    return {
      id: `r${n}`,
      conversation_id: 'home-1',
      user_id: 'user-1',
      workspace_id: 'ws-1',
      created_at: `2026-10-01T00:00:${String(second).padStart(2, '0')}.000000+00:00`,
      ui_message_id: `m${n}`,
      ui_message: { id: `m${n}` },
    }
  })
  // Another person's message in the same conversation id never shows.
  hoisted.rows.push({ ...hoisted.rows[24], id: 'rzz', user_id: 'user-2', ui_message_id: 'theirs', ui_message: { id: 'theirs' } })
})

describe('GET /api/account/chat-history/[id] — paging', () => {
  it('?limit answers the newest page oldest first, with hasMore', async () => {
    const body = await get('?limit=10')
    expect(ids(body)).toEqual(['m15', 'm16', 'm17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24'])
    expect(body.hasMore).toBe(true)
    expect(body).not.toHaveProperty('isHome')
    expect(hoisted.eqs).toEqual(expect.arrayContaining([['conversation_id', 'home-1'], ['user_id', 'user-1'], ['workspace_id', 'ws-1']]))
  })

  it('walks back with before= to the start, with no gap or repeat (ties included)', async () => {
    const seen: string[] = []
    let body = await get('?limit=7')
    seen.unshift(...ids(body))
    while (body.hasMore) {
      body = await get(`?limit=7&before=${seen[0]}`)
      seen.unshift(...ids(body))
    }
    expect(seen).toEqual(Array.from({ length: 25 }, (_, i) => `m${String(i).padStart(2, '0')}`))
  })

  it('an unknown cursor answers an empty page', async () => {
    expect(await get('?limit=10&before=nope')).toMatchObject({ messages: [], hasMore: false })
  })

  it('without limit answers the whole thread, as before, with no hasMore', async () => {
    const body = await get()
    expect(ids(body)).toHaveLength(25)
    expect(body).not.toHaveProperty('hasMore')
  })

  it('each message carries its row\'s time as metadata.createdAt, paged or whole (the day lines)', async () => {
    for (const body of [await get('?limit=3'), await get()]) {
      const last = body.messages[body.messages.length - 1] as { id: string; metadata?: { createdAt?: string } }
      expect(last.metadata?.createdAt).toBe('2026-10-01T00:00:24.000000+00:00')
    }
  })

  it('a time the message already carries (its send) stands', async () => {
    hoisted.rows[24].ui_message = { id: 'm24', metadata: { createdAt: '2026-09-30T23:59:59.000Z' } } as never
    const body = await get('?limit=1')
    expect((body.messages[0] as { metadata?: { createdAt?: string } }).metadata?.createdAt).toBe('2026-09-30T23:59:59.000Z')
  })

})

describe('parseHistoryPage', () => {
  it('reads limit and before, clamps the limit, and is null without limit', () => {
    expect(parseHistoryPage(new URLSearchParams(''))).toBeNull()
    expect(parseHistoryPage(new URLSearchParams('limit=50&before=m1'))).toEqual({ limit: 50, before: 'm1' })
    expect(parseHistoryPage(new URLSearchParams('limit=99999'))!.limit).toBe(HISTORY_PAGE_MAX)
    expect(parseHistoryPage(new URLSearchParams('limit=0'))!.limit).toBe(1)
  })
})
