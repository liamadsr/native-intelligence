/**
 * PATCH /api/account/mcp-servers/{id} with `tool_permission` (Settings ›
 * Connectors' Tool permissions): the change is applied to the row as it is
 * when the request lands, so a page loaded earlier never writes stale lists
 * back over a change made since (the agent pinning a tool to ask), and a
 * catalog app's always-ask tool is never freed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), updates: [] as Record<string, unknown>[] }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

type Row = Record<string, unknown>

function fakeSupabase(row: Row | null) {
  let pending: Record<string, unknown> | null = null
  const chain = {
    select: () => chain,
    eq: () => chain,
    update: (fields: Record<string, unknown>) => {
      pending = fields
      hoisted.updates.push(fields)
      return chain
    },
    maybeSingle: async () => {
      if (!row) return { data: null, error: null }
      if (pending) {
        Object.assign(row, pending)
        pending = null
      }
      return { data: { ...row }, error: null }
    },
  }
  return { from: () => chain }
}

function server(over: Row = {}): Row {
  return {
    id: 'srv1',
    user_id: 'user-1',
    display_name: 'Internal',
    server_url: 'https://mcp.internal.example/mcp',
    transport: 'streamable_http',
    auth_type: 'none',
    is_enabled: true,
    tools_cache: [{ name: 'get_issue' }, { name: 'create_issue' }, { name: 'delete_issue' }],
    allowed_tools: ['get_issue', 'create_issue', 'delete_issue'],
    disabled_tools: [],
    require_approval_tools: ['create_issue', 'delete_issue'],
    approval_free_tools: [],
    ...over,
  }
}

function patch(body: unknown): Promise<Response> {
  const req = buildRequest({ url: 'https://dial8.ai/api/account/mcp-servers/srv1', method: 'PATCH', body }) as unknown as NextRequest
  return PATCH(req, { params: Promise.resolve({ id: 'srv1' }) })
}

const { PATCH } = await import('@/app/api/account/mcp-servers/[id]/route')

beforeEach(() => {
  hoisted.updates.length = 0
})

describe('tool_permission', () => {
  it('applies the change to the row as it is now', async () => {
    const row = server()
    hoisted.requireWorkspace.mockResolvedValue({ supabase: fakeSupabase(row), user: { id: 'user-1' }, workspaceId: 'ws' })
    const res = await patch({ tool_permission: { tools: ['delete_issue'], permission: 'blocked' } })
    expect(res.status).toBe(200)
    expect(hoisted.updates).toEqual([
      {
        disabled_tools: ['delete_issue'],
        require_approval_tools: ['create_issue', 'delete_issue'],
        approval_free_tools: [],
        allowed_tools: ['get_issue', 'create_issue', 'delete_issue'],
      },
    ])
    const json = (await readJson(res)) as { server: Row }
    expect(json.server.disabled_tools).toEqual(['delete_issue'])
  })

  it('keeps a tightening made since the page loaded (the agent pinned get_issue to ask)', async () => {
    // The page loaded with get_issue running freely; since then the agent pinned it to ask.
    const row = server({ require_approval_tools: ['create_issue', 'delete_issue', 'get_issue'] })
    hoisted.requireWorkspace.mockResolvedValue({ supabase: fakeSupabase(row), user: { id: 'user-1' }, workspaceId: 'ws' })
    await patch({ tool_permission: { tools: ['delete_issue'], permission: 'blocked' } })
    expect(hoisted.updates[0].require_approval_tools).toContain('get_issue')
  })

  it('never frees a catalog app’s always-ask tool', async () => {
    const row = server({
      server_url: 'https://mcp.typefully.com/mcp',
      tools_cache: [{ name: 'create_draft' }, { name: 'list_drafts' }],
      allowed_tools: ['create_draft', 'list_drafts'],
      require_approval_tools: [],
    })
    hoisted.requireWorkspace.mockResolvedValue({ supabase: fakeSupabase(row), user: { id: 'user-1' }, workspaceId: 'ws' })
    await patch({ tool_permission: { tools: ['create_draft', 'list_drafts'], permission: 'allow' } })
    expect(hoisted.updates[0].approval_free_tools).not.toContain('create_draft')
  })

  it('an allow-list not seeded yet is left out of the write', async () => {
    const row = server({ allowed_tools: null })
    hoisted.requireWorkspace.mockResolvedValue({ supabase: fakeSupabase(row), user: { id: 'user-1' }, workspaceId: 'ws' })
    await patch({ tool_permission: { tools: ['get_issue'], permission: 'ask' } })
    expect(hoisted.updates[0]).not.toHaveProperty('allowed_tools')
  })

  it('refuses tool_permission together with the lists, and an unknown permission', async () => {
    hoisted.requireWorkspace.mockResolvedValue({ supabase: fakeSupabase(server()), user: { id: 'user-1' }, workspaceId: 'ws' })
    expect((await patch({ tool_permission: { tools: ['get_issue'], permission: 'ask' }, disabled_tools: [] })).status).toBe(400)
    expect((await patch({ tool_permission: { tools: ['get_issue'], permission: 'sometimes' } })).status).toBe(400)
    expect(hoisted.updates).toEqual([])
  })

  it('a server that isn’t the caller’s is not found', async () => {
    hoisted.requireWorkspace.mockResolvedValue({ supabase: fakeSupabase(null), user: { id: 'user-1' }, workspaceId: 'ws' })
    expect((await patch({ tool_permission: { tools: ['get_issue'], permission: 'ask' } })).status).toBe(404)
  })
})
