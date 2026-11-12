/**
 * GET /api/account/email/threads?label_id=… lists only the threads wearing
 * that label (Liam, 11-11: the Mail sub-nav's Tags, "any tags that are
 * available for email"): this workspace's threads inner-joined to the label's
 * rows in email_thread_label (never an id list in the URL: a label on
 * hundreds of threads overran it), in the folder asked (a tag asks `all`:
 * every folder but Spam and Trash), the rows shaped as without a tag. A
 * label on no thread lists nothing; a malformed id is refused. With a
 * search, the provider's hits wearing it: a page with none of them (and
 * more after it) is read past, up to five pages. Fixtures are made up.
 *
 * The query builder is an in-memory fake that applies the filters the route
 * chains, as route.test.ts's, the inner join included.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>
let rows: Row[] = []
let tags: Row[] = []
const asked: string[] = []
/** Every `.in()` the route chained on the thread list: column and how many values. */
const inLists: Array<[string, number]> = []

function query(table: string) {
  asked.push(table)
  const filters: ((r: Row) => boolean)[] = []
  let from = 0
  let to = Infinity
  let joinsLabels = false
  const builder = {
    select: (cols?: string) => ((joinsLabels = table === 'email_thread_index' && !!cols?.includes('email_thread_label!inner(label_id)')), builder),
    eq: (k: string, v: unknown) => {
      if (k === 'email_thread_label.label_id') {
        // The inner join's filter: only threads with a row of that label (as PostgREST's !inner).
        if (!joinsLabels) throw new Error('a filter on the join without the join')
        filters.push((r) => tags.some((t) => t.thread_id === r.id && t.label_id === v))
      } else filters.push((r) => r[k] === v)
      return builder
    },
    in: (k: string, vs: unknown[]) => {
      if (table === 'email_thread_index') inLists.push([k, vs.length])
      filters.push((r) => vs.includes(r[k]))
      return builder
    },
    not: (k: string, op: string, v: string) => {
      const out = v.replace(/[()]/g, '').split(',')
      filters.push((r) => !(op === 'in' && out.includes(r[k] as string)))
      return builder
    },
    order: () => builder,
    limit: () => builder,
    range: (a: number, b: number) => ((from = a), (to = b), builder),
    then: (resolve: (r: unknown) => unknown) => {
      if (table === 'email_thread_label') {
        // Only the label filter: the join's rows for the threads asked, or the label's rows.
        return Promise.resolve({ data: tags.filter((r) => filters.every((f) => f(r))), error: null }).then(resolve)
      }
      if (table !== 'email_thread_index') return Promise.resolve({ data: [], error: null }).then(resolve)
      const matched = rows.filter((r) => filters.every((f) => f(r)))
      const page = matched.slice(from, to + 1).map((r) => (joinsLabels ? { ...r, email_thread_label: [{ label_id: 'joined' }] } : r))
      return Promise.resolve({ data: page, count: matched.length, error: null }).then(resolve)
    },
  }
  return builder
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u1' } } }) },
    from: query,
  }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-a' }))
vi.mock('@/lib/email/account-scope', () => ({ getWorkspaceEmailAccountIds: async () => ['acct-1'] }))
// The provider's search, a page per cursor: `searchPages[n]` is page n's hits (the thread ids), a cursor while there are more.
let searchPages: string[][] = []
const searched: Array<string | null> = []
vi.mock('@/lib/email/live-thread-search', () => ({
  searchThreadsLive: async (_u: string, _w: string, opts: { cursor?: string | null }) => {
    searched.push(opts.cursor ?? null)
    const n = opts.cursor ? Number(opts.cursor.slice(1)) : 0
    return { hits: (searchPages[n] ?? []).map((id) => ({ id })), cursor: n + 1 < searchPages.length ? `p${n + 1}` : null, accounts: [] }
  },
}))
vi.mock('@/lib/email/search-result-rows', () => ({
  searchResultRows: async (_s: unknown, args: { hits: Array<{ id: string }> }) =>
    args.hits.map((h) => ({ id: h.id, labels: tags.filter((t) => t.thread_id === h.id).map((t) => ({ id: t.label_id })) })),
}))

import { GET } from '../route'
import type { NextRequest } from 'next/server'

const LABEL_CLIENT = '11111111-1111-4111-8111-111111111111'
const LABEL_UNUSED = '22222222-2222-4222-8222-222222222222'

const thread = (id: string, folder: string, workspace_id = 'ws-a'): Row => ({
  id, workspace_id, provider_thread_id: `p-${id}`, folder, user_id: 'u1', account_id: 'acct-1',
})

async function list(params: string) {
  const res = await GET(new Request(`http://x/api/account/email/threads?${params}`) as unknown as NextRequest)
  const body = await res.json()
  return { status: res.status, ids: (body.threads ?? []).map((t: Row) => t.id), total: body.total, body }
}

beforeEach(() => {
  asked.length = 0
  inLists.length = 0
  searched.length = 0
  searchPages = []
  rows = [
    thread('t-inbox', 'inbox'),
    thread('t-archive', 'archive'),
    thread('t-spam', 'spam'),
    thread('t-other', 'inbox'),
    thread('t-elsewhere', 'inbox', 'ws-b'),
  ]
  tags = [
    { thread_id: 't-inbox', label_id: LABEL_CLIENT },
    { thread_id: 't-archive', label_id: LABEL_CLIENT },
    { thread_id: 't-spam', label_id: LABEL_CLIENT },
    { thread_id: 't-elsewhere', label_id: LABEL_CLIENT },
  ]
})

describe('GET /api/account/email/threads with a label', () => {
  it('lists only the threads wearing it, in every folder but Spam and Trash, this workspace’s copies', async () => {
    expect(await list(`folder=all&label_id=${LABEL_CLIENT}`)).toMatchObject({ status: 200, ids: ['t-inbox', 't-archive'], total: 2 })
  })

  it('in one folder, that folder’s', async () => {
    expect(await list(`folder=inbox&label_id=${LABEL_CLIENT}`)).toMatchObject({ ids: ['t-inbox'], total: 1 })
  })

  it('a label on no thread: nothing', async () => {
    expect(await list(`folder=all&label_id=${LABEL_UNUSED}`)).toMatchObject({ status: 200, ids: [], total: 0 })
  })

  it('a malformed id is refused, before any read', async () => {
    expect((await list('folder=all&label_id=not-a-uuid')).status).toBe(400)
    expect(asked).toEqual([])
  })

  it('without one, the list is as before', async () => {
    expect(await list('folder=inbox')).toMatchObject({ ids: ['t-inbox', 't-other'], total: 2 })
  })

  it('joins the label in the list’s own query, never an id list in the URL, however many threads wear it; the rows shaped as without a tag', async () => {
    rows = Array.from({ length: 600 }, (_, i) => thread(`t-${i}`, 'inbox'))
    tags = rows.map((r) => ({ thread_id: r.id, label_id: LABEL_CLIENT }))
    const { ids, total, body } = await list(`folder=all&label_id=${LABEL_CLIENT}&per_page=50`)
    expect(ids).toHaveLength(50)
    expect(total).toBe(600)
    expect(body.has_more).toBe(true)
    expect(inLists.filter(([k]) => k === 'id')).toEqual([])
    for (const t of body.threads as Row[]) expect(t).not.toHaveProperty('email_thread_label')
    expect(Object.keys((body.threads as Row[])[0])).toContain('labels')
  })
})

describe('GET /api/account/email/threads with a label and a search', () => {
  it('reads past provider pages with no tagged hit, to the first with one', async () => {
    searchPages = [['t-other'], ['t-other'], ['t-archive', 't-other'], ['t-inbox']]
    const { ids, body } = await list(`folder=all&label_id=${LABEL_CLIENT}&search=quote`)
    expect(searched).toEqual([null, 'p1', 'p2'])
    expect(ids).toEqual(['t-archive'])
    expect(body).toMatchObject({ has_more: true, cursor: 'p3', source: 'provider' })
  })

  it('stops at the last page: nothing tagged, nothing more', async () => {
    searchPages = [['t-other'], ['t-other']]
    const { ids, body } = await list(`folder=all&label_id=${LABEL_CLIENT}&search=quote`)
    expect(searched).toEqual([null, 'p1'])
    expect(ids).toEqual([])
    expect(body).toMatchObject({ has_more: false, cursor: null })
  })

  it('reads five pages at the most; past them, its cursor for the rest', async () => {
    searchPages = Array.from({ length: 8 }, () => ['t-other'])
    const { ids, body } = await list(`folder=all&label_id=${LABEL_CLIENT}&search=quote`)
    expect(searched).toHaveLength(5)
    expect(ids).toEqual([])
    expect(body).toMatchObject({ has_more: true, cursor: 'p5' })
  })

  it('without a tag, one provider page, as before', async () => {
    searchPages = [['t-other'], ['t-inbox']]
    const { ids, body } = await list('folder=all&search=quote')
    expect(searched).toEqual([null])
    expect(ids).toEqual(['t-other'])
    expect(body.cursor).toBe('p1')
  })
})
