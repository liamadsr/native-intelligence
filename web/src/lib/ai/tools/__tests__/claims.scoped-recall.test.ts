/**
 * Tests for list_claims' scoped-recall delta additions (knowledge-recall plan
 * items 14-15, design-scopedRecall §B1):
 *   - group_by_change → new / newly_confirmed / superseded buckets, including
 *     the internal union of status='superseded' rows even though the default
 *     status filter is 'active'.
 *   - include_provenance → batched reconcileProvenance attached per claim.
 *
 * The Supabase double is FILTER-AWARE: a from('claim') chain records its `.eq`
 * / `.in` / `.or` calls and, on await, filters a fixture dataset so the two
 * status queries (active + superseded) return their correct rows. That lets us
 * assert the bucket logic against a realistic split rather than a canned array.
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
}

/** A filter-aware Supabase double.
 *
 * from('claim')      → returns claims matching the recorded eq/in filters
 * from('claim_source') / from('entity_link') → returns provenance fixtures,
 *   respecting the reconcileProvenance shape (.in('claim_id', …) / .in('source_id', …)).
 */
function makeSupabase(opts: {
  claims: ClaimFixture[]
  entityLinkClaimIds?: string[] // ids returned by the entity-filter resolution
  claimSources?: Array<{ claim_id: string; source_type: string; source_id: string | null; source_uri: string | null; excerpt: string | null }>
  claimEdges?: Array<{ source_id: string; target_type: string; target_id: string | null; relation: string }>
}) {
  const from = vi.fn((table: string) => {
    const filters: { eqs: Record<string, unknown>; ins: Record<string, unknown[]> } = {
      eqs: {},
      ins: {},
    }
    const chain: Record<string, unknown> = {
      then: (resolve: (v: unknown) => unknown) => {
        let data: unknown[] = []
        if (table === 'claim') {
          data = opts.claims.filter((c) => {
            for (const [col, val] of Object.entries(filters.eqs)) {
              if (col === 'workspace_id') continue
              if ((c as Record<string, unknown>)[col] !== val) return false
            }
            if (filters.ins['id'] && !filters.ins['id'].includes(c.id)) return false
            return true
          })
        } else if (table === 'entity_link') {
          // Either the entity-filter resolution (select source_id/target_id) or
          // reconcileProvenance's edge fetch (.in source_id). We disambiguate by
          // whether target_type='project'/entity filter eqs are present vs the
          // claim-source-type fetch. Simplest: honor .in('source_id') for prov,
          // else return the entity-filter id list.
          if (filters.ins['source_id']) {
            data = (opts.claimEdges ?? []).filter((e) => filters.ins['source_id'].includes(e.source_id))
          } else {
            data = (opts.entityLinkClaimIds ?? []).map((id) => ({ source_id: id, target_id: id }))
          }
        } else if (table === 'claim_source') {
          data = (opts.claimSources ?? []).filter(
            (s) => !filters.ins['claim_id'] || filters.ins['claim_id'].includes(s.claim_id),
          )
        } else if (table === 'captures') {
          // Provenance redaction resolves which referenced captures the requester
          // may see. These fixtures are all workspace-visible; the private-capture
          // case is covered in tools.capture-visibility.test.ts.
          data = ((filters.ins['id'] as string[]) ?? []).map((id) => ({ id }))
        } else if (table === 'document') {
          // Cited documents: all workspace-visible here (migration 369).
          data = ((filters.ins['id'] as string[]) ?? []).map((id) => ({ id, visibility: 'workspace', owner: null }))
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

// A fixed window: [2026-06-01, 2026-06-30]. All fixtures use ISO timestamps.
const SINCE = '2026-06-01T00:00:00.000Z'
const UNTIL = '2026-06-30T23:59:59.999Z'
const IN_WINDOW = '2026-06-15T12:00:00.000Z'
const BEFORE_WINDOW = '2026-05-01T00:00:00.000Z'
const AFTER_WINDOW = '2026-07-15T00:00:00.000Z'

function claim(p: Partial<ClaimFixture> & { id: string }): ClaimFixture {
  return {
    text: `claim ${p.id}`,
    type: 'fact',
    confirmation: 'suggested',
    status: 'active',
    scope: null,
    subject_member_id: null,
    superseded_by: null,
    created_at: IN_WINDOW,
    updated_at: IN_WINDOW,
    last_verified_at: null,
    confidence: null,
    ...p,
  }
}

describe('list_claims — group_by_change', () => {
  it('buckets a NEW claim (created_at in window, not dismissed) into new', async () => {
    const supabase = makeSupabase({
      claims: [claim({ id: 'c-new', created_at: IN_WINDOW, updated_at: IN_WINDOW })],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { group_by_change: true, since: SINCE, until: UNTIL } as never,
      EXEC_OPTS,
    )) as unknown as {
      grouped: boolean
      buckets: { new: ClaimFixture[]; newly_confirmed: ClaimFixture[]; superseded: ClaimFixture[] }
    }
    expect(res.grouped).toBe(true)
    expect(res.buckets.new.map((c) => c.id)).toEqual(['c-new'])
    expect(res.buckets.newly_confirmed).toHaveLength(0)
    expect(res.buckets.superseded).toHaveLength(0)
  })

  it('excludes a dismissed in-window claim from the new bucket', async () => {
    const supabase = makeSupabase({
      claims: [claim({ id: 'c-dismissed', confirmation: 'dismissed', created_at: IN_WINDOW })],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { group_by_change: true, since: SINCE, until: UNTIL } as never,
      EXEC_OPTS,
    )) as unknown as { buckets: { new: ClaimFixture[] } }
    expect(res.buckets.new).toHaveLength(0)
  })

  it('buckets a NEWLY_CONFIRMED claim (created before window, confirmed & updated in window)', async () => {
    const supabase = makeSupabase({
      claims: [
        claim({
          id: 'c-conf',
          confirmation: 'confirmed',
          created_at: BEFORE_WINDOW, // existed before
          updated_at: IN_WINDOW, // crossed to confirmed in-window
        }),
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { group_by_change: true, since: SINCE, until: UNTIL } as never,
      EXEC_OPTS,
    )) as unknown as {
      buckets: { new: ClaimFixture[]; newly_confirmed: ClaimFixture[] }
    }
    expect(res.buckets.newly_confirmed.map((c) => c.id)).toEqual(['c-conf'])
    // Not counted as "new" — it was created before the window.
    expect(res.buckets.new).toHaveLength(0)
  })

  it('does NOT count a claim born-confirmed in-window as newly_confirmed (that is new)', async () => {
    const supabase = makeSupabase({
      claims: [
        claim({
          id: 'c-born-conf',
          confirmation: 'confirmed',
          created_at: IN_WINDOW, // born in-window
          updated_at: IN_WINDOW,
        }),
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { group_by_change: true, since: SINCE, until: UNTIL } as never,
      EXEC_OPTS,
    )) as unknown as { buckets: { new: ClaimFixture[]; newly_confirmed: ClaimFixture[] } }
    expect(res.buckets.new.map((c) => c.id)).toEqual(['c-born-conf'])
    expect(res.buckets.newly_confirmed).toHaveLength(0)
  })

  it('unions superseded rows in and buckets them (even though default status is active)', async () => {
    const supabase = makeSupabase({
      claims: [
        claim({ id: 'c-active', created_at: IN_WINDOW }),
        // Superseded in-window — the tool must fetch this via its second
        // status='superseded' query and put it in the superseded bucket.
        claim({
          id: 'c-super',
          status: 'superseded',
          created_at: BEFORE_WINDOW,
          updated_at: IN_WINDOW,
        }),
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { group_by_change: true, since: SINCE, until: UNTIL } as never,
      EXEC_OPTS,
    )) as unknown as {
      buckets: { new: ClaimFixture[]; superseded: ClaimFixture[] }
    }
    expect(res.buckets.superseded.map((c) => c.id)).toEqual(['c-super'])
    expect(res.buckets.new.map((c) => c.id)).toEqual(['c-active'])
    // The claim double is queried once per status (active + superseded).
    const from = (supabase as unknown as { from: ReturnType<typeof vi.fn> }).from
    const claimCalls = from.mock.calls.filter((c: unknown[]) => c[0] === 'claim')
    expect(claimCalls.length).toBe(2)
  })

  it('excludes a superseded row updated OUTSIDE the window', async () => {
    const supabase = makeSupabase({
      claims: [
        claim({
          id: 'c-super-old',
          status: 'superseded',
          created_at: BEFORE_WINDOW,
          updated_at: AFTER_WINDOW, // flipped after the window closed
        }),
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { group_by_change: true, since: SINCE, until: UNTIL } as never,
      EXEC_OPTS,
    )) as unknown as { buckets: { superseded: ClaimFixture[] } }
    expect(res.buckets.superseded).toHaveLength(0)
  })

  it('does NOT issue a redundant second query when status=superseded is requested', async () => {
    const supabase = makeSupabase({
      claims: [claim({ id: 'c-super', status: 'superseded', updated_at: IN_WINDOW })],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    await tool.execute!(
      { group_by_change: true, status: 'superseded', since: SINCE, until: UNTIL } as never,
      EXEC_OPTS,
    )
    const from = (supabase as unknown as { from: ReturnType<typeof vi.fn> }).from
    const claimCalls = from.mock.calls.filter((c: unknown[]) => c[0] === 'claim')
    expect(claimCalls.length).toBe(1)
  })

  it('errors (does not scan unbounded) when group_by_change is passed without a since window', async () => {
    const supabase = makeSupabase({
      claims: [claim({ id: 'c-any', created_at: IN_WINDOW })],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { group_by_change: true } as never,
      EXEC_OPTS,
    )) as unknown as { success: boolean; error?: string }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/since/i)
    // It must NOT have fetched claims (no unbounded scan).
    const from = (supabase as unknown as { from: ReturnType<typeof vi.fn> }).from
    expect(from.mock.calls.some((c: unknown[]) => c[0] === 'claim')).toBe(false)
  })

  it('applies .limit() to each buildSet fetch in the grouped path', async () => {
    // Record every chain and whether .limit() was called on it. The grouped
    // path issues two claim fetches (active + superseded); both must be capped.
    const limitCalls: number[] = []
    const from = vi.fn((table: string) => {
      const filters: { ins: Record<string, unknown[]> } = { ins: {} }
      const chain: Record<string, unknown> = {
        then: (resolve: (v: unknown) => unknown) =>
          Promise.resolve({ data: [], error: null }).then(resolve),
      }
      const proxy: Record<string, unknown> = new Proxy(chain, {
        get(t, p: string) {
          if (p in t) return t[p]
          if (p === 'in') return (col: string, vals: unknown[]) => ((filters.ins[col] = vals), proxy)
          if (p === 'limit')
            return (n: number) => {
              if (table === 'claim') limitCalls.push(n)
              return proxy
            }
          return () => proxy
        },
      })
      return proxy
    })
    const supabase = { from } as never
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    await tool.execute!(
      { group_by_change: true, since: SINCE, until: UNTIL, limit: 7 } as never,
      EXEC_OPTS,
    )
    // Two claim fetches (active + superseded), each capped at `limit`.
    expect(limitCalls).toEqual([7, 7])
  })

  it('makes new / newly_confirmed mutually exclusive — a born-in-window claim never appears in both', async () => {
    // Regression: with the old always-true guard a confirmed claim created
    // in-window could satisfy both `new` (created_at in window) and
    // `newly_confirmed` (updated_at in window). It must appear ONLY in `new`.
    const supabase = makeSupabase({
      claims: [
        claim({
          id: 'c-born-conf',
          confirmation: 'confirmed',
          created_at: IN_WINDOW, // born in-window
          updated_at: IN_WINDOW, // also updated in-window
        }),
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { group_by_change: true, since: SINCE, until: UNTIL } as never,
      EXEC_OPTS,
    )) as unknown as {
      buckets: { new: ClaimFixture[]; newly_confirmed: ClaimFixture[] }
    }
    expect(res.buckets.new.map((c) => c.id)).toEqual(['c-born-conf'])
    expect(res.buckets.newly_confirmed).toHaveLength(0)
    // And no claim id is shared between the two buckets.
    const newIds = new Set(res.buckets.new.map((c) => c.id))
    expect(res.buckets.newly_confirmed.some((c) => newIds.has(c.id))).toBe(false)
  })

  it('returns empty buckets (not a flat list) when an entity filter matches nothing', async () => {
    const supabase = makeSupabase({ claims: [], entityLinkClaimIds: [] })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      {
        group_by_change: true,
        entity_type: 'project',
        entity_id: 'p-1',
        since: SINCE,
        until: UNTIL,
      } as never,
      EXEC_OPTS,
    )) as unknown as { grouped: boolean; buckets: Record<string, unknown[]>; count: number }
    expect(res.grouped).toBe(true)
    expect(res.buckets.new).toHaveLength(0)
    expect(res.count).toBe(0)
  })
})

describe('list_claims — include_provenance', () => {
  it('attaches batched provenance per claim on the flat path', async () => {
    const supabase = makeSupabase({
      claims: [claim({ id: 'a' }), claim({ id: 'b' })],
      claimSources: [
        { claim_id: 'a', source_type: 'capture', source_id: 'cap1', source_uri: null, excerpt: 'said A' },
        { claim_id: 'b', source_type: 'document', source_id: 'doc1', source_uri: null, excerpt: 'said B' },
      ],
      claimEdges: [{ source_id: 'a', target_type: 'project', target_id: 'proj1', relation: 'about' }],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { include_provenance: true } as never,
      EXEC_OPTS,
    )) as unknown as { claims: Array<{ id: string; provenance?: Array<{ entity_type: string; excerpt: string | null }> }> }

    const a = res.claims.find((c) => c.id === 'a')!
    const b = res.claims.find((c) => c.id === 'b')!
    // 'a' has a capture source (excerpt) AND an about→project edge → two prov entries.
    expect(a.provenance).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_type: 'capture', excerpt: 'said A', in_sources: true }),
        expect.objectContaining({ entity_type: 'project', entity_id: 'proj1', relations: ['about'] }),
      ]),
    )
    expect(b.provenance).toEqual([
      expect.objectContaining({ entity_type: 'document', excerpt: 'said B', in_sources: true }),
    ])
  })

  it('does NOT attach provenance when include_provenance is false (default)', async () => {
    const supabase = makeSupabase({
      claims: [claim({ id: 'a' })],
      claimSources: [{ claim_id: 'a', source_type: 'capture', source_id: 'cap1', source_uri: null, excerpt: 'x' }],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!({} as never, EXEC_OPTS)) as unknown as {
      claims: Array<{ id: string; provenance?: unknown }>
    }
    expect(res.claims[0].provenance).toBeUndefined()
    // And it never read provenance: no graph edges, and claim_source only once,
    // for the mail check (a claim learned from mail is shown to no one, 341).
    const from = (supabase as unknown as { from: ReturnType<typeof vi.fn> }).from
    expect(from.mock.calls.some((c: unknown[]) => c[0] === 'entity_link')).toBe(false)
    expect(from.mock.calls.filter((c: unknown[]) => c[0] === 'claim_source')).toHaveLength(1)
  })

  it('batches provenance across buckets (grouped path)', async () => {
    const supabase = makeSupabase({
      claims: [
        claim({ id: 'c-new', created_at: IN_WINDOW }),
        claim({ id: 'c-super', status: 'superseded', created_at: BEFORE_WINDOW, updated_at: IN_WINDOW }),
      ],
      claimSources: [
        { claim_id: 'c-new', source_type: 'capture', source_id: 'cap1', source_uri: null, excerpt: 'e-new' },
        { claim_id: 'c-super', source_type: 'document', source_id: 'doc1', source_uri: null, excerpt: 'e-super' },
      ],
    })
    const tool = createClaimTools(USER_ID, supabase, WORKSPACE_ID).list_claims
    const res = (await tool.execute!(
      { group_by_change: true, include_provenance: true, since: SINCE, until: UNTIL } as never,
      EXEC_OPTS,
    )) as unknown as {
      buckets: {
        new: Array<{ id: string; provenance?: Array<{ excerpt: string | null }> }>
        superseded: Array<{ id: string; provenance?: Array<{ excerpt: string | null }> }>
      }
    }
    expect(res.buckets.new[0].provenance?.[0].excerpt).toBe('e-new')
    expect(res.buckets.superseded[0].provenance?.[0].excerpt).toBe('e-super')
  })
})
