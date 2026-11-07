/**
 * Where a connection's allow-list and ask-first pins come from (F2 review B1,
 * S4):
 *   - adding a server from the Connect card allows only the tools the card
 *     SHOWED that the server still lists; anything new since stays hidden;
 *   - a server we don't know whose first listing found nothing gets, on the
 *     Refresh that seeds its allow-list, the same pins it would have had at
 *     connect, so an empty first answer can't skip "writes start as ask".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  listed: [] as Array<{ name: string; annotations?: Record<string, boolean> }>,
  row: null as Record<string, unknown> | null,
  inserted: null as Record<string, unknown> | null,
  updated: null as Record<string, unknown> | null,
}))

vi.mock('server-only', () => ({}))
vi.mock('@/lib/mcp-client', () => ({
  listTools: vi.fn(async () => state.listed),
  McpTokenExpiredError: class extends Error {},
}))
vi.mock('@/lib/mcp-client/url-guard-dns', () => ({ assertPublicHost: vi.fn(async () => ({ ok: true })) }))
vi.mock('@/lib/crypto/credentials', () => ({ encryptCredentialOrNull: () => null }))
vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: async () => ({
    user: { id: 'u1' },
    workspaceId: 'ws-1',
    supabase: {
      from: () => {
        const chain: Record<string, unknown> = {}
        chain.select = () => chain
        chain.eq = () => chain
        chain.maybeSingle = async () => ({ data: state.row, error: null })
        chain.single = async () => ({ data: { ...(state.row ?? {}), ...(state.inserted ?? {}), ...(state.updated ?? {}), id: 'srv-1' }, error: null })
        chain.insert = (row: Record<string, unknown>) => {
          state.inserted = row
          return chain
        }
        chain.update = (u: Record<string, unknown>) => {
          state.updated = u
          return chain
        }
        return chain
      },
    },
  }),
}))

import { POST as add } from '../route'
import { POST as refresh } from '../[id]/refresh-tools/route'

const req = (body: unknown) => new Request('http://x/api/account/mcp-servers', { method: 'POST', body: JSON.stringify(body) }) as never

beforeEach(() => {
  state.listed = []
  state.row = null
  state.inserted = null
  state.updated = null
})

describe('adding from the Connect card (S4)', () => {
  it('allows only what the card showed and the server still lists; a new tool stays hidden; writes pinned to ask', async () => {
    state.listed = [{ name: 'search_docs' }, { name: 'delete_page', annotations: { readOnlyHint: true } }, { name: 'sneaky_new_tool' }]
    const res = await add(req({ display_name: 'Deepwiki', server_url: 'https://mcp.deepwiki.com/mcp', shown_tools: ['search_docs', 'delete_page', 'gone_tool'] }))
    expect(res.status).toBe(200)
    expect(state.inserted).toMatchObject({
      allowed_tools: ['search_docs', 'delete_page'],
      require_approval_tools: ['delete_page', 'sneaky_new_tool'],
    })
  })

  it('without a card (Settings), everything listed now is allowed, as before', async () => {
    state.listed = [{ name: 'list_a' }, { name: 'write_b' }]
    await add(req({ display_name: 'Acme', server_url: 'https://mcp.acme.dev/mcp' }))
    expect(state.inserted).toMatchObject({ allowed_tools: ['list_a', 'write_b'], require_approval_tools: ['write_b'] })
  })
})

describe('the Refresh that seeds an empty first listing (B1)', () => {
  it('a server we don\'t know gets the ask-first pins with its allow-list', async () => {
    state.row = { id: 'srv-1', user_id: 'u1', server_url: 'https://mcp.evil.example/mcp', allowed_tools: null, require_approval_tools: ['kept_pin'] }
    state.listed = [{ name: 'list_things' }, { name: 'wipe_all', annotations: { readOnlyHint: true } }]
    const res = await refresh(new Request('http://x') as never, { params: Promise.resolve({ id: 'srv-1' }) })
    expect(res.status).toBe(200)
    expect(state.updated).toMatchObject({ allowed_tools: ['list_things', 'wipe_all'], require_approval_tools: ['kept_pin', 'wipe_all'] })
  })

  it('a seeded server keeps its lists: a new tool is reported, never allowed or pinned here', async () => {
    state.row = { id: 'srv-1', user_id: 'u1', server_url: 'https://mcp.evil.example/mcp', allowed_tools: ['list_things'], require_approval_tools: [] }
    state.listed = [{ name: 'list_things' }, { name: 'wipe_all' }]
    const res = await refresh(new Request('http://x') as never, { params: Promise.resolve({ id: 'srv-1' }) })
    expect(state.updated).toMatchObject({ allowed_tools: ['list_things'] })
    expect(state.updated).not.toHaveProperty('require_approval_tools')
    expect((await res.json()).new_tools).toEqual(['wipe_all'])
  })
})
