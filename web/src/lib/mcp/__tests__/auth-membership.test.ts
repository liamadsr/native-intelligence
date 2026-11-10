/**
 * authenticateMcpRequest re-checks that the token's workspace is still one
 * its user is a member of (../auth.ts). Every MCP tool runs on the service
 * client, so a member who left (POST /api/account/workspace/leave) or was
 * removed kept reading and writing that workspace through their tokens: a
 * connector for up to 14 days.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Token = { id: string; user_id: string; client_id: string; scopes: string[]; active_workspace_id: string | null; expires_at: string }

let token: Token
let memberships: Array<{ workspace_id: string; created_at: string }>
let memberLookupError: { message: string } | null

function fakeService() {
  return {
    from: (table: string) => {
      const filters: Record<string, unknown> = {}
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.update = () => chain
      chain.order = () => chain
      chain.limit = () => chain
      chain.eq = (col: string, val: unknown) => ((filters[col] = val), chain)
      chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(resolve)
      chain.single = async () => {
        if (table === 'mcp_oauth_token') return { data: token, error: null }
        // The first-workspace fallback: the oldest membership.
        const first = [...memberships].sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
        return { data: first ?? null, error: first ? null : { message: 'none' } }
      }
      chain.maybeSingle = async () => {
        if (memberLookupError) return { data: null, error: memberLookupError }
        const hit = memberships.find((m) => m.workspace_id === filters.workspace_id)
        return { data: hit ? { id: `m-${hit.workspace_id}` } : null, error: null }
      }
      return chain
    },
  }
}

vi.mock('@supabase/supabase-js', () => ({ createClient: () => fakeService() }))

import { authenticateMcpRequest } from '../auth'

const req = () => new Request('https://nativeintelligence.dev/api/mcp', { method: 'POST', headers: { authorization: 'Bearer tok' } })
const later = new Date(Date.now() + 3_600_000).toISOString()

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p
    return 200
  } catch (err) {
    if (err instanceof Response) return err.status
    throw err
  }
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://ref.supabase.co'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service'
  token = { id: 't1', user_id: 'u1', client_id: 'c', scopes: ['read', 'write'], active_workspace_id: 'ws-a', expires_at: later }
  memberships = [
    { workspace_id: 'ws-a', created_at: '2026-02-01' },
    { workspace_id: 'ws-b', created_at: '2026-01-01' },
  ]
  memberLookupError = null
})

describe('authenticateMcpRequest: the token’s workspace must still be the user’s', () => {
  it('a member of the active workspace: that one', async () => {
    expect((await authenticateMcpRequest(req())).workspaceId).toBe('ws-a')
  })

  it('left the active workspace: the connector falls back to their first remaining one', async () => {
    memberships = memberships.filter((m) => m.workspace_id !== 'ws-a')
    expect((await authenticateMcpRequest(req())).workspaceId).toBe('ws-b')
  })

  it('left their only workspace: refused (no workspace)', async () => {
    memberships = []
    expect(await status(authenticateMcpRequest(req()))).toBe(403)
  })

  it('a failed membership check refuses (503), never lets through', async () => {
    memberLookupError = { message: 'db down' }
    expect(await status(authenticateMcpRequest(req()))).toBe(503)
  })
})
