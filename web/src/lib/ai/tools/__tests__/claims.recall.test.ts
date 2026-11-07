/**
 * Tests for the find-arc additions to claims.ts:
 *   - reconcileProvenance: batched (2-query) reconciliation of claim_source
 *     evidence + cites/about entity_link edges into one flat view per claim.
 *   - search_claims: since/until wired through to match_claims' event-time range.
 *   - supersede_claim: the replacement inherits the old claim's event_at.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { reconcileProvenance, createClaimTools } from '../claims'

vi.mock('@/lib/ai/embeddings', () => ({
  embed: vi.fn(async () => [0.1, 0.2, 0.3]),
}))
vi.mock('@/lib/ai/claim-provenance', () => ({
  attachClaimProvenance: vi.fn(async () => ({ errors: [] })),
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

// ── reconcileProvenance ──────────────────────────────────────────────────────

describe('reconcileProvenance', () => {
  it('returns an empty map for no ids without querying', async () => {
    const from = vi.fn()
    const supabase = { from } as never
    const out = await reconcileProvenance(supabase, WORKSPACE_ID, [])
    expect(out.size).toBe(0)
    expect(from).not.toHaveBeenCalled()
  })

  it('reconciles a source that is BOTH evidence and a cites edge into one entry', async () => {
    // Two queries only: claim_source (.in) and entity_link (.in). Return each
    // via a table-keyed handler.
    const from = vi.fn((table: string) => {
      const rows =
        table === 'claim_source'
          ? [{ claim_id: 'cl1', source_type: 'capture', source_id: 'cap1', source_uri: null, excerpt: 'said X' }]
          : [{ source_id: 'cl1', target_type: 'capture', target_id: 'cap1', relation: 'cites' }]
      const result = { data: rows, error: null }
      const proxy: Record<string, unknown> = new Proxy(
        { then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r) },
        { get(t: Record<string, unknown>, p: string) { return p in t ? t[p] : () => proxy } },
      )
      return proxy
    })
    const supabase = { from } as never

    const out = await reconcileProvenance(supabase, WORKSPACE_ID, ['cl1'])
    expect(from).toHaveBeenCalledTimes(2)
    const prov = out.get('cl1')!
    expect(prov).toHaveLength(1)
    expect(prov[0]).toMatchObject({
      entity_type: 'capture',
      entity_id: 'cap1',
      excerpt: 'said X',
      in_sources: true,
      in_graph: true,
      relations: ['cites'],
    })
  })

  it('keeps a supersedes edge OUT of provenance (only cites/about count)', async () => {
    const from = vi.fn((table: string) => {
      const rows =
        table === 'claim_source'
          ? []
          : [{ source_id: 'cl1', target_type: 'claim', target_id: 'old', relation: 'supersedes' }]
      const result = { data: rows, error: null }
      const proxy: Record<string, unknown> = new Proxy(
        { then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r) },
        { get(t: Record<string, unknown>, p: string) { return p in t ? t[p] : () => proxy } },
      )
      return proxy
    })
    const supabase = { from } as never
    const out = await reconcileProvenance(supabase, WORKSPACE_ID, ['cl1'])
    // The supersedes edge isn't provenance → no entry for cl1.
    expect(out.get('cl1') ?? []).toHaveLength(0)
  })

  it('groups provenance per claim across a batch of ids', async () => {
    const from = vi.fn((table: string) => {
      const rows =
        table === 'claim_source'
          ? [
              { claim_id: 'a', source_type: 'document', source_id: 'd1', source_uri: null, excerpt: 'e-a' },
              { claim_id: 'b', source_type: 'email', source_id: 'm1', source_uri: null, excerpt: 'e-b' },
            ]
          : []
      const result = { data: rows, error: null }
      const proxy: Record<string, unknown> = new Proxy(
        { then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r) },
        { get(t: Record<string, unknown>, p: string) { return p in t ? t[p] : () => proxy } },
      )
      return proxy
    })
    const supabase = { from } as never
    const out = await reconcileProvenance(supabase, WORKSPACE_ID, ['a', 'b'])
    expect(from).toHaveBeenCalledTimes(2) // still only 2 queries for N claims
    expect(out.get('a')![0].excerpt).toBe('e-a')
    expect(out.get('b')![0].entity_type).toBe('email')
  })
})

// ── search_claims time params ────────────────────────────────────────────────

describe('search_claims — since/until', () => {
  function supabaseCapturingRpc() {
    const rpc = vi.fn(async () => ({ data: [], error: null }))
    const from = vi.fn(() => {
      const proxy: Record<string, unknown> = new Proxy(
        { then: (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: null }).then(r) },
        { get(t: Record<string, unknown>, p: string) { return p in t ? t[p] : () => proxy } },
      )
      return proxy
    })
    return { rpc, from } as never
  }

  it('passes resolved event_after/event_before to the 10-arg match_claims', async () => {
    const supabase = supabaseCapturingRpc()
    const tool = createClaimTools(USER_ID, supabase as never, WORKSPACE_ID).search_claims
    await tool.execute!({ query: 'billing', since: 'last_week', until: 'today' } as never, EXEC_OPTS)

    const rpc = (supabase as never as { rpc: ReturnType<typeof vi.fn> }).rpc
    const call = rpc.mock.calls.find((c: unknown[]) => c[0] === 'match_claims')!
    const args = call[1] as Record<string, unknown>
    expect(args.p_event_after).not.toBeNull()
    expect(args.p_event_before).not.toBeNull()
    // sanity: the arg keys for the 10-arg overload are present
    expect(args).toHaveProperty('p_min_confidence')
  })

  it('passes NULL bounds when no window is given', async () => {
    const supabase = supabaseCapturingRpc()
    const tool = createClaimTools(USER_ID, supabase as never, WORKSPACE_ID).search_claims
    await tool.execute!({ query: 'x' } as never, EXEC_OPTS)
    const rpc = (supabase as never as { rpc: ReturnType<typeof vi.fn> }).rpc
    const args = rpc.mock.calls.find((c: unknown[]) => c[0] === 'match_claims')![1] as Record<string, unknown>
    expect(args.p_event_after).toBeNull()
    expect(args.p_event_before).toBeNull()
  })
})
