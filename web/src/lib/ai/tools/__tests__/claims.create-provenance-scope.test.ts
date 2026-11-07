/**
 * Regression: create_claim must verify that every caller-supplied provenance id
 * (source.source_id / link.entity_id) belongs to the active workspace BEFORE it
 * is written into the graph. These tools are reachable via service-role clients
 * that bypass RLS, so this app-layer check is the only real gate. Mirrors the
 * verification link_entities already performs.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createClaimTools } from '../claims'

const { attach } = vi.hoisted(() => ({
  attach: vi.fn(async () => ({ sources: 0, links: 0, errors: [] as string[] })),
}))
vi.mock('@/lib/ai/embeddings', () => ({
  embed: vi.fn(async () => [0.1, 0.2, 0.3]),
}))
vi.mock('@/lib/ai/claim-provenance', () => ({
  attachClaimProvenance: attach,
}))

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

/**
 * Supabase double keyed by which workspace-scoped rows exist:
 *   from('member')  → resolveMemberId (single()) returns m-1.
 *   from(<table>)   → entityInWorkspace: maybeSingle() returns a row only when
 *                     (id, workspace_id) is present in `owned[table]`.
 *   from('claim')   → insert().select().single() returns a stub claim.
 *   from('claim_chunks') → embedding insert, ignored.
 */
function makeSupabase(owned: Record<string, Set<string>>) {
  const claimInsert = vi.fn()
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {}
    const chain: Record<string, unknown> = {
      maybeSingle: async () => {
        // entityInWorkspace lookup: row exists iff (id, ws) is owned.
        const id = filters['id'] as string
        const ws = filters['workspace_id'] as string
        const has = ws === WORKSPACE_ID && owned[table]?.has(id)
        return { data: has ? { id } : null, error: null }
      },
      single: async () => {
        if (table === 'member') return { data: { id: 'm-1' }, error: null }
        if (table === 'claim') {
          return {
            data: { id: 'claim-1', text: 'x', type: 'fact', confirmation: 'suggested', status: 'active' },
            error: null,
          }
        }
        return { data: null, error: null }
      },
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(t, p: string) {
        if (p in t) return t[p]
        // Not a thenable — `await proxy` must resolve to the proxy, not spin.
        if (p === 'then' || p === 'catch' || p === 'finally') return undefined
        if (p === 'eq') return (col: string, val: unknown) => ((filters[col] = val), proxy)
        if (p === 'insert')
          return (row: unknown) => {
            if (table === 'claim') claimInsert(row)
            return proxy
          }
        return () => proxy
      },
    })
    return proxy
  })
  return { supabase: { from } as never, claimInsert }
}

describe('create_claim — provenance workspace scoping', () => {
  it('rejects a source_id that is not in the workspace and does not create the claim', async () => {
    const { supabase, claimInsert } = makeSupabase({ captures: new Set() })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).create_claim
    const res = (await tool.execute!(
      {
        text: 'a fact',
        type: 'fact',
        sources: [{ source_type: 'capture', source_id: 'foreign-capture' }],
      } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found in this workspace/i)
    expect(claimInsert).not.toHaveBeenCalled()
    expect(attach).not.toHaveBeenCalled()
  })

  it('rejects a link entity_id that is not in the workspace', async () => {
    const { supabase, claimInsert } = makeSupabase({ contact: new Set() })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).create_claim
    const res = (await tool.execute!(
      {
        text: 'a fact',
        type: 'fact',
        links: [{ entity_type: 'contact', entity_id: 'foreign-contact' }],
      } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found in this workspace/i)
    expect(claimInsert).not.toHaveBeenCalled()
  })

  it('creates the claim and attaches provenance when ids belong to the workspace', async () => {
    const { supabase, claimInsert } = makeSupabase({
      captures: new Set(['cap-1']),
      contact: new Set(['ct-1']),
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).create_claim
    const res = (await tool.execute!(
      {
        text: 'a fact',
        type: 'fact',
        sources: [{ source_type: 'capture', source_id: 'cap-1' }],
        links: [{ entity_type: 'contact', entity_id: 'ct-1' }],
      } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean }
    expect(res.success).toBe(true)
    expect(claimInsert).toHaveBeenCalledTimes(1)
    expect(attach).toHaveBeenCalledTimes(1)
  })

  it('does not verify anchor-less sources (external_url / manual, no source_id)', async () => {
    const { supabase, claimInsert } = makeSupabase({})
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).create_claim
    const res = (await tool.execute!(
      {
        text: 'a fact',
        type: 'fact',
        sources: [{ source_type: 'external_url', source_uri: 'https://example.com', excerpt: 'e' }],
      } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean }
    expect(res.success).toBe(true)
    expect(claimInsert).toHaveBeenCalledTimes(1)
  })
})
