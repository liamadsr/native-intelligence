/**
 * GET /api/account/email/threads lists the CURRENT workspace's copy of each
 * thread. A mailbox linked to two workspaces keeps a copy per workspace (each
 * with that workspace's own contact link and labels), and scoping by account
 * alone listed both: the same thread twice on a page, which left rows stuck on
 * screen across a folder switch, and every folder's count doubled.
 *
 * The query builder is an in-memory fake that applies the filters the route
 * chains, so the test reads which rows come back, not which methods ran.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>
let rows: Row[] = []
let holds: Row[] = []

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = []
  let from = 0
  let to = Infinity
  const builder = {
    select: () => builder,
    eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), builder),
    in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), builder),
    order: () => builder,
    limit: () => builder,
    range: (a: number, b: number) => ((from = a), (to = b), builder),
    then: (resolve: (r: unknown) => unknown) => {
      if (table === 'email_hold') return Promise.resolve({ data: holds.filter((r) => filters.every((f) => f(r))), error: null }).then(resolve)
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

const thread = (id: string, workspace_id: string, provider_thread_id: string, folder: string): Row => ({
  id, workspace_id, provider_thread_id, folder, user_id: 'u1', account_id: 'acct-1',
})

async function list(folder: string) {
  const res = await GET(new Request(`http://x/api/account/email/threads?folder=${folder}`) as unknown as NextRequest)
  const body = await res.json()
  return { ids: body.threads.map((t: Row) => t.id), total: body.total, threads: body.threads as Row[] }
}

beforeEach(() => {
  holds = []
  rows = [
    thread('a-inbox-1', 'ws-a', 'thr-1', 'inbox'),
    thread('b-inbox-1', 'ws-b', 'thr-1', 'inbox'),
    thread('a-inbox-2', 'ws-a', 'thr-2', 'inbox'),
    thread('a-draft-3', 'ws-a', 'thr-3', 'drafts'),
    thread('b-draft-3', 'ws-b', 'thr-3', 'drafts'),
  ]
})

describe('GET /api/account/email/threads', () => {
  it("lists one copy of a thread kept in two workspaces: this workspace's", async () => {
    expect(await list('inbox')).toMatchObject({ ids: ['a-inbox-1', 'a-inbox-2'], total: 2 })
  })

  it('counts each draft once', async () => {
    expect(await list('drafts')).toMatchObject({ ids: ['a-draft-3'], total: 1 })
  })

  it('"To review" lists the held threads, their subject from the hold (no live call)', async () => {
    holds = [
      { id: 'h1', user_id: 'u1', workspace_id: 'ws-a', provider_thread_id: 'thr-2', account_id: 'acct-1', subject: 'Pricing', trust: null, drafts: [{ stale: true }] },
      { id: 'h2', user_id: 'u2', workspace_id: 'ws-a', provider_thread_id: 'thr-1', account_id: 'acct-1', subject: 'Not mine', trust: null, drafts: [] },
    ]
    const out = await list('review')
    expect(out.ids).toEqual(['a-inbox-2'])
    expect(out.threads[0]).toMatchObject({ held: true, held_subject: 'Pricing', held_stale: true })
    // In the inbox too, a held row carries its hold's subject.
    const inbox = await list('inbox')
    expect(inbox.threads.find((t) => t.id === 'a-inbox-2')).toMatchObject({ held: true, held_subject: 'Pricing' })
    expect(inbox.threads.find((t) => t.id === 'a-inbox-1')).not.toHaveProperty('held')
  })

  it('"To review" is empty with nothing held', async () => {
    expect(await list('review')).toMatchObject({ ids: [], total: 0 })
  })
})
