/**
 * GET /api/account/actions — the "assigned to me" scope runs through an inner
 * embed on action_assignee (never an id list in the URL), and the
 * comment-count / has_children enrichment chunks the listed ids.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

type Call = [table: string, method: string, ...args: unknown[]]

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  calls: [] as Call[],
  // Per-table terminal results.
  results: new Map<string, unknown>(),
}))

function recordingChain(table: string) {
  const chain: Record<string, unknown> = {}
  const proxy: unknown = new Proxy(chain, {
    get(_t, prop: string) {
      if (prop === 'then') {
        return (cb: (v: unknown) => unknown) =>
          Promise.resolve(hoisted.results.get(table) ?? { data: [], error: null, count: 0 }).then(cb)
      }
      return (...args: unknown[]) => {
        hoisted.calls.push([table, prop, ...args])
        return proxy
      }
    },
  })
  return proxy
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspaceMember,
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

const { GET } = await import('@/app/api/account/actions/route')

function getReq(query = ''): NextRequest {
  const req = buildRequest({ url: `https://nativeintelligence.dev/api/account/actions${query}`, method: 'GET' })
  return Object.assign(req, { nextUrl: new URL(req.url) }) as unknown as NextRequest
}

const callsFor = (table: string, method: string) =>
  hoisted.calls.filter((c) => c[0] === table && c[1] === method)

beforeEach(() => {
  hoisted.calls = []
  hoisted.results.clear()
  hoisted.requireWorkspaceMember.mockResolvedValue({
    supabase: { from: (t: string) => recordingChain(t) },
    user: { id: 'user-1' },
    workspaceId: 'ws-1',
    member: { id: 'mem-1' },
  })
})

describe('GET /api/account/actions — assigned scope', () => {
  it('filters through the action_assignee inner embed, not an id list', async () => {
    hoisted.results.set('action_assignee', { data: null, error: null, count: 1500 })
    const res = await GET(getReq('?status=all'))
    expect(res.status).toBe(200)

    const [select] = callsFor('actions', 'select')
    expect(String(select[2])).toContain('assigned:action_assignee!inner(member_id)')
    expect(hoisted.calls).toContainEqual(['actions', 'eq', 'assigned.member_id', 'mem-1'])
    expect(callsFor('actions', 'in').filter((c) => c[2] === 'id')).toHaveLength(0)
  })

  it('falls back to the legacy assignee_id when the member has no join rows', async () => {
    hoisted.results.set('action_assignee', { data: null, error: null, count: 0 })
    await GET(getReq('?status=all'))
    const [select] = callsFor('actions', 'select')
    expect(String(select[2])).not.toContain('!inner(member_id)')
    expect(hoisted.calls).toContainEqual(['actions', 'eq', 'assignee_id', 'mem-1'])
  })
})

describe('GET /api/account/actions — enrichment', () => {
  it('chunks the listed ids for the comment and child reads', async () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ id: `a-${i}`, due_at: null }))
    hoisted.results.set('actions', { data: rows, error: null })
    hoisted.results.set('comment', { data: [{ commentable_id: 'a-1' }], error: null })
    const res = await GET(getReq('?scope=all&status=all'))
    expect(res.status).toBe(200)

    const commentIn = callsFor('comment', 'in')
    expect(commentIn.map((c) => (c[3] as string[]).length)).toEqual([100, 100, 50])
    const childIn = callsFor('actions', 'in').filter((c) => c[2] === 'parent_id')
    expect(childIn.map((c) => (c[3] as string[]).length)).toEqual([100, 100, 50])

    const body = await readJson<{ actions: { id: string; comment_count: number }[] }>(res)
    // The fake answers every chunk with the same one comment row, so the three
    // chunks' rows are concatenated: 3 proves all chunks were merged.
    expect(body.actions.find((a) => a.id === 'a-1')?.comment_count).toBe(3)
  })

  it('answers 500 when an enrichment read fails instead of zeroing the counts', async () => {
    hoisted.results.set('actions', { data: [{ id: 'a-1' }], error: null })
    hoisted.results.set('comment', { data: null, error: { message: 'URI too long' } })
    const res = await GET(getReq('?scope=all&status=all'))
    expect(res.status).toBe(500)
  })
})
