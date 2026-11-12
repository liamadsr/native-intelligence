/**
 * GET /api/account/email/threads?label_id=… lists only the threads wearing
 * that label (Liam, 11-11: the Mail sub-nav's Tags, "any tags that are
 * available for email"): the label's rows in email_thread_label, then this
 * workspace's copies of those threads, in the folder asked (a tag asks `all`:
 * every folder but Spam and Trash). A label on no thread lists nothing; a
 * malformed id is refused. Fixtures are made up.
 *
 * The query builder is an in-memory fake that applies the filters the route
 * chains, as route.test.ts's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>
let rows: Row[] = []
let tags: Row[] = []
const asked: string[] = []

function query(table: string) {
  asked.push(table)
  const filters: ((r: Row) => boolean)[] = []
  let from = 0
  let to = Infinity
  const builder = {
    select: () => builder,
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), builder),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), builder),
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
      return Promise.resolve({ data: matched.slice(from, to + 1), count: matched.length, error: null }).then(resolve)
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
  return { status: res.status, ids: (body.threads ?? []).map((t: Row) => t.id), total: body.total }
}

beforeEach(() => {
  asked.length = 0
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
})
