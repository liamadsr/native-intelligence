/**
 * Tests for attachClaimProvenance — the single helper that keeps a claim's two
 * provenance stores reconciled (GEN-105 / GEN-106 / GEN-108).
 *
 * Invariants locked in:
 *  - An internal source (has source_id) writes BOTH a claim_source row AND a
 *    mirrored entity_link edge (so the graph round-trips — GEN-106).
 *  - An external_url / manual source writes ONLY claim_source (no entity to
 *    point an edge at).
 *  - A cites/about link to a citable entity ALSO registers as a claim_source
 *    (so evidence reflects the edge — GEN-108).
 *  - A source and a link pointing at the same entity de-dupe to one edge.
 *
 * Vitest unit tests (no network, no DB).
 */
import { describe, it, expect, vi } from 'vitest'
import { attachClaimProvenance } from '../claim-provenance'

const WS = 'ws-1'
const CLAIM = 'claim-1'
const MEMBER = 'member-1'

/**
 * Build a supabase stub that records every upsert/insert per table.
 * Each from(table) returns a chain whose upsert/insert capture their payload
 * and resolve to a success result.
 *
 * `opts.claimEventAt` seeds the claim's CURRENT event_at. The LEAST forward-fill
 * is now a single atomic conditional UPDATE (no prior SELECT):
 *   .update({event_at: minIncoming}).eq('id',..).or('event_at.is.null,event_at.gt.<min>')
 * This double EMULATES Postgres' post-lock predicate re-evaluation: the update
 * is recorded under calls.claim_update ONLY when the seeded current value would
 * satisfy `event_at IS NULL OR event_at > minIncoming` — i.e. only when the
 * incoming time is strictly earlier (or the claim has none). That keeps the
 * LEAST-semantics assertions (earlier wins / later no-op / null → set) intact
 * against the new single-query shape.
 */
function recordingSupabase(opts: { claimEventAt?: string | null } = {}) {
  const calls: Record<string, unknown[][]> = {
    claim_source: [],
    entity_link: [],
    claim_update: [],
  }
  const from = vi.fn((table: string) => {
    const record = (bucket: string, rows: unknown) => {
      calls[bucket] = calls[bucket] ?? []
      calls[bucket].push(Array.isArray(rows) ? rows : [rows])
      return Promise.resolve({ data: null, error: null })
    }
    return {
      upsert: vi.fn((rows: unknown) => record(table, rows)),
      insert: vi.fn((rows: unknown) => record(table, rows)),
      // claim.event_at LEAST update (atomic, TOCTOU-free):
      //   .update({event_at}).eq('id',..).or('event_at.is.null,event_at.gt.<min>')
      // The .or() is terminal; emulate the DB predicate against the seeded
      // current value so the recorded update reflects what Postgres would write.
      update: vi.fn((payload: unknown) => ({
        eq: vi.fn(() => ({
          or: vi.fn((clause: string) => {
            const current = opts.claimEventAt ?? null
            const minIncoming = (payload as { event_at?: string }).event_at
            // Parse the `event_at.gt.<iso>` bound out of the or-clause.
            const gtMatch = /event_at\.gt\.(.+)$/.exec(clause)
            const gtBound = gtMatch ? gtMatch[1] : minIncoming
            const predicateMatches =
              current === null ||
              (gtBound != null && Date.parse(current) > Date.parse(gtBound))
            if (predicateMatches) record('claim_update', payload)
            return Promise.resolve({ data: null, error: null })
          }),
        })),
      })),
    }
  })
  return { supabase: { from } as never, calls }
}

describe('attachClaimProvenance', () => {
  it('writes claim_source AND a mirrored entity_link for an internal source', async () => {
    const { supabase, calls } = recordingSupabase()
    const res = await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      sources: [{ source_type: 'capture', source_id: 'cap-1', excerpt: 'snippet', relation: 'cites' }],
    })
    expect(res.errors).toEqual([])
    // claim_source row written
    const srcRows = calls.claim_source.flat() as Array<Record<string, unknown>>
    expect(srcRows).toHaveLength(1)
    expect(srcRows[0]).toMatchObject({ claim_id: CLAIM, source_type: 'capture', source_id: 'cap-1', excerpt: 'snippet' })
    // mirrored cites edge written
    const edgeRows = calls.entity_link.flat() as Array<Record<string, unknown>>
    expect(edgeRows).toHaveLength(1)
    expect(edgeRows[0]).toMatchObject({
      workspace_id: WS,
      source_type: 'claim',
      source_id: CLAIM,
      target_type: 'capture',
      target_id: 'cap-1',
      relation: 'cites',
    })
  })

  it('writes only claim_source for an external_url source (no entity to link)', async () => {
    const { supabase, calls } = recordingSupabase()
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      sources: [{ source_type: 'external_url', source_uri: 'https://example.com', excerpt: 'x' }],
    })
    expect(calls.claim_source.flat()).toHaveLength(1)
    expect(calls.entity_link).toHaveLength(0)
  })

  it('persists a manual source that carries only an excerpt (no id/uri) — pasted/uploaded evidence', async () => {
    const { supabase, calls } = recordingSupabase()
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      sources: [{ source_type: 'manual', excerpt: 'verbatim line from the uploaded markdown file' }],
    })
    // the excerpt IS the evidence — it must persist as a claim_source row
    const srcRows = calls.claim_source.flat() as Array<Record<string, unknown>>
    expect(srcRows).toHaveLength(1)
    expect(srcRows[0]).toMatchObject({
      claim_id: CLAIM,
      source_type: 'manual',
      source_id: null,
      source_uri: null,
      excerpt: 'verbatim line from the uploaded markdown file',
    })
    // nothing to anchor a graph edge to
    expect(calls.entity_link).toHaveLength(0)
  })

  it('skips a source that anchors to nothing AND has no excerpt', async () => {
    const { supabase, calls } = recordingSupabase()
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      sources: [{ source_type: 'manual' }],
    })
    expect(calls.claim_source).toHaveLength(0)
    expect(calls.entity_link).toHaveLength(0)
  })

  it('cross-populates claim_source for a cites/about link to a citable entity (GEN-108)', async () => {
    const { supabase, calls } = recordingSupabase()
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      links: [{ entity_type: 'capture', entity_id: 'cap-9', relation: 'cites' }],
    })
    // edge written
    const edgeRows = calls.entity_link.flat() as Array<Record<string, unknown>>
    expect(edgeRows).toHaveLength(1)
    expect(edgeRows[0]).toMatchObject({ target_type: 'capture', target_id: 'cap-9', relation: 'cites' })
    // AND mirrored as a source so evidence reflects the edge
    const srcRows = calls.claim_source.flat() as Array<Record<string, unknown>>
    expect(srcRows).toHaveLength(1)
    expect(srcRows[0]).toMatchObject({ claim_id: CLAIM, source_type: 'capture', source_id: 'cap-9' })
  })

  it('does NOT cross-populate a non-evidence relation (e.g. depends_on)', async () => {
    const { supabase, calls } = recordingSupabase()
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      links: [{ entity_type: 'project', entity_id: 'proj-1', relation: 'depends_on' }],
    })
    expect(calls.entity_link.flat()).toHaveLength(1)
    expect(calls.claim_source).toHaveLength(0)
  })

  it('de-dupes a source and a link that point at the same entity+relation into one edge', async () => {
    const { supabase, calls } = recordingSupabase()
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      sources: [{ source_type: 'capture', source_id: 'cap-1', relation: 'cites' }],
      links: [{ entity_type: 'capture', entity_id: 'cap-1', relation: 'cites' }],
    })
    // one edge, not two
    expect(calls.entity_link.flat()).toHaveLength(1)
  })

  it('skips a self-referential claim link', async () => {
    const { supabase, calls } = recordingSupabase()
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      links: [{ entity_type: 'claim', entity_id: CLAIM, relation: 'about' }],
    })
    expect(calls.entity_link).toHaveLength(0)
  })

  // --- event_at LEAST forward-fill (mig 180) --------------------------------

  it('pulls event_at back when a source is EARLIER than the claim current event_at', async () => {
    const { supabase, calls } = recordingSupabase({ claimEventAt: '2026-06-01T00:00:00Z' })
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      sources: [
        { source_type: 'email', source_id: 'em-1', excerpt: 'x', eventAt: '2026-05-01T00:00:00Z' },
      ],
    })
    expect(calls.claim_update.flat()).toEqual([{ event_at: '2026-05-01T00:00:00Z' }])
  })

  it('sets event_at when the claim has none yet (LEAST(NULL, new) = new)', async () => {
    const { supabase, calls } = recordingSupabase({ claimEventAt: null })
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      sources: [
        { source_type: 'capture', source_id: 'cap-1', excerpt: 'x', eventAt: '2026-05-01T00:00:00Z' },
      ],
    })
    expect(calls.claim_update.flat()).toEqual([{ event_at: '2026-05-01T00:00:00Z' }])
  })

  it('does NOT touch event_at when the incoming source is LATER (or equal)', async () => {
    const { supabase, calls } = recordingSupabase({ claimEventAt: '2026-05-01T00:00:00Z' })
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      sources: [
        { source_type: 'email', source_id: 'em-1', excerpt: 'x', eventAt: '2026-06-01T00:00:00Z' },
      ],
    })
    expect(calls.claim_update).toHaveLength(0)
  })

  it('uses the MIN across multiple sources and compares by instant, not string', async () => {
    // The earliest source (offset-form) predates the claim; the later one does
    // not. Only the earliest should drive the update, compared by real instant.
    const { supabase, calls } = recordingSupabase({ claimEventAt: '2026-06-01T00:00:00Z' })
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      sources: [
        { source_type: 'email', source_id: 'em-late', excerpt: 'x', eventAt: '2026-07-01T00:00:00Z' },
        { source_type: 'capture', source_id: 'cap-early', excerpt: 'y', eventAt: '2026-04-15T12:00:00-07:00' },
      ],
    })
    expect(calls.claim_update.flat()).toEqual([{ event_at: '2026-04-15T12:00:00-07:00' }])
  })

  it('ignores sources with no eventAt (never reads/updates the claim)', async () => {
    const { supabase, calls } = recordingSupabase({ claimEventAt: '2026-06-01T00:00:00Z' })
    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      sources: [{ source_type: 'capture', source_id: 'cap-1', excerpt: 'x' }],
    })
    expect(calls.claim_update).toHaveLength(0)
  })

  it('does the forward-fill as ONE atomic conditional UPDATE — no prior SELECT (TOCTOU-free)', async () => {
    // Spy on the claim-table chain to assert the shape: update(...).eq(...).or(...)
    // with the LEAST predicate, and NO select() (the old read-then-write race).
    const orSpy = vi.fn((_clause: string) => Promise.resolve({ data: null, error: null }))
    const eqSpy = vi.fn(() => ({ or: orSpy }))
    const updateSpy = vi.fn((_payload: unknown) => ({ eq: eqSpy }))
    const selectSpy = vi.fn()
    const from = vi.fn((table: string) => {
      if (table === 'claim') {
        return { update: updateSpy, select: selectSpy }
      }
      return {
        upsert: vi.fn(() => Promise.resolve({ data: null, error: null })),
        insert: vi.fn(() => Promise.resolve({ data: null, error: null })),
      }
    })
    const supabase = { from } as never

    await attachClaimProvenance(supabase, {
      claimId: CLAIM,
      workspaceId: WS,
      memberId: MEMBER,
      sources: [
        { source_type: 'email', source_id: 'em-1', excerpt: 'x', eventAt: '2026-05-01T00:00:00Z' },
      ],
    })

    // Single atomic update, predicated on the LEAST condition, no prior read.
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy).toHaveBeenCalledWith({ event_at: '2026-05-01T00:00:00Z' })
    expect(orSpy).toHaveBeenCalledTimes(1)
    const orClause = orSpy.mock.calls[0][0]
    expect(orClause).toBe('event_at.is.null,event_at.gt.2026-05-01T00:00:00Z')
    // The claim table is NEVER read for event_at (the race is gone).
    expect(selectSpy).not.toHaveBeenCalled()
  })
})
