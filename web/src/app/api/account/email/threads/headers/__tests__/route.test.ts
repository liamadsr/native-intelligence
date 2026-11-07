/**
 * POST /api/account/email/threads/headers: reads only the caller's own rows in
 * the current workspace, at most 50, and hands them to ONE fetchThreadHeaders
 * call (one batched provider call per mailbox).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

let db: FakeSupabase
const fetchThreadHeaders = vi.fn(async (..._a: unknown[]) => ({ a1: { subject: 'Live', snippet: null, from_name: null } }))

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: async () => ({ supabase: db, user: { id: 'u1' }, workspaceId: 'ws-a' }) }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/email/thread-headers', () => ({ fetchThreadHeaders, HEADERS_MAX_ROWS: 50 }))

const { POST } = await import('../route')

const post = (ids: unknown) =>
  POST(new Request('http://x/api/account/email/threads/headers', { method: 'POST', body: JSON.stringify({ ids }) }) as never)

beforeEach(() => {
  db = makeFakeSupabase()
  fetchThreadHeaders.mockClear()
  db.seed('email_thread_index', [
    { id: 'a1', user_id: 'u1', workspace_id: 'ws-a', account_id: 'acc', provider: 'google', provider_thread_id: 't1', provider_message_id: 'm1' },
    { id: 'b1', user_id: 'u2', workspace_id: 'ws-a', account_id: 'acc2', provider: 'google', provider_thread_id: 't2', provider_message_id: 'm2' },
    { id: 'c1', user_id: 'u1', workspace_id: 'ws-b', account_id: 'acc', provider: 'google', provider_thread_id: 't3', provider_message_id: 'm3' },
  ])
})

describe('POST /api/account/email/threads/headers', () => {
  it("fills only the caller's own rows here, in one call", async () => {
    const res = await post(['a1', 'b1', 'c1'])
    expect(await res.json()).toEqual({ headers: { a1: { subject: 'Live', snippet: null, from_name: null } } })
    expect(fetchThreadHeaders).toHaveBeenCalledTimes(1)
    const [, args] = fetchThreadHeaders.mock.calls[0] as [unknown, { rows: Array<{ id: string }> }]
    expect(args.rows.map((r) => r.id)).toEqual(['a1'])
  })

  it('asks for at most 50 ids, and nothing for none', async () => {
    await post(Array.from({ length: 80 }, (_, i) => `x${i}`))
    const filters = db.calls.filter((c) => c.table === 'email_thread_index').flatMap((c) => c.filters).find(([col]) => col === 'id')
    expect((filters?.[1] as string[]).length).toBe(50)
    fetchThreadHeaders.mockClear()
    expect(await (await post([])).json()).toEqual({ headers: {} })
    expect(fetchThreadHeaders).not.toHaveBeenCalled()
  })
})
