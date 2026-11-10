/**
 * Tests for the fork-lineage enrichment on the account list route (Phase 2 —
 * docs/plans/agents-skills-page-redesign.md §6, LINEAGE workstream).
 *
 * GET now returns each forked row annotated with its source's display facts via
 * `listLibraryItemsWithLineage`: a FIRST query fetches the workspace's rows, a
 * SECOND batched IN() query resolves the distinct forked_from sources. These
 * tests drive the real GET handler with a two-phase Supabase fake and assert:
 *
 *   - sources are batched into ONE lookup (not one query per forked row);
 *   - the source lookup selects ONLY id/name/updated_at — no system_prompt or
 *     config blob crosses the workspace boundary;
 *   - an orphan fork (source missing from the lookup) yields null lineage;
 *   - a non-fork gets null lineage and no extra query is issued for it.
 *
 * The agents + skills GET routes share the helper, so covering one covers both.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn() }))

vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  requireWorkspace: hoisted.requireWorkspace,
}))

import { GET } from '@/app/api/account/agents/route'

type Row = Record<string, unknown>

/**
 * Two-phase Supabase fake. The FIRST `.from('recipe')` chain is the list query
 * (terminates by being awaited → resolves `{ data: listRows }`). The SECOND is
 * the lineage lookup (`.select(cols).in('id', ids)` → resolves `{ data:
 * sourceRows }`). We record which columns + ids the lineage lookup asked for so
 * the test can assert batching and no-prompt-leakage.
 *
 * `.from('workspace')` is the settings read `listLibraryItems` makes to compute
 * the feature-gated recipe exclusions; it is answered separately so it does not
 * consume a recipe phase. An empty blob resolves to `full` with hidden features
 * off, so the list carries the `.not(...)` exclusion — which this builder, like
 * PostgREST, just chains through.
 */
function twoPhaseClient(listRows: Row[], sourceRows: Row[]) {
  const calls = {
    fromCount: 0,
    lineageSelectCols: undefined as string | undefined,
    lineageInIds: undefined as string[] | undefined,
    lineageQueryCount: 0,
  }

  function listBuilder(): Record<string, unknown> {
    const b: Record<string, unknown> = {
      select: () => b,
      or: () => b,
      eq: () => b,
      not: () => b,
      order: () => b,
      then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
        Promise.resolve(resolve({ data: listRows, error: null })),
    }
    return b
  }

  function lineageBuilder(): Record<string, unknown> {
    const b: Record<string, unknown> = {
      select: (cols: string) => {
        calls.lineageSelectCols = cols
        return b
      },
      in: (_col: string, ids: string[]) => {
        calls.lineageInIds = ids
        calls.lineageQueryCount += 1
        return Promise.resolve({ data: sourceRows })
      },
    }
    return b
  }

  const supabase = {
    from: vi.fn((table: string) => {
      if (table === 'workspace') {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { settings: {} }, error: null }) }),
          }),
        }
      }
      calls.fromCount += 1
      // First recipe call is the list; every subsequent one is a lineage lookup.
      return calls.fromCount === 1 ? listBuilder() : lineageBuilder()
    }),
  }
  return { supabase, calls }
}

function authWith(listRows: Row[], sourceRows: Row[]) {
  const { supabase, calls } = twoPhaseClient(listRows, sourceRows)
  hoisted.requireWorkspace.mockResolvedValue({
    user: { id: 'user-1', email: 'm@dial8.ai' },
    workspaceId: 'ws-1',
    supabase,
  })
  return calls
}

const req = () => {
  const url = 'https://nativeintelligence.dev/api/account/agents'
  const r = buildRequest({ method: 'GET', url })
  // next/server's NextRequest exposes `nextUrl`; the route reads
  // `request.nextUrl.searchParams`, so polyfill it on the plain Request.
  Object.defineProperty(r, 'nextUrl', { value: new URL(url) })
  return r as unknown as NextRequest
}

beforeEach(() => hoisted.requireWorkspace.mockReset())

describe('agents GET fork-lineage enrichment', () => {
  it('annotates a forked row with its source name + updated_at', async () => {
    authWith(
      [{ id: 'copy-1', name: 'My PM', forked_from: 'orig-1', created_at: '2026-01-01T00:00:00Z' }],
      [{ id: 'orig-1', name: 'Community PM', updated_at: '2026-02-01T00:00:00Z' }],
    )
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await readJson<{ agents: Row[] }>(res)
    expect(body.agents[0].source_name).toBe('Community PM')
    expect(body.agents[0].source_updated_at).toBe('2026-02-01T00:00:00Z')
  })

  it('batches source lookups into ONE query for many forks of distinct sources', async () => {
    const calls = authWith(
      [
        { id: 'c1', forked_from: 'orig-1', created_at: '2026-01-01T00:00:00Z' },
        { id: 'c2', forked_from: 'orig-2', created_at: '2026-01-01T00:00:00Z' },
        { id: 'c3', forked_from: 'orig-1', created_at: '2026-01-01T00:00:00Z' }, // same source
      ],
      [
        { id: 'orig-1', name: 'A', updated_at: '2026-01-01T00:00:00Z' },
        { id: 'orig-2', name: 'B', updated_at: '2026-01-01T00:00:00Z' },
      ],
    )
    await GET(req())
    expect(calls.lineageQueryCount).toBe(1) // one batched IN(), not per-row
    expect(new Set(calls.lineageInIds)).toEqual(new Set(['orig-1', 'orig-2']))
  })

  it('never selects a prompt/config column for the source lookup', async () => {
    const calls = authWith(
      [{ id: 'c1', forked_from: 'orig-1', created_at: '2026-01-01T00:00:00Z' }],
      [{ id: 'orig-1', name: 'A', updated_at: '2026-01-01T00:00:00Z' }],
    )
    await GET(req())
    expect(calls.lineageSelectCols).toBe('id, name, updated_at')
    expect(calls.lineageSelectCols).not.toMatch(/system_prompt|agent_config|extraction_config/)
  })

  it('yields null lineage for an orphan fork (source not returned by the lookup)', async () => {
    authWith(
      [{ id: 'c1', forked_from: 'deleted', created_at: '2026-01-01T00:00:00Z' }],
      [], // source row absent → orphan
    )
    const res = await GET(req())
    const body = await readJson<{ agents: Row[] }>(res)
    expect(body.agents[0].source_name).toBeNull()
    expect(body.agents[0].source_updated_at).toBeNull()
  })

  it('issues NO source lookup and returns null lineage when nothing is forked', async () => {
    const calls = authWith(
      [{ id: 'c1', name: 'Own', forked_from: null, created_at: '2026-01-01T00:00:00Z' }],
      [],
    )
    const res = await GET(req())
    const body = await readJson<{ agents: Row[] }>(res)
    expect(calls.fromCount).toBe(1) // list query only — no second lineage query
    expect(body.agents[0].source_name).toBeNull()
  })
})
