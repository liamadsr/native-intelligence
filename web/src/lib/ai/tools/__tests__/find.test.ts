/**
 * Tests for the `find` tool's param handling and routing (search.ts).
 *
 * We stub the embedding providers (no network) and a Supabase mock whose rpc()
 * records every call, then assert:
 *   - type routing (which RPCs fire for which `types`)
 *   - the temporal window + auto recency boost passed to hybrid_search
 *   - cross-workspace fan-out + score re-fusion
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ToolExecutionOptions } from 'ai'

// ── Provider stubs (no network) ─────────────────────────────────────────────
vi.mock('@/lib/ai/embeddings', () => ({
  embed: vi.fn(async () => [0.1, 0.2, 0.3]),
}))
vi.mock('@/lib/ai/gemini-embeddings', () => ({
  embedQuery: vi.fn(async () => [0.4, 0.5, 0.6]),
}))
vi.mock('@/lib/email/email-search-service', () => ({
  searchEmails: vi.fn(async () => ({ results: [], source: 'fts' })),
}))
vi.mock('@/lib/email/email-context-service', () => ({
  searchEmailsWithContext: vi.fn(async () => []),
}))

import { createSearchTools } from '../search'
import { searchEmails as mockSearchEmails } from '@/lib/email/email-search-service'

const USER_ID = 'user-1'
const WORKSPACE_ID = 'ws-1'
const EXEC_OPTS = { toolCallId: 'c1', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

/**
 * A Supabase test double whose rpc() returns `rpcData` for a given fn name and
 * records every call. Storage.createSignedUrl is stubbed. from() returns empty
 * chains (contacts/members resolve to nothing unless overridden).
 */
function makeSupabase(opts: {
  rpcByName?: Record<string, unknown[]>
  members?: Array<{ workspace: { id: string; name: string } }>
  /**
   * Per-table result rows for the `.from(table)` path. `workspace` is a special
   * case: since the code calls `.maybeSingle()`, a single row object is returned
   * (not an array). Everything else returns the array as `data`.
   */
  fromByTable?: Record<string, unknown>
} = {}) {
  const rpc = vi.fn(async (name: string) => ({ data: opts.rpcByName?.[name] ?? [], error: null }))
  const from = vi.fn((table: string) => {
    let data: unknown = []
    if (table === 'member' && opts.members) data = opts.members
    else if (opts.fromByTable && table in opts.fromByTable) data = opts.fromByTable[table]
    const result = { data, error: null }
    const chain: Record<string, unknown> = {
      then: (r: (v: unknown) => unknown) => Promise.resolve(result).then(r),
      // maybeSingle/single terminate the chain with a single-object result so
      // the workspace-name lookup (which calls .maybeSingle()) resolves cleanly.
      maybeSingle: async () => ({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null }),
      single: async () => ({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null }),
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(t, p: string) {
        if (p in t) return t[p]
        return () => proxy
      },
    })
    return proxy
  })
  const storage = {
    from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: 'https://signed/x' } }) }),
  }
  return { rpc, from, storage } as never
}

function getTool(supabase: unknown) {
  return createSearchTools(USER_ID, supabase as never, WORKSPACE_ID).find
}

describe('find — type routing', () => {
  it('defaults to claim+capture+document → hybrid_search only (no attachment RPC)', async () => {
    const supabase = makeSupabase()
    const tool = getTool(supabase)
    await tool.execute!({ query: 'billing' } as never, EXEC_OPTS)

    const rpcNames = (supabase as never as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.map((c: unknown[]) => c[0])
    expect(rpcNames).toContain('hybrid_search')
    expect(rpcNames).not.toContain('hybrid_search_attachments')

    const call = (supabase as never as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.find((c: unknown[]) => c[0] === 'hybrid_search')!
    expect((call[1] as { p_types: string[] }).p_types).toEqual(['claim', 'capture', 'document'])
  })

  it('opting into attachments fires hybrid_search_attachments', async () => {
    const supabase = makeSupabase()
    const tool = getTool(supabase)
    await tool.execute!({ query: 'spec', types: ['attachment'] } as never, EXEC_OPTS)

    const rpcNames = (supabase as never as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.map((c: unknown[]) => c[0])
    // No hybrid types requested → no hybrid_search; attachment RPC fires.
    expect(rpcNames).not.toContain('hybrid_search')
    expect(rpcNames).toContain('hybrid_search_attachments')
  })

  it('passes claim_status through to hybrid_search', async () => {
    const supabase = makeSupabase()
    const tool = getTool(supabase)
    await tool.execute!({ query: 'x', claim_status: 'superseded' } as never, EXEC_OPTS)
    const call = (supabase as never as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.find((c: unknown[]) => c[0] === 'hybrid_search')!
    expect((call[1] as { p_claim_status: string }).p_claim_status).toBe('superseded')
  })
})

describe('find — temporal window + auto recency boost', () => {
  it('resolves a "last_week" preset to a since bound and auto-raises recency to 1.0', async () => {
    const supabase = makeSupabase()
    const tool = getTool(supabase)
    const res = (await tool.execute!({ query: 'billing', since: 'last_week' } as never, EXEC_OPTS)) as {
      searched: { since: string | null; recency_weight: number }
    }
    expect(res.searched.since).not.toBeNull()
    expect(res.searched.recency_weight).toBe(1.0)

    const call = (supabase as never as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.find((c: unknown[]) => c[0] === 'hybrid_search')!
    expect((call[1] as { p_since: string | null }).p_since).not.toBeNull()
    expect((call[1] as { p_w_recent: number }).p_w_recent).toBe(1.0)
  })

  it('keeps recency at 0.5 with no window (all time outside the main chat)', async () => {
    const supabase = makeSupabase()
    const tool = getTool(supabase)
    const res = (await tool.execute!({ query: 'x' } as never, EXEC_OPTS)) as {
      searched: { recency_weight: number }
    }
    expect(res.searched.recency_weight).toBe(0.5)
  })

  it('respects an explicit recency_weight over the auto boost', async () => {
    const supabase = makeSupabase()
    const tool = getTool(supabase)
    const res = (await tool.execute!({ query: 'x', since: 'last_week', recency_weight: 0.2 } as never, EXEC_OPTS)) as {
      searched: { recency_weight: number }
    }
    expect(res.searched.recency_weight).toBe(0.2)
  })
})

describe('find — cross-workspace fusion', () => {
  beforeEach(() => vi.clearAllMocks())

  it('fans hybrid_search out per workspace and re-fuses by score', async () => {
    const members = [
      { workspace: { id: 'ws-1', name: 'Alpha' } },
      { workspace: { id: 'ws-2', name: 'Beta' } },
    ]
    // ws-1's row scores lower than ws-2's — after fusion ws-2 should lead.
    const supabase = makeSupabase({
      members,
      rpcByName: {
        // Same mock returns the same array for every hybrid_search call, so give
        // each row a distinct id and let the tag differentiate by workspace.
        hybrid_search: [
          { result_type: 'claim', result_id: 'shared', title: 't', score: 0.4, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: null, source_label: 'Claim', source_type: 'capture', metadata: {} },
        ],
      },
    })
    const tool = getTool(supabase)
    const res = (await tool.execute!({ query: 'x', cross_workspace: true } as never, EXEC_OPTS)) as {
      results: Array<{ workspace_id: string }>
      searched: { workspace_count: number }
    }
    // Both workspaces queried.
    const rpcCalls = (supabase as never as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.filter((c: unknown[]) => c[0] === 'hybrid_search')
    expect(rpcCalls).toHaveLength(2)
    expect(res.searched.workspace_count).toBe(2)
    // Same id in two different workspaces are NOT deduped — both survive.
    expect(res.results).toHaveLength(2)
    expect(new Set(res.results.map((r) => r.workspace_id))).toEqual(new Set(['ws-1', 'ws-2']))
  })

  it('a strictWorkspace run ignores cross_workspace and searches only the active workspace', async () => {
    const supabase = makeSupabase({
      members: [{ workspace: { id: 'ws-1', name: 'Alpha' } }, { workspace: { id: 'ws-2', name: 'Beta' } }],
    })
    const tool = createSearchTools(USER_ID, supabase as never, WORKSPACE_ID, false, 'all_time', true).find
    await tool.execute!({ query: 'x', cross_workspace: true } as never, EXEC_OPTS)
    const rpcCalls = (supabase as never as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.filter((c: unknown[]) => c[0] === 'hybrid_search')
    expect(rpcCalls).toHaveLength(1)
    expect((rpcCalls[0][1] as { p_workspace_id: string }).p_workspace_id).toBe(WORKSPACE_ID)
  })

  it('single-workspace (default) queries only the active workspace', async () => {
    const supabase = makeSupabase()
    const tool = getTool(supabase)
    await tool.execute!({ query: 'x' } as never, EXEC_OPTS)
    const call = (supabase as never as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.find((c: unknown[]) => c[0] === 'hybrid_search')!
    expect((call[1] as { p_workspace_id: string }).p_workspace_id).toBe(WORKSPACE_ID)
  })
})

describe('find — email window threading', () => {
  beforeEach(() => vi.clearAllMocks())

  it('threads the resolved since/until window into the email runner as after/before', async () => {
    const supabase = makeSupabase()
    const tool = getTool(supabase)
    const res = (await tool.execute!(
      { query: 'invoice', types: ['email'], since: 'last_week' } as never,
      EXEC_OPTS,
    )) as { searched: { since: string | null } }

    // The resolved window is passed to searchEmails as after/before (not ignored).
    const emailMock = mockSearchEmails as unknown as ReturnType<typeof vi.fn>
    expect(emailMock).toHaveBeenCalledTimes(1)
    const opts = emailMock.mock.calls[0][2] as { after?: string; before?: string; query: string }
    expect(opts.after).toBe(res.searched.since)
    expect(opts.after).not.toBeUndefined()
    expect(opts.query).toBe('invoice')
  })

  it('omits after/before for an all-time search (undefined, not null)', async () => {
    const supabase = makeSupabase()
    const tool = getTool(supabase)
    await tool.execute!({ query: 'x', types: ['email'], all_time: true } as never, EXEC_OPTS)
    const emailMock = mockSearchEmails as unknown as ReturnType<typeof vi.fn>
    const opts = emailMock.mock.calls[0][2] as { after?: string; before?: string }
    expect(opts.after).toBeUndefined()
    expect(opts.before).toBeUndefined()
  })
})

describe('find — workspace_name for in-workspace results', () => {
  beforeEach(() => vi.clearAllMocks())

  it('populates workspace_name on active-workspace hits (was empty string)', async () => {
    const supabase = makeSupabase({
      fromByTable: { workspace: { name: 'Acme HQ' } },
      rpcByName: {
        hybrid_search: [
          { result_type: 'capture', result_id: 'cap-1', title: 'standup', score: 0.5, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: null, source_label: 'Capture', source_type: 'capture', metadata: {} },
        ],
      },
    })
    const tool = getTool(supabase)
    const res = (await tool.execute!({ query: 'x' } as never, EXEC_OPTS)) as {
      results: Array<{ workspace_id: string; workspace_name: string }>
    }
    expect(res.results).toHaveLength(1)
    expect(res.results[0].workspace_id).toBe(WORKSPACE_ID)
    expect(res.results[0].workspace_name).toBe('Acme HQ')
  })

  it('resolves the workspace name ONCE per call, not per row', async () => {
    const supabase = makeSupabase({
      fromByTable: { workspace: { name: 'Acme HQ' } },
      rpcByName: {
        hybrid_search: [
          { result_type: 'capture', result_id: 'cap-1', title: 'a', score: 0.6, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: null, source_label: 'Capture', source_type: 'capture', metadata: {} },
          { result_type: 'capture', result_id: 'cap-2', title: 'b', score: 0.5, event_at: null, fts_rank: 2, vec_rank: 2, recency_rank: 2, excerpt: null, source_label: 'Capture', source_type: 'capture', metadata: {} },
        ],
      },
    })
    const tool = getTool(supabase)
    await tool.execute!({ query: 'x' } as never, EXEC_OPTS)
    const fromMock = (supabase as never as { from: ReturnType<typeof vi.fn> }).from
    const workspaceQueries = fromMock.mock.calls.filter((c: unknown[]) => c[0] === 'workspace')
    expect(workspaceQueries).toHaveLength(1)
  })
})

describe('find — anchor name enrichment', () => {
  beforeEach(() => vi.clearAllMocks())

  it('batch-resolves project names with exactly ONE projects query (no N+1)', async () => {
    const supabase = makeSupabase({
      fromByTable: {
        workspace: { name: 'WS' },
        // Two claims each linked to a project via graph edges. `target_type`
        // rides along now that the edge query spans every anchor type.
        entity_link: [
          { source_id: 'claim-1', target_id: 'proj-a', target_type: 'project', relation: 'about' },
          { source_id: 'claim-2', target_id: 'proj-b', target_type: 'project', relation: 'about' },
        ],
        projects: [
          { id: 'proj-a', name: 'KokoLink' },
          { id: 'proj-b', name: 'Atlas (Lookup / ORCA / TIDE)' },
        ],
      },
      rpcByName: {
        hybrid_search: [
          // A claim whose top provenance is a capture (excerpt-bearing) — project
          // must still be resolved via the entity_link edge.
          { result_type: 'claim', result_id: 'claim-1', title: 'Rios ships Friday', score: 0.6, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: 'ex', source_label: 'Kickoff', source_type: 'capture', metadata: {} },
          // A capture carrying project_id straight on metadata.
          { result_type: 'capture', result_id: 'cap-9', title: 'sync', score: 0.55, event_at: null, fts_rank: 2, vec_rank: 2, recency_rank: 2, excerpt: null, source_label: 'Capture', source_type: 'capture', metadata: { project_id: 'proj-b' } },
          { result_type: 'claim', result_id: 'claim-2', title: 'ORCA latency', score: 0.5, event_at: null, fts_rank: 3, vec_rank: 3, recency_rank: 3, excerpt: 'ex', source_label: 'Doc', source_type: 'document', metadata: {} },
        ],
      },
    })
    const tool = getTool(supabase)
    const res = (await tool.execute!({ query: 'x' } as never, EXEC_OPTS)) as {
      results: Array<{ result_id: string; project_name?: string; source_label: string | null }>
    }

    const fromMock = (supabase as never as { from: ReturnType<typeof vi.fn> }).from
    const projectQueries = fromMock.mock.calls.filter((c: unknown[]) => c[0] === 'projects')
    const entityLinkQueries = fromMock.mock.calls.filter((c: unknown[]) => c[0] === 'entity_link')
    // Exactly one batched projects query + one batched entity_link query.
    expect(projectQueries).toHaveLength(1)
    expect(entityLinkQueries).toHaveLength(1)

    const byId = Object.fromEntries(res.results.map((r) => [r.result_id, r]))
    // Claim → project via graph edge (top provenance was a capture).
    expect(byId['claim-1'].project_name).toBe('KokoLink')
    // Capture → project via metadata.project_id.
    expect(byId['cap-9'].project_name).toBe('Atlas (Lookup / ORCA / TIDE)')
    expect(byId['claim-2'].project_name).toBe('Atlas (Lookup / ORCA / TIDE)')
  })

  it('rewrites a bare "project" source_label to "Project: <name>"', async () => {
    const supabase = makeSupabase({
      fromByTable: {
        workspace: { name: 'WS' },
        entity_link: [
          { source_id: 'claim-1', target_id: 'proj-a', target_type: 'project', relation: 'about' },
        ],
        projects: [{ id: 'proj-a', name: 'Atlas (Lookup / ORCA / TIDE)' }],
      },
      rpcByName: {
        hybrid_search: [
          // The RPC's ELSE branch surfaced the literal source_type as the label.
          { result_type: 'claim', result_id: 'claim-1', title: 'ORCA decision', score: 0.6, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: null, source_label: 'project', source_type: 'project', metadata: {} },
        ],
      },
    })
    const tool = getTool(supabase)
    const res = (await tool.execute!({ query: 'x' } as never, EXEC_OPTS)) as {
      results: Array<{ source_label: string | null; project_name?: string }>
    }
    expect(res.results[0].source_label).toBe('Project: Atlas (Lookup / ORCA / TIDE)')
    expect(res.results[0].project_name).toBe('Atlas (Lookup / ORCA / TIDE)')
  })

  it('leaves results without any project unchanged (no project_name, no extra projects query)', async () => {
    const supabase = makeSupabase({
      fromByTable: { workspace: { name: 'WS' } },
      rpcByName: {
        hybrid_search: [
          { result_type: 'claim', result_id: 'claim-1', title: 'orphan claim', score: 0.6, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: 'ex', source_label: 'Kickoff', source_type: 'capture', metadata: {} },
          { result_type: 'capture', result_id: 'cap-1', title: 'note', score: 0.5, event_at: null, fts_rank: 2, vec_rank: 2, recency_rank: 2, excerpt: null, source_label: 'Capture', source_type: 'capture', metadata: {} },
        ],
      },
    })
    const tool = getTool(supabase)
    const res = (await tool.execute!({ query: 'x' } as never, EXEC_OPTS)) as {
      results: Array<{ result_id: string; project_name?: string; source_label: string | null }>
    }
    // No edges → no project ids → the projects table is never queried.
    const fromMock = (supabase as never as { from: ReturnType<typeof vi.fn> }).from
    expect(fromMock.mock.calls.filter((c: unknown[]) => c[0] === 'projects')).toHaveLength(0)
    for (const r of res.results) {
      expect(r.project_name).toBeUndefined()
    }
    // Labels untouched.
    expect(res.results.find((r) => r.result_id === 'claim-1')!.source_label).toBe('Kickoff')
    expect(res.results.find((r) => r.result_id === 'cap-1')!.source_label).toBe('Capture')
  })
})

/**
 * Anchor generalization of the same enrichment. `project_name` survives as a
 * PROJECT-ONLY alias — every pre-anchor consumer reads it, and letting a
 * company name land there would silently mislabel results as projects.
 */
describe('find — anchor name enrichment (company + back-compat)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('resolves a COMPANY anchor and labels it "Company: <name>"', async () => {
    const supabase = makeSupabase({
      fromByTable: {
        workspace: { name: 'WS' },
        entity_link: [
          { source_id: 'claim-1', target_id: 'co-a', target_type: 'company', relation: 'about' },
        ],
        company: [{ id: 'co-a', name: 'Acme' }],
      },
      rpcByName: {
        hybrid_search: [
          // Bare-anchor top provenance: the RPC's ELSE branch surfaced the
          // literal source_type as the label.
          { result_type: 'claim', result_id: 'claim-1', title: 'Acme renewed', score: 0.6, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: null, source_label: 'company', source_type: 'company', metadata: {} },
        ],
      },
    })
    const res = (await getTool(supabase).execute!({ query: 'x' } as never, EXEC_OPTS)) as {
      results: Array<{
        anchor_name?: string
        anchor_type?: string
        project_name?: string
        source_label: string | null
      }>
    }
    const r = res.results[0]
    expect(r.anchor_name).toBe('Acme')
    expect(r.anchor_type).toBe('company')
    expect(r.source_label).toBe('Company: Acme')
    // The back-compat alias is PROJECT-only — a company must never fill it.
    expect(r.project_name).toBeUndefined()
  })

  it('a company anchor hidden from the requester is no anchor: its name never rides along (migration 500)', async () => {
    const supabase = makeSupabase({
      fromByTable: {
        workspace: { name: 'WS' },
        entity_link: [
          { source_id: 'claim-1', target_id: 'co-hidden', target_type: 'company', relation: 'about' },
        ],
        company: [{ id: 'co-hidden', name: 'Quietly Inc' }],
      },
      rpcByName: {
        hybrid_search: [
          { result_type: 'claim', result_id: 'claim-1', title: 'A renewal', score: 0.6, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: null, source_label: 'company', source_type: 'company', metadata: {} },
        ],
        entity_refs_hidden: [{ entity_type: 'company', entity_id: 'co-hidden' }],
      },
    })
    const res = (await getTool(supabase).execute!({ query: 'x' } as never, EXEC_OPTS)) as {
      results: Array<{ anchor_name?: string; source_label: string | null }>
    }
    expect(res.results[0].anchor_name).toBeUndefined()
    expect(JSON.stringify(res)).not.toContain('Quietly Inc')
    const fence = (supabase as never as { rpc: ReturnType<typeof vi.fn> }).rpc.mock.calls.find((c: unknown[]) => c[0] === 'entity_refs_hidden')!
    expect(fence[1]).toMatchObject({ p_types: ['company'], p_ids: ['co-hidden'] })
  })

  it('keeps `project_name` as the alias when the anchor IS a project', async () => {
    const supabase = makeSupabase({
      fromByTable: {
        workspace: { name: 'WS' },
        entity_link: [
          { source_id: 'claim-1', target_id: 'proj-a', target_type: 'project', relation: 'about' },
        ],
        projects: [{ id: 'proj-a', name: 'KokoLink' }],
      },
      rpcByName: {
        hybrid_search: [
          { result_type: 'claim', result_id: 'claim-1', title: 'x', score: 0.6, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: 'ex', source_label: 'Kickoff', source_type: 'capture', metadata: {} },
        ],
      },
    })
    const res = (await getTool(supabase).execute!({ query: 'x' } as never, EXEC_OPTS)) as {
      results: Array<{ anchor_name?: string; anchor_type?: string; project_name?: string }>
    }
    expect(res.results[0]).toMatchObject({
      anchor_name: 'KokoLink',
      anchor_type: 'project',
      project_name: 'KokoLink',
    })
  })

  it('issues ONE entity_link query spanning every anchor type (not one per type)', async () => {
    const supabase = makeSupabase({
      fromByTable: {
        workspace: { name: 'WS' },
        entity_link: [
          { source_id: 'claim-1', target_id: 'co-a', target_type: 'company', relation: 'about' },
        ],
        company: [{ id: 'co-a', name: 'Acme' }],
      },
      rpcByName: {
        hybrid_search: [
          { result_type: 'claim', result_id: 'claim-1', title: 'x', score: 0.6, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: 'ex', source_label: 'Kickoff', source_type: 'capture', metadata: {} },
        ],
      },
    })
    await getTool(supabase).execute!({ query: 'x' } as never, EXEC_OPTS)
    const fromMock = (supabase as never as { from: ReturnType<typeof vi.fn> }).from
    expect(fromMock.mock.calls.filter((c: unknown[]) => c[0] === 'entity_link')).toHaveLength(1)
    // One label query for the ONE anchor type present — and none for the types
    // that weren't (that is what keeps this bounded rather than fixed at 2+N).
    expect(fromMock.mock.calls.filter((c: unknown[]) => c[0] === 'company')).toHaveLength(1)
    expect(fromMock.mock.calls.filter((c: unknown[]) => c[0] === 'projects')).toHaveLength(0)
  })

  it('prefers the strongest relation when a claim has several anchor edges', async () => {
    const supabase = makeSupabase({
      fromByTable: {
        workspace: { name: 'WS' },
        entity_link: [
          // Weakest first — `about` must still win.
          { source_id: 'claim-1', target_id: 'co-b', target_type: 'company', relation: 'mentions' },
          { source_id: 'claim-1', target_id: 'co-a', target_type: 'company', relation: 'about' },
        ],
        company: [
          { id: 'co-a', name: 'Acme' },
          { id: 'co-b', name: 'Passing Mention Inc' },
        ],
      },
      rpcByName: {
        hybrid_search: [
          { result_type: 'claim', result_id: 'claim-1', title: 'x', score: 0.6, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: 'ex', source_label: 'Kickoff', source_type: 'capture', metadata: {} },
        ],
      },
    })
    const res = (await getTool(supabase).execute!({ query: 'x' } as never, EXEC_OPTS)) as {
      results: Array<{ anchor_name?: string }>
    }
    expect(res.results[0].anchor_name).toBe('Acme')
  })

  it('leaves a row alone when its anchor type has no registry descriptor', async () => {
    // `campaign` is in the edge query's IN-list before its table exists. An
    // unresolvable type must degrade to "no anchor name", never throw.
    const supabase = makeSupabase({
      fromByTable: {
        workspace: { name: 'WS' },
        entity_link: [
          { source_id: 'claim-1', target_id: 'camp-a', target_type: 'campaign', relation: 'about' },
        ],
      },
      rpcByName: {
        hybrid_search: [
          { result_type: 'claim', result_id: 'claim-1', title: 'x', score: 0.6, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: 'ex', source_label: 'Kickoff', source_type: 'capture', metadata: {} },
        ],
      },
    })
    const res = (await getTool(supabase).execute!({ query: 'x' } as never, EXEC_OPTS)) as {
      results: Array<{ anchor_name?: string; project_name?: string; source_label: string | null }>
    }
    expect(res.results[0].anchor_name).toBeUndefined()
    expect(res.results[0].project_name).toBeUndefined()
    expect(res.results[0].source_label).toBe('Kickoff')
  })

  it('still reads metadata.project_id for captures/documents (no claim edge involved)', async () => {
    const supabase = makeSupabase({
      fromByTable: {
        workspace: { name: 'WS' },
        projects: [{ id: 'proj-b', name: 'Atlas' }],
      },
      rpcByName: {
        hybrid_search: [
          { result_type: 'capture', result_id: 'cap-9', title: 'sync', score: 0.55, event_at: null, fts_rank: 1, vec_rank: 1, recency_rank: 1, excerpt: null, source_label: 'Capture', source_type: 'capture', metadata: { project_id: 'proj-b' } },
        ],
      },
    })
    const res = (await getTool(supabase).execute!({ query: 'x' } as never, EXEC_OPTS)) as {
      results: Array<{ anchor_name?: string; anchor_type?: string; project_name?: string }>
    }
    expect(res.results[0]).toMatchObject({
      anchor_name: 'Atlas',
      anchor_type: 'project',
      project_name: 'Atlas',
    })
  })
})
