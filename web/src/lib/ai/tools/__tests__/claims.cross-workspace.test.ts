/**
 * Tests for the cross_workspace param on list_claims / get_context_bundle /
 * traverse (knowledge-recall plan item 21).
 *
 *   - list_claims: fan-out across the user's workspaces, tag rows with
 *     workspace_id + workspace_name, merge + re-sort by the active time_field
 *     desc, respect the overall limit; default (off) = single-workspace,
 *     behaviour unchanged; cross_workspace + group_by_change = clear tool error.
 *   - get_context_bundle / traverse: cross_workspace resolves WHICH workspace
 *     holds the entity (resolveEntityWorkspace) and runs the graph query there;
 *     default (off) = active workspace, unchanged.
 *
 * Supabase doubles are hand-rolled per describe block so each exercises exactly
 * the query shape it asserts, matching the sibling claims.*.test.ts style.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { createClaimTools } from '../claims'

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

type ClaimFixture = {
  id: string
  text: string
  type: string
  confirmation: string
  status: string
  scope: string | null
  subject_member_id: string | null
  superseded_by: string | null
  created_at: string
  updated_at: string
  last_verified_at: string | null
  confidence: number | null
  workspace_id: string
}

function claim(p: Partial<ClaimFixture> & { id: string; workspace_id: string }): ClaimFixture {
  return {
    text: `claim ${p.id}`,
    type: 'fact',
    confirmation: 'suggested',
    status: 'active',
    scope: null,
    subject_member_id: null,
    superseded_by: null,
    created_at: '2026-06-15T12:00:00.000Z',
    updated_at: '2026-06-15T12:00:00.000Z',
    last_verified_at: null,
    confidence: null,
    ...p,
  }
}

// ── list_claims cross-workspace fan-out ──────────────────────────────────────

/**
 * A filter-aware Supabase double for the flat list_claims path:
 *   from('member')      → the user's workspaces (getUserWorkspaces shape)
 *   from('claim')       → claims matching the recorded eq/in filters; the
 *                         workspace_id eq is honored so each fanned query only
 *                         returns its own workspace's rows.
 *   from('entity_link') → the entity-filter resolution (source_id/target_id).
 */
function makeListSupabase(opts: {
  workspaces: Array<{ id: string; name: string }>
  claims: ClaimFixture[]
  // entity-filter: workspace_id -> claim ids linked to the entity in that ws
  entityLinkByWorkspace?: Record<string, string[]>
}) {
  const from = vi.fn((table: string) => {
    const filters: { eqs: Record<string, unknown>; ins: Record<string, unknown[]> } = {
      eqs: {},
      ins: {},
    }
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => {
        let data: unknown[] = []
        if (table === 'member') {
          data = opts.workspaces.map((w) => ({ workspace: { id: w.id, name: w.name } }))
        } else if (table === 'claim') {
          data = opts.claims.filter((c) => {
            for (const [col, val] of Object.entries(filters.eqs)) {
              if ((c as Record<string, unknown>)[col] !== val) return false
            }
            if (filters.ins['id'] && !filters.ins['id'].includes(c.id)) return false
            return true
          })
        } else if (table === 'entity_link') {
          const ws = filters.eqs['workspace_id'] as string
          const ids = opts.entityLinkByWorkspace?.[ws] ?? []
          // Both directions select source_id/target_id — return both keys so the
          // union in list_claims picks the right one regardless of direction.
          data = ids.map((id) => ({ source_id: id, target_id: id }))
        }
        return Promise.resolve({ data, error: null }).then(resolve)
      },
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(t, p: string) {
        if (p in t) return t[p]
        if (p === 'eq') return (col: string, val: unknown) => ((filters.eqs[col] = val), proxy)
        if (p === 'in') return (col: string, vals: unknown[]) => ((filters.ins[col] = vals), proxy)
        return () => proxy
      },
    })
    return proxy
  })
  return { from } as never
}

describe('list_claims — cross_workspace', () => {
  it('default (off) queries only the active workspace and does not tag rows', async () => {
    const supabase = makeListSupabase({
      workspaces: [
        { id: 'ws-1', name: 'Alpha' },
        { id: 'ws-2', name: 'Beta' },
      ],
      claims: [
        claim({ id: 'a', workspace_id: 'ws-1' }),
        claim({ id: 'b', workspace_id: 'ws-2' }),
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!({} as never, EXEC_OPTS)) as unknown as {
      claims: Array<{ id: string; workspace_id: string; workspace_name?: string }>
      count: number
      cross_workspace?: boolean
    }
    // Only ws-1's claim; ws-2 was never queried.
    expect(res.claims.map((c) => c.id)).toEqual(['a'])
    expect(res.count).toBe(1)
    expect(res.cross_workspace).toBeUndefined()
    // Rows are workspace-qualified on BOTH paths — the single-workspace path is
    // exactly where an agent is most likely to assume the wrong tenant.
    expect(res.claims[0].workspace_id).toBe(WORKSPACE_ID)
    // `workspace_name` stays cross-workspace-only: the single-workspace fan-out
    // synthesises `{ id: workspaceId, name: '' }`, so a name here would be a lie.
    expect(res.claims[0].workspace_name).toBeUndefined()
    // Never resolved the user's workspace list.
    const from = (supabase as unknown as { from: ReturnType<typeof vi.fn> }).from
    expect(from.mock.calls.some((c: unknown[]) => c[0] === 'member')).toBe(false)
  })

  it('fans out across every workspace and tags rows with workspace_id + workspace_name', async () => {
    const supabase = makeListSupabase({
      workspaces: [
        { id: 'ws-1', name: 'Alpha' },
        { id: 'ws-2', name: 'Beta' },
      ],
      claims: [
        claim({ id: 'a', workspace_id: 'ws-1' }),
        claim({ id: 'b', workspace_id: 'ws-2' }),
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!({ cross_workspace: true } as never, EXEC_OPTS)) as unknown as {
      claims: Array<{ id: string; workspace_id: string; workspace_name: string }>
      count: number
      cross_workspace: boolean
      workspace_count: number
    }
    expect(res.cross_workspace).toBe(true)
    expect(res.workspace_count).toBe(2)
    expect(new Set(res.claims.map((c) => c.id))).toEqual(new Set(['a', 'b']))
    const a = res.claims.find((c) => c.id === 'a')!
    const b = res.claims.find((c) => c.id === 'b')!
    expect(a).toMatchObject({ workspace_id: 'ws-1', workspace_name: 'Alpha' })
    expect(b).toMatchObject({ workspace_id: 'ws-2', workspace_name: 'Beta' })
  })

  it('a strictWorkspace run ignores cross_workspace and stays in the active workspace', async () => {
    const supabase = makeListSupabase({
      workspaces: [
        { id: 'ws-1', name: 'Alpha' },
        { id: 'ws-2', name: 'Beta' },
      ],
      claims: [
        claim({ id: 'a', workspace_id: 'ws-1' }),
        claim({ id: 'b', workspace_id: 'ws-2' }),
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID, true).list_claims
    const res = (await tool.execute!({ cross_workspace: true } as never, EXEC_OPTS)) as unknown as {
      claims: Array<{ id: string }>
      cross_workspace?: boolean
    }
    expect(res.claims.map((c) => c.id)).toEqual(['a'])
    expect(res.cross_workspace).toBeUndefined()
    const from = (supabase as unknown as { from: ReturnType<typeof vi.fn> }).from
    expect(from.mock.calls.some((c: unknown[]) => c[0] === 'member')).toBe(false)
  })

  it('merges and re-sorts by the active time_field desc across workspaces', async () => {
    const supabase = makeListSupabase({
      workspaces: [
        { id: 'ws-1', name: 'Alpha' },
        { id: 'ws-2', name: 'Beta' },
      ],
      claims: [
        // ws-1 older, ws-2 newer — after the merge the newer must lead.
        claim({ id: 'older', workspace_id: 'ws-1', created_at: '2026-06-01T00:00:00.000Z' }),
        claim({ id: 'newer', workspace_id: 'ws-2', created_at: '2026-06-20T00:00:00.000Z' }),
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { cross_workspace: true } as never, // time_field defaults to created_at
      EXEC_OPTS,
    )) as unknown as { claims: Array<{ id: string }> }
    expect(res.claims.map((c) => c.id)).toEqual(['newer', 'older'])
  })

  it('respects the overall limit after the cross-workspace merge', async () => {
    const supabase = makeListSupabase({
      workspaces: [
        { id: 'ws-1', name: 'Alpha' },
        { id: 'ws-2', name: 'Beta' },
      ],
      claims: [
        claim({ id: 'a', workspace_id: 'ws-1', created_at: '2026-06-03T00:00:00.000Z' }),
        claim({ id: 'b', workspace_id: 'ws-2', created_at: '2026-06-02T00:00:00.000Z' }),
        claim({ id: 'c', workspace_id: 'ws-2', created_at: '2026-06-01T00:00:00.000Z' }),
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { cross_workspace: true, limit: 2 } as never,
      EXEC_OPTS,
    )) as unknown as { claims: Array<{ id: string }>; count: number }
    // The two freshest across both workspaces, trimmed to the overall limit.
    expect(res.claims.map((c) => c.id)).toEqual(['a', 'b'])
    expect(res.count).toBe(2)
  })

  it('resolves the entity filter PER workspace when cross_workspace is set', async () => {
    const supabase = makeListSupabase({
      workspaces: [
        { id: 'ws-1', name: 'Alpha' },
        { id: 'ws-2', name: 'Beta' },
      ],
      claims: [
        claim({ id: 'a', workspace_id: 'ws-1' }),
        claim({ id: 'b', workspace_id: 'ws-2' }),
        claim({ id: 'c', workspace_id: 'ws-2' }),
      ],
      // The project entity links to claim 'a' in ws-1 and claim 'c' in ws-2.
      entityLinkByWorkspace: { 'ws-1': ['a'], 'ws-2': ['c'] },
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      {
        cross_workspace: true,
        entity_type: 'project',
        entity_id: 'p-1',
      } as never,
      EXEC_OPTS,
    )) as unknown as { claims: Array<{ id: string }> }
    // Only the entity-linked claim from each workspace — 'b' (unlinked) excluded.
    expect(new Set(res.claims.map((c) => c.id))).toEqual(new Set(['a', 'c']))
  })

  it('does not early-return empty when the ACTIVE workspace has no entity links but a foreign one does', async () => {
    // Regression: the single-workspace entity resolution early-returns {claims:[]}
    // for an empty match. That early-return must be skipped on the cross path so
    // a foreign workspace's linked claims still surface.
    const supabase = makeListSupabase({
      workspaces: [
        { id: 'ws-1', name: 'Alpha' },
        { id: 'ws-2', name: 'Beta' },
      ],
      claims: [claim({ id: 'b', workspace_id: 'ws-2' })],
      entityLinkByWorkspace: { 'ws-1': [], 'ws-2': ['b'] },
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      {
        cross_workspace: true,
        entity_type: 'project',
        entity_id: 'p-1',
      } as never,
      EXEC_OPTS,
    )) as unknown as { claims: Array<{ id: string }>; count: number }
    expect(res.claims.map((c) => c.id)).toEqual(['b'])
    expect(res.count).toBe(1)
  })

  it('reads an entity with hundreds of linked claims in 100-id chunks (one id list overflowed the URL) and merges them', async () => {
    const linked = Array.from({ length: 250 }, (_, i) => `id-${i}`)
    const supabase = makeListSupabase({
      workspaces: [{ id: 'ws-1', name: 'Alpha' }],
      claims: [claim({ id: 'id-3', workspace_id: 'ws-1' }), claim({ id: 'id-240', workspace_id: 'ws-1' })],
      entityLinkByWorkspace: { 'ws-1': linked },
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!({ entity_type: 'project', entity_id: 'p-1' } as never, EXEC_OPTS)) as unknown as {
      claims: Array<{ id: string }>
    }
    expect(new Set(res.claims.map((c) => c.id))).toEqual(new Set(['id-3', 'id-240']))
    const claimReads = (supabase as unknown as { from: { mock: { calls: unknown[][] } } }).from.mock.calls.filter(
      (c) => c[0] === 'claim',
    )
    expect(claimReads).toHaveLength(3)
  })

  it('returns a clear tool error for cross_workspace + group_by_change', async () => {
    const supabase = makeListSupabase({
      workspaces: [{ id: 'ws-1', name: 'Alpha' }],
      claims: [],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { cross_workspace: true, group_by_change: true, since: 'last_week' } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not supported together/i)
    // It must not have run any query (short-circuits before touching the DB).
    const from = (supabase as unknown as { from: ReturnType<typeof vi.fn> }).from
    expect(from).not.toHaveBeenCalled()
  })
})

// ── get_context_bundle / traverse entity-resolution ──────────────────────────

/**
 * A Supabase double for the entity-resolution graph tools.
 *   rpc('claim_neighborhood')  → records p_workspace_id, returns a stub bundle.
 *   from('member')             → membership check (resolveEntityWorkspace slow path).
 *   from(<entity table>)       → resolveEntityWorkspace: fast path (id+ws) then
 *                                 slow path (id only) resolve where the row lives.
 *   from('entity_link')        → traverse's outbound/inbound edge queries.
 */
function makeGraphSupabase(opts: {
  // which workspace the entity actually lives in
  entityWorkspace: string
  // workspaces the user is a member of (for the membership gate)
  memberWorkspaces: string[]
  entityTable?: string
  edges?: Array<{ workspace_id: string; target_type: string; target_id: string; relation: string }>
}) {
  const entityTable = opts.entityTable ?? 'projects'
  // entity_refs_hidden (migration 500's edge fence): nothing hidden here.
  const rpc = vi.fn(async (fn: string) =>
    fn === 'entity_refs_hidden'
      ? { data: [], error: null }
      : { data: { center: {}, depth: 2, nodes: [], edges: [] }, error: null },
  )
  const from = vi.fn((table: string) => {
    const filters: { eqs: Record<string, unknown> } = { eqs: {} }
    const resolveData = (): { data: unknown; error: null } => {
      if (table === 'member') {
        const ws = filters.eqs['workspace_id'] as string | undefined
        // membership check: row exists iff the user belongs to that workspace
        if (ws && opts.memberWorkspaces.includes(ws)) return { data: { id: 'm-1' }, error: null }
        return { data: null, error: null }
      }
      if (table === entityTable) {
        const wantWs = filters.eqs['workspace_id'] as string | undefined
        // Fast path filters by workspace_id; slow path doesn't. The row lives in
        // opts.entityWorkspace regardless.
        if (wantWs !== undefined) {
          return wantWs === opts.entityWorkspace
            ? { data: { workspace_id: opts.entityWorkspace }, error: null }
            : { data: null, error: null }
        }
        return { data: { workspace_id: opts.entityWorkspace }, error: null }
      }
      return { data: null, error: null }
    }
    const chain: Record<string, unknown> = {
      maybeSingle: async () => resolveData(),
      then: (resolve: (v: unknown) => unknown) => {
        // entity_link list queries (traverse) resolve here.
        if (table === 'entity_link') {
          const ws = filters.eqs['workspace_id'] as string
          const dirIsOutbound = 'source_type' in filters.eqs
          const rows = (opts.edges ?? []).filter((e) => e.workspace_id === ws)
          const data = dirIsOutbound
            ? rows.map((e) => ({ target_type: e.target_type, target_id: e.target_id, relation: e.relation }))
            : rows.map((e) => ({ source_type: e.target_type, source_id: e.target_id, relation: e.relation }))
          return Promise.resolve({ data, error: null }).then(resolve)
        }
        return Promise.resolve(resolveData()).then(resolve)
      },
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(t, p: string) {
        if (p in t) return t[p]
        if (p === 'eq') return (col: string, val: unknown) => ((filters.eqs[col] = val), proxy)
        return () => proxy
      },
    })
    return proxy
  })
  return { rpc, from } as never
}

describe('get_context_bundle — cross_workspace entity resolution', () => {
  it('default (off) builds the bundle in the active workspace', async () => {
    const supabase = makeGraphSupabase({ entityWorkspace: 'ws-2', memberWorkspaces: ['ws-1', 'ws-2'] })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).get_context_bundle
    await tool.execute!({ entity_type: 'project', entity_id: 'p-1' } as never, EXEC_OPTS)
    const rpc = (supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_workspace_id: WORKSPACE_ID })
  })

  it('cross_workspace resolves the entity into ITS workspace and builds the bundle there', async () => {
    const supabase = makeGraphSupabase({ entityWorkspace: 'ws-2', memberWorkspaces: ['ws-1', 'ws-2'] })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).get_context_bundle
    const res = (await tool.execute!(
      { entity_type: 'project', entity_id: 'p-1', cross_workspace: true } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; workspace_hint?: string }
    const rpc = (supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_workspace_id: 'ws-2' })
    expect(res.workspace_hint).toMatch(/ws-2/)
  })

  it('cross_workspace errors when the entity is in no workspace the user belongs to', async () => {
    // Entity lives in ws-9, but the user is only a member of ws-1.
    const supabase = makeGraphSupabase({ entityWorkspace: 'ws-9', memberWorkspaces: ['ws-1'] })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).get_context_bundle
    const res = (await tool.execute!(
      { entity_type: 'project', entity_id: 'p-1', cross_workspace: true } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found in any workspace/i)
    // And it never ran the neighborhood RPC.
    const rpc = (supabase as unknown as { rpc: ReturnType<typeof vi.fn> }).rpc
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('traverse — cross_workspace entity resolution', () => {
  it('default (off) traverses the active workspace', async () => {
    const supabase = makeGraphSupabase({
      entityWorkspace: 'ws-2',
      memberWorkspaces: ['ws-1', 'ws-2'],
      edges: [{ workspace_id: WORKSPACE_ID, target_type: 'claim', target_id: 'cl-1', relation: 'about' }],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).traverse
    const res = (await tool.execute!(
      { entity_type: 'project', entity_id: 'p-1', direction: 'outbound' } as never,
      EXEC_OPTS,
    )) as unknown as { outbound: Array<{ target_id: string }> }
    // Edges scoped to the ACTIVE workspace are returned (ws-2 edges ignored).
    expect(res.outbound.map((e) => e.target_id)).toEqual(['cl-1'])
  })

  it('cross_workspace traverses the entity\'s OWN workspace', async () => {
    const supabase = makeGraphSupabase({
      entityWorkspace: 'ws-2',
      memberWorkspaces: ['ws-1', 'ws-2'],
      edges: [
        // An edge in the ACTIVE workspace we must NOT return, and one in ws-2 we must.
        { workspace_id: WORKSPACE_ID, target_type: 'claim', target_id: 'active-edge', relation: 'about' },
        { workspace_id: 'ws-2', target_type: 'claim', target_id: 'foreign-edge', relation: 'about' },
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).traverse
    const res = (await tool.execute!(
      { entity_type: 'project', entity_id: 'p-1', direction: 'outbound', cross_workspace: true } as never,
      EXEC_OPTS,
    )) as unknown as { outbound: Array<{ target_id: string }>; workspace_hint?: string }
    expect(res.outbound.map((e) => e.target_id)).toEqual(['foreign-edge'])
    expect(res.workspace_hint).toMatch(/ws-2/)
  })

  it('cross_workspace errors when the entity is in no workspace the user belongs to', async () => {
    const supabase = makeGraphSupabase({ entityWorkspace: 'ws-9', memberWorkspaces: ['ws-1'] })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).traverse
    const res = (await tool.execute!(
      { entity_type: 'project', entity_id: 'p-1', cross_workspace: true } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found in any workspace/i)
  })
})
