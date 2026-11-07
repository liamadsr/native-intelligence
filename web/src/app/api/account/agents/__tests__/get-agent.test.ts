/**
 * GET /api/account/agents/[id] — the single-agent read the chat panel uses to
 * pin a live-capture conversation to the agent listening in on the call
 * (fetchAgentOption in chat-panel.tsx). It must be scoped exactly like the
 * list — system agents plus this workspace's own, category 'agent' only — so
 * the chat can pin any agent the picker could show, and nothing else.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse, type NextRequest } from 'next/server'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
}))

vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  requireWorkspace: hoisted.requireWorkspace,
}))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

import { GET } from '@/app/api/account/agents/[id]/route'

/** Every builder call the route makes, in order: [method, args]. */
let calls: Array<[string, unknown[]]> = []
let result: { data: unknown; error: unknown } = { data: null, error: null }

/** A chainable Supabase fake that records calls; `.maybeSingle()` resolves to `result`. */
function query() {
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === 'maybeSingle') return () => Promise.resolve(result)
      if (prop === 'then') return undefined
      return (...args: unknown[]) => {
        calls.push([prop, args])
        return new Proxy({}, handler)
      }
    },
  }
  return new Proxy({}, handler)
}

const request = new Request('http://localhost/api/account/agents/rec-live') as unknown as NextRequest
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  calls = []
  result = { data: null, error: null }
  hoisted.requireWorkspace.mockResolvedValue({
    user: { id: 'user-1', email: 'm@dial8.ai' },
    workspaceId: 'ws-1',
    supabase: {
      from: (table: string) => {
        calls.push(['from', [table]])
        return query()
      },
    },
  })
})

describe('GET /api/account/agents/[id]', () => {
  it('returns the agent under `agent`, the shape the chat pins', async () => {
    result = {
      data: {
        id: 'rec-live',
        name: 'Live Sales Copilot',
        icon: 'headset',
        color: null,
        description: 'Your second brain on a live sales call',
        agent_config: { enabled_tools: ['crm'] },
      },
      error: null,
    }

    const res = await GET(request, params('rec-live'))

    expect(res.status).toBe(200)
    const { agent } = await res.json()
    expect(agent).toEqual(expect.objectContaining({ id: 'rec-live', name: 'Live Sales Copilot' }))
    expect(agent.agent_config).toEqual({ enabled_tools: ['crm'] })
  })

  it('scopes the read like the list: this id, agents only, system or this workspace', async () => {
    result = { data: { id: 'rec-live' }, error: null }

    await GET(request, params('rec-live'))

    expect(calls).toContainEqual(['from', ['recipe']])
    expect(calls).toContainEqual(['eq', ['id', 'rec-live']])
    expect(calls).toContainEqual(['eq', ['category', 'agent']])
    expect(calls).toContainEqual(['or', ['is_system.eq.true,workspace_id.eq.ws-1']])
  })

  it("404s an agent this workspace can't see", async () => {
    const res = await GET(request, params('another-workspaces-agent'))
    expect(res.status).toBe(404)
  })

  it('500s on a query error', async () => {
    result = { data: null, error: { message: 'boom' } }
    const res = await GET(request, params('rec-live'))
    expect(res.status).toBe(500)
  })

  it('passes an auth failure straight through', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    )
    const res = await GET(request, params('rec-live'))
    expect(res.status).toBe(401)
    expect(calls).toEqual([])
  })
})
