import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The blocked-sites API (Blocked sites in the live view) and the claim that hands the list
 * to the browser relay with every command (the shared handler the cloud
 * relay's route uses; a desktop can no longer claim).
 */
const mock = vi.hoisted(() => ({
  user: 'user' as string | null,
  rows: [] as { user_id: string; site: string; created_at: string }[],
  failRead: false,
  claimed: null as Record<string, unknown> | null,
}))

/** A tiny query builder over `mock.rows` (one user's rows, oldest first). */
function db() {
  return {
    from: (table: string) => {
      const filters: [string, unknown][] = []
      let op: 'select' | 'delete' | 'update' = 'select'
      const q: Record<string, unknown> = {
        select: () => q,
        eq: (key: string, value: unknown) => {
          filters.push([key, value])
          return q
        },
        gt: () => q,
        order: () => q,
        update: () => {
          op = 'update'
          return q
        },
        delete: () => {
          op = 'delete'
          return q
        },
        upsert: async (row: { user_id: string; site: string }) => {
          if (!mock.rows.some((r) => r.user_id === row.user_id && r.site === row.site))
            mock.rows.push({ ...row, created_at: new Date(Date.now() + mock.rows.length).toISOString() })
          return { error: null }
        },
        limit: async () => {
          if (mock.failRead) return { data: null, error: { message: 'down' } }
          const match = (r: Record<string, unknown>) => filters.every(([k, v]) => r[k] === v)
          return { data: mock.rows.filter(match).map((r) => ({ site: r.site })), error: null }
        },
        maybeSingle: async () => (table === 'browser_command_queue' && op === 'update' ? { data: mock.claimed, error: null } : { data: null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (op === 'delete') mock.rows = mock.rows.filter((r) => !filters.every(([k, v]) => (r as Record<string, unknown>)[k] === v))
          return Promise.resolve({ error: null }).then(resolve)
        },
      }
      return q
    },
  }
}

vi.mock('@/lib/api-auth', () => ({
  requireUser: async () => (mock.user ? { user: { id: mock.user }, supabase: db() } : new Response('', { status: 401 })),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: mock.user ? { id: mock.user } : null } }) } }),
}))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => db() }))
vi.mock('@/lib/cloud-browser/store', () => ({ readDriver: async () => 'agent' }))

import { DELETE, GET, POST } from '../blocked-sites/route'
import { claimBrowserCommand } from '@/lib/browser-agent/command-handlers'

const json = (method: string, body: unknown) =>
  new Request('http://localhost/api/account/browser/blocked-sites', { method, body: JSON.stringify(body) })

beforeEach(() => {
  mock.user = 'user'
  mock.rows = [{ user_id: 'other', site: 'secret.test', created_at: '2026-01-01' }]
  mock.failRead = false
  mock.claimed = { id: 'cmd', command: 'read_page' }
})

describe('blocked sites API', () => {
  it('lists only this user’s sites', async () => {
    mock.rows.push({ user_id: 'user', site: 'linkedin.com', created_at: '2026-01-02' })
    expect(await (await GET()).json()).toEqual({ sites: ['linkedin.com'] })
  })

  it('blocks a typed site or URL as its normalized entry, once', async () => {
    expect(await (await POST(json('POST', { site: 'https://www.LinkedIn.com/feed' }))).json()).toEqual({ sites: ['linkedin.com'] })
    expect(await (await POST(json('POST', { site: 'linkedin.com' }))).json()).toEqual({ sites: ['linkedin.com'] })
  })

  it('refuses something that is not a site', async () => {
    expect((await POST(json('POST', { site: 'linkedin' }))).status).toBe(400)
    expect((await POST(json('POST', {}))).status).toBe(400)
  })

  it('unblocks only this user’s entry', async () => {
    await POST(json('POST', { site: 'secret.test' }))
    expect(await (await DELETE(json('DELETE', { site: 'secret.test' }))).json()).toEqual({ sites: [] })
    expect(mock.rows.some((r) => r.user_id === 'other' && r.site === 'secret.test')).toBe(true)
  })

  it('needs a signed-in user', async () => {
    mock.user = null
    expect((await GET()).status).toBe(401)
  })
})

describe('claiming a browser command', () => {
  const claim = () => claimBrowserCommand({ userId: 'user', deviceId: 'cloud:browser-x', workspaceId: 'ws' }, 'cmd')

  it('hands over the user’s blocked sites with the command', async () => {
    mock.rows.push({ user_id: 'user', site: 'linkedin.com', created_at: '2026-01-02' })
    const body = await (await claim()).json()
    expect(body.command).toEqual(mock.claimed)
    expect(body.blockedSites).toContain('linkedin.com')
    expect(body.driver).toBe('agent')
  })

  it('always blocks Dial8’s own app for the agent (A5: it can never click Approve)', async () => {
    const body = await (await claim()).json()
    expect(body.blockedSites).toEqual(expect.arrayContaining(['dial8.ai', 'localhost', '127.0.0.1']))
  })

  it('claims nothing when the list cannot be read', async () => {
    mock.failRead = true
    const res = await claim()
    expect(res.status).toBe(503)
  })
})
