/**
 * Tests for the package-ACL enforcement seams (mig 238).
 *
 * The SQL predicates themselves can't run here (no DB test infra yet — see
 * docs/TESTING.md), so these tests pin the repo's compensating convention:
 * the service-role code seams. Covered: the RPC wrappers fail CLOSED on any
 * error (including function-does-not-exist during the deploy window), and
 * createPackageTools' canSee mirror enforces the membership precondition the
 * SQL predicate makes load-bearing (an ex-member with a live MCP token must
 * see nothing, not every workspace-visible package).
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { packageVisibleTo, packageEditableBy } from '@/lib/knowledge/package-acl'
import { createPackageTools } from '@/lib/ai/tools/packages'

function rpcClient(result: { data?: unknown; error?: unknown }) {
  return { rpc: vi.fn(async () => result) } as unknown as SupabaseClient
}

describe('package-acl RPC wrappers', () => {
  it('true only on an explicit true result', async () => {
    expect(await packageVisibleTo(rpcClient({ data: true, error: null }), 'u', 'p')).toBe(true)
    expect(await packageEditableBy(rpcClient({ data: true, error: null }), 'u', 'p')).toBe(true)
  })

  it('false on false/null data', async () => {
    expect(await packageVisibleTo(rpcClient({ data: false, error: null }), 'u', 'p')).toBe(false)
    expect(await packageVisibleTo(rpcClient({ data: null, error: null }), 'u', 'p')).toBe(false)
  })

  it('fails CLOSED on rpc errors (including missing function pre-migration)', async () => {
    const missingFn = { error: { code: 'PGRST202', message: 'function does not exist' } }
    expect(await packageVisibleTo(rpcClient(missingFn), 'u', 'p')).toBe(false)
    expect(await packageEditableBy(rpcClient(missingFn), 'u', 'p')).toBe(false)
  })

  it('asserts the explicit user id (service-role convention)', async () => {
    const client = rpcClient({ data: true, error: null })
    await packageVisibleTo(client, 'user-9', 'pkg-3')
    expect((client.rpc as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith('package_visible_to', {
      p_package_id: 'pkg-3',
      p_user_id: 'user-9',
    })
  })
})

// ── canSee membership precondition (service-role path) ─────────────────────
// list_packages fences rows through canSee; with no member row in the
// workspace, even workspace-visible packages and the user's own creations
// must disappear.

function makeServiceClient(opts: { memberId: string | null }) {
  const workspacePackages = [
    {
      id: 'pkg-ws',
      name: 'Workspace pkg',
      slug: 'workspace-pkg',
      description: null,
      visibility: 'workspace',
      team_id: null,
      rules: {},
      created_by: 'someone-else',
      created_at: 'then',
      updated_at: 'now',
    },
    {
      id: 'pkg-own',
      name: 'My personal pkg',
      slug: 'my-personal-pkg',
      description: null,
      visibility: 'personal',
      team_id: null,
      rules: {},
      created_by: 'user-1',
      created_at: 'then',
      updated_at: 'now',
    },
  ]
  const listChain = (result: unknown) => {
    const chain: Record<string, unknown> = {}
    return new Proxy(chain, {
      get(_t, prop: string) {
        if (prop === 'then') return (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb)
        if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(result)
        return () => new Proxy(chain, this as ProxyHandler<Record<string, unknown>>)
      },
    })
  }
  return {
    from: (table: string) => {
      if (table === 'knowledge_package') return listChain({ data: workspacePackages, error: null })
      if (table === 'member')
        return listChain({ data: opts.memberId ? { id: opts.memberId } : null, error: null })
      if (table === 'team_member') return listChain({ data: [], error: null })
      if (table === 'knowledge_package_share') return listChain({ data: [], error: null })
      if (table === 'knowledge_package_item') return listChain({ data: [], error: null })
      return listChain({ data: null, error: null })
    },
    rpc: vi.fn(async () => ({ data: false, error: null })),
  } as unknown as SupabaseClient
}

describe('canSee membership precondition over service-role', () => {
  it('an ex-member sees NOTHING — not even workspace-visible or own packages', async () => {
    const tools = createPackageTools('user-1', makeServiceClient({ memberId: null }), 'ws-1')
    const out = (await tools.list_packages.execute!(
      { search: undefined },
      {} as never,
    )) as { success: boolean; count: number }
    expect(out.success).toBe(true)
    expect(out.count).toBe(0)
  })

  it('a current member sees workspace-visible and own packages', async () => {
    const tools = createPackageTools('user-1', makeServiceClient({ memberId: 'mem-1' }), 'ws-1')
    const out = (await tools.list_packages.execute!(
      { search: undefined },
      {} as never,
    )) as { success: boolean; count: number }
    expect(out.count).toBe(2)
  })
})
