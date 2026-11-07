/**
 * Tests for the mechanical about→project edge backfill (knowledge-recall plan
 * item 15). The decision logic is a PURE function (computeProjectEdgePlan) — no
 * database — so these are straight input→output assertions. A couple of
 * integration-shaped tests exercise runProjectEdgeBackfill's dry-run counting
 * and idempotent-write branch against a tiny Supabase double.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  computeProjectEdgePlan,
  runProjectEdgeBackfill,
  type CandidateClaim,
  type ClaimSourceRef,
} from '../project-edge-backfill'

const WS = 'ws-1'

// ── computeProjectEdgePlan (pure) ────────────────────────────────────────────

describe('computeProjectEdgePlan', () => {
  it('writes one about→project edge for a claim whose document source resolves', () => {
    const claims: CandidateClaim[] = [{ id: 'c1', workspace_id: WS }]
    const sources: ClaimSourceRef[] = [
      { claim_id: 'c1', source_type: 'document', source_id: 'doc1' },
    ]
    const projectByEntity = new Map([['document:doc1', 'proj-A']])

    const plan = computeProjectEdgePlan(claims, sources, projectByEntity)
    expect(plan.edges).toEqual([
      {
        workspace_id: WS,
        source_type: 'claim',
        source_id: 'c1',
        target_type: 'project',
        target_id: 'proj-A',
        relation: 'about',
      },
    ])
    expect(plan.unresolvedClaimIds).toEqual([])
    expect(plan.ambiguousClaimIds).toEqual([])
  })

  it('resolves capture and attachment sources too', () => {
    const claims: CandidateClaim[] = [
      { id: 'c-cap', workspace_id: WS },
      { id: 'c-att', workspace_id: WS },
    ]
    const sources: ClaimSourceRef[] = [
      { claim_id: 'c-cap', source_type: 'capture', source_id: 'cap1' },
      { claim_id: 'c-att', source_type: 'attachment', source_id: 'att1' },
    ]
    const projectByEntity = new Map([
      ['capture:cap1', 'proj-cap'],
      ['attachment:att1', 'proj-att'],
    ])
    const plan = computeProjectEdgePlan(claims, sources, projectByEntity)
    expect(plan.edges.map((e) => [e.source_id, e.target_id])).toEqual([
      ['c-cap', 'proj-cap'],
      ['c-att', 'proj-att'],
    ])
  })

  it('leaves a claim unresolved when no source has a project', () => {
    const claims: CandidateClaim[] = [{ id: 'c1', workspace_id: WS }]
    const sources: ClaimSourceRef[] = [
      { claim_id: 'c1', source_type: 'capture', source_id: 'cap1' },
    ]
    const projectByEntity = new Map<string, string>() // cap1 has no project

    const plan = computeProjectEdgePlan(claims, sources, projectByEntity)
    expect(plan.edges).toEqual([])
    expect(plan.unresolvedClaimIds).toEqual(['c1'])
  })

  it('ignores email / conversation / external_url / manual sources entirely', () => {
    const claims: CandidateClaim[] = [{ id: 'c1', workspace_id: WS }]
    const sources: ClaimSourceRef[] = [
      { claim_id: 'c1', source_type: 'email', source_id: 'em1' },
      { claim_id: 'c1', source_type: 'conversation', source_id: 'conv1' },
      { claim_id: 'c1', source_type: 'external_url', source_id: null },
      { claim_id: 'c1', source_type: 'manual', source_id: 'm1' },
    ]
    // Even if a stray project mapping existed for these, they aren't project-bearing.
    const projectByEntity = new Map([['email:em1', 'proj-X']])
    const plan = computeProjectEdgePlan(claims, sources, projectByEntity)
    expect(plan.edges).toEqual([])
    expect(plan.unresolvedClaimIds).toEqual(['c1'])
  })

  it('picks the FIRST resolvable project deterministically and flags ambiguity', () => {
    const claims: CandidateClaim[] = [{ id: 'c1', workspace_id: WS }]
    const sources: ClaimSourceRef[] = [
      { claim_id: 'c1', source_type: 'document', source_id: 'doc1' }, // proj-A (first)
      { claim_id: 'c1', source_type: 'capture', source_id: 'cap1' }, // proj-B
    ]
    const projectByEntity = new Map([
      ['document:doc1', 'proj-A'],
      ['capture:cap1', 'proj-B'],
    ])
    const plan = computeProjectEdgePlan(claims, sources, projectByEntity)
    expect(plan.edges).toHaveLength(1)
    expect(plan.edges[0].target_id).toBe('proj-A')
    expect(plan.ambiguousClaimIds).toEqual(['c1'])
  })

  it('does NOT flag ambiguity when multiple sources resolve to the SAME project', () => {
    const claims: CandidateClaim[] = [{ id: 'c1', workspace_id: WS }]
    const sources: ClaimSourceRef[] = [
      { claim_id: 'c1', source_type: 'document', source_id: 'doc1' },
      { claim_id: 'c1', source_type: 'capture', source_id: 'cap1' },
    ]
    const projectByEntity = new Map([
      ['document:doc1', 'proj-A'],
      ['capture:cap1', 'proj-A'],
    ])
    const plan = computeProjectEdgePlan(claims, sources, projectByEntity)
    expect(plan.edges).toHaveLength(1)
    expect(plan.ambiguousClaimIds).toEqual([])
  })

  it('ignores sources for claims that are not in the candidate set', () => {
    const claims: CandidateClaim[] = [{ id: 'c1', workspace_id: WS }]
    const sources: ClaimSourceRef[] = [
      { claim_id: 'c1', source_type: 'document', source_id: 'doc1' },
      { claim_id: 'other', source_type: 'document', source_id: 'doc2' }, // not a candidate
    ]
    const projectByEntity = new Map([
      ['document:doc1', 'proj-A'],
      ['document:doc2', 'proj-B'],
    ])
    const plan = computeProjectEdgePlan(claims, sources, projectByEntity)
    expect(plan.edges.map((e) => e.source_id)).toEqual(['c1'])
  })
})

// ── runProjectEdgeBackfill (dry-run vs apply, over a small double) ────────────

/** Minimal Supabase double covering the exact query shapes the orchestrator uses. */
function makeSupabase(opts: {
  claims: Array<{ id: string; workspace_id: string; status: string }>
  existingEdgeSourceIds?: string[] // claims that already have an about→project edge
  claimSources?: ClaimSourceRef[]
  captureProjects?: Record<string, string | null>
  documentProjects?: Record<string, string | null>
  attachmentProjects?: Record<string, string | null>
  attachmentChunkProjects?: Record<string, string | null>
  onUpsert?: (rows: unknown[]) => void
}) {
  const from = vi.fn((table: string) => {
    const state: {
      eqs: Record<string, unknown>
      ins: Record<string, unknown[]>
      range?: [number, number]
      notNull?: string
    } = { eqs: {}, ins: {} }

    const run = () => {
      if (table === 'claim') {
        let rows = opts.claims.filter((c) => c.status === (state.eqs['status'] ?? c.status))
        if (state.eqs['workspace_id']) rows = rows.filter((c) => c.workspace_id === state.eqs['workspace_id'])
        if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1)
        return { data: rows.map((c) => ({ id: c.id, workspace_id: c.workspace_id })), error: null }
      }
      if (table === 'entity_link') {
        const ids = state.ins['source_id'] ?? []
        const data = (opts.existingEdgeSourceIds ?? [])
          .filter((id) => ids.includes(id))
          .map((id) => ({ source_id: id }))
        return { data, error: null }
      }
      if (table === 'claim_source') {
        const ids = state.ins['claim_id'] ?? []
        const types = state.ins['source_type'] ?? []
        const data = (opts.claimSources ?? []).filter(
          (s) =>
            ids.includes(s.claim_id) &&
            (types.length === 0 || types.includes(s.source_type)) &&
            s.source_id != null,
        )
        return { data, error: null }
      }
      if (table === 'captures' || table === 'document' || table === 'attachments' || table === 'attachment_chunks') {
        const map =
          table === 'captures'
            ? opts.captureProjects
            : table === 'document'
              ? opts.documentProjects
              : table === 'attachments'
                ? opts.attachmentProjects
                : opts.attachmentChunkProjects
        const idCol = table === 'attachment_chunks' ? 'attachment_id' : 'id'
        const ids = state.ins[idCol] ?? []
        const data = ids
          .map((id) => ({ [idCol]: id as string, project_id: map?.[id as string] ?? null }))
          .filter((r) => (state.notNull === 'project_id' ? r.project_id != null : true))
        return { data, error: null }
      }
      return { data: [], error: null }
    }

    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
      upsert: (rows: unknown[]) => {
        opts.onUpsert?.(rows)
        return { then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r) }
      },
    }
    const proxy: Record<string, unknown> = new Proxy(chain, {
      get(t, p: string) {
        if (p in t) return t[p]
        if (p === 'eq') return (col: string, val: unknown) => ((state.eqs[col] = val), proxy)
        if (p === 'in') return (col: string, vals: unknown[]) => ((state.ins[col] = vals), proxy)
        if (p === 'range') return (a: number, b: number) => ((state.range = [a, b]), proxy)
        if (p === 'not') return (col: string) => ((state.notNull = col), proxy)
        return () => proxy
      },
    })
    return proxy
  })
  return { from } as never
}

describe('runProjectEdgeBackfill', () => {
  it('DRY-RUN counts edges without writing', async () => {
    const upserts: unknown[][] = []
    const supabase = makeSupabase({
      claims: [{ id: 'c1', workspace_id: WS, status: 'active' }],
      claimSources: [{ claim_id: 'c1', source_type: 'document', source_id: 'doc1' }],
      documentProjects: { doc1: 'proj-A' },
      onUpsert: (rows) => upserts.push(rows),
    })
    const summary = await runProjectEdgeBackfill(supabase, { apply: false, pageSize: 100 })
    expect(summary.applied).toBe(false)
    expect(summary.candidates).toBe(1)
    expect(summary.edgesPlanned).toBe(1)
    expect(summary.edgesWritten).toBe(0)
    expect(upserts).toHaveLength(0) // nothing written in dry-run
  })

  it('APPLY upserts the planned edges', async () => {
    const upserts: unknown[][] = []
    const supabase = makeSupabase({
      claims: [{ id: 'c1', workspace_id: WS, status: 'active' }],
      claimSources: [{ claim_id: 'c1', source_type: 'capture', source_id: 'cap1' }],
      captureProjects: { cap1: 'proj-B' },
      onUpsert: (rows) => upserts.push(rows),
    })
    const summary = await runProjectEdgeBackfill(supabase, { apply: true, pageSize: 100 })
    expect(summary.edgesWritten).toBe(1)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toEqual([
      expect.objectContaining({
        source_type: 'claim',
        source_id: 'c1',
        target_type: 'project',
        target_id: 'proj-B',
        relation: 'about',
      }),
    ])
  })

  it('skips claims that already have an about→project edge', async () => {
    const supabase = makeSupabase({
      claims: [{ id: 'c1', workspace_id: WS, status: 'active' }],
      existingEdgeSourceIds: ['c1'], // already linked
      claimSources: [{ claim_id: 'c1', source_type: 'document', source_id: 'doc1' }],
      documentProjects: { doc1: 'proj-A' },
    })
    const summary = await runProjectEdgeBackfill(supabase, { apply: true, pageSize: 100 })
    expect(summary.scanned).toBe(1)
    expect(summary.candidates).toBe(0)
    expect(summary.edgesPlanned).toBe(0)
  })

  it('falls back to attachment_chunks.project_id when the attachment row has none', async () => {
    const supabase = makeSupabase({
      claims: [{ id: 'c1', workspace_id: WS, status: 'active' }],
      claimSources: [{ claim_id: 'c1', source_type: 'attachment', source_id: 'att1' }],
      attachmentProjects: { att1: null }, // no direct project on the attachment row
      attachmentChunkProjects: { att1: 'proj-chunk' },
    })
    const summary = await runProjectEdgeBackfill(supabase, { apply: false, pageSize: 100 })
    expect(summary.edgesPlanned).toBe(1)
  })
})
