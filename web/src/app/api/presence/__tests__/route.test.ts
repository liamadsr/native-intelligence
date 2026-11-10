/**
 * POST /api/presence (src/app/api/presence/route.ts): requireUser (a 401
 * signed out, a capture-device token refused), the body read as text so a
 * sendBeacon's text/plain parses, a 400 for anything off-shape, and on a good
 * ping one upsert (active_at only for `active`) plus the seen update when it
 * rides along, answered 204.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  user: 'user-1' as string | null,
  calls: [] as { table: string; ops: [string, ...unknown[]][] }[],
  error: null as { message: string } | null,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: m.user ? { id: m.user } : null } }) } }),
}))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const call = { table, ops: [] as [string, ...unknown[]][] }
      m.calls.push(call)
      const chain: Record<string, unknown> = new Proxy({} as Record<string, unknown>, {
        get(_target, prop: string) {
          if (prop === 'then') return (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: m.error }).then(resolve)
          return (...args: unknown[]) => {
            call.ops.push([prop, ...args])
            return chain
          }
        },
      })
      return chain
    },
  }),
}))

import { POST } from '../route'

const CLIENT = 'a1b2c3d4e5f6a7b8'
const CONV = '11111111-2222-4333-8444-555555555555'

const post = (body: unknown, init: { contentType?: string; authorization?: string; raw?: boolean } = {}) =>
  new Request('http://localhost/api/presence', {
    method: 'POST',
    headers: {
      'content-type': init.contentType ?? 'application/json',
      ...(init.authorization ? { authorization: init.authorization } : {}),
    },
    body: init.raw ? (body as string) : JSON.stringify(body),
  })

beforeEach(() => {
  m.user = 'user-1'
  m.calls = []
  m.error = null
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

describe('POST /api/presence', () => {
  it('401 signed out, writing nothing', async () => {
    m.user = null
    const res = await POST(post({ clientId: CLIENT, surface: 'web', state: 'active' }))
    expect(res.status).toBe(401)
    expect(m.calls).toEqual([])
  })

  it('refuses a capture-device token before it resolves anyone', async () => {
    const res = await POST(post({ clientId: CLIENT, surface: 'web', state: 'active' }, { authorization: 'Bearer nid_abcdefghijklmnop' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'DEVICE_TOKEN_REFUSED' })
    expect(m.calls).toEqual([])
  })

  it('400 for a body that is not JSON, too large, or off-shape', async () => {
    expect((await POST(post('{not json', { raw: true }))).status).toBe(400)
    expect((await POST(post('', { raw: true }))).status).toBe(400)
    expect((await POST(post({ clientId: CLIENT, surface: 'web', state: 'active', pad: 'x'.repeat(5000) }))).status).toBe(400)
    expect((await POST(post({ clientId: 'no', surface: 'web', state: 'active' }))).status).toBe(400)
    const hidden = await POST(post({ clientId: CLIENT, surface: 'web', state: 'hidden' }))
    expect(hidden.status).toBe(400)
    expect(await hidden.json()).toMatchObject({ error: expect.stringContaining('state'), code: 'BAD_REQUEST' })
    expect((await POST(post({ clientId: CLIENT, surface: 'web', state: 'active', seen: { conversationId: 'x', through: 'y' } }))).status).toBe(400)
    expect(m.calls).toEqual([])
  })

  it('204 on a good ping: one upsert, active sets active_at', async () => {
    const res = await POST(post({ clientId: CLIENT, surface: 'web', state: 'active' }))
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    expect(m.calls).toHaveLength(1)
    const [op, row, options] = m.calls[0].ops[0]
    expect(m.calls[0].table).toBe('user_presence')
    expect(op).toBe('upsert')
    expect(row).toMatchObject({ user_id: 'user-1', client_id: CLIENT, surface: 'web', state: 'active', active_at: expect.any(String), updated_at: expect.any(String) })
    expect(options).toEqual({ onConflict: 'user_id,client_id' })
  })

  it("idle doesn't touch active_at", async () => {
    const res = await POST(post({ clientId: CLIENT, surface: 'desktop', state: 'idle' }))
    expect(res.status).toBe(204)
    const row = m.calls[0].ops[0][1] as Record<string, unknown>
    expect(row).toMatchObject({ state: 'idle', surface: 'desktop' })
    expect('active_at' in row).toBe(false)
  })

  it('accepts a text/plain body (navigator.sendBeacon)', async () => {
    const res = await POST(post({ clientId: CLIENT, surface: 'web', state: 'active' }, { contentType: 'text/plain;charset=UTF-8' }))
    expect(res.status).toBe(204)
    expect(m.calls).toHaveLength(1)
  })

  it('a ping with a seen also moves the home thread marker, for this person only', async () => {
    const through = new Date(Date.now() - 60_000).toISOString()
    const res = await POST(post({ clientId: CLIENT, surface: 'web', state: 'active', seen: { conversationId: CONV, through } }))
    expect(res.status).toBe(204)
    expect(m.calls.map((c) => c.table)).toEqual(['user_presence', 'chat_conversations'])
    expect(m.calls[1].ops).toEqual([
      ['update', { seen_at: through }],
      ['eq', 'id', CONV],
      ['eq', 'user_id', 'user-1'],
      ['eq', 'is_home', true],
      ['or', `seen_at.is.null,seen_at.lt.${through}`],
    ])
  })

  it("a seen-only ping (a desktop window other than main) moves the marker and never touches the row's state", async () => {
    const through = new Date(Date.now() - 60_000).toISOString()
    const res = await POST(post({ clientId: CLIENT, surface: 'desktop', seen: { conversationId: CONV, through } }))
    expect(res.status).toBe(204)
    expect(m.calls.map((c) => c.table)).toEqual(['chat_conversations'])
    // A ping with neither a state nor a seen says nothing: refused.
    expect((await POST(post({ clientId: CLIENT, surface: 'desktop' }))).status).toBe(400)
  })

  it('a failed write is a 500 in the api-errors shape', async () => {
    m.error = { message: 'relation "user_presence" does not exist' }
    const res = await POST(post({ clientId: CLIENT, surface: 'web', state: 'active' }))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Internal server error', code: 'INTERNAL' })
  })
})
