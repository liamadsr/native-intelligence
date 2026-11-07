/**
 * Unit tests for the fork-lineage enrichment (Phase 2 —
 * docs/plans/agents-skills-page-redesign.md §6, LINEAGE workstream).
 *
 * The account list routes annotate each forked row with its source's *display*
 * facts (name + updated_at) so the UI can show "Forked from X" and a "source
 * has changed" hint without the row already carrying that data. Two pieces:
 *
 *   - `annotateLineage` — PURE: rows + a source map → the same rows, each fork
 *     carrying source_name/source_updated_at (null when the source is missing).
 *   - `fetchLineageSources` — the ONE batched IN() lookup that builds that map,
 *     selecting only id/name/updated_at (never a prompt/config blob).
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  annotateLineage,
  fetchLineageSources,
  type LineageSource,
} from '../queries'

describe('annotateLineage (pure)', () => {
  const sources = new Map<string, LineageSource>([
    ['orig-1', { name: 'Community Planner', updated_at: '2026-02-01T00:00:00Z' }],
    ['orig-2', { name: 'Email Assistant', updated_at: '2026-01-01T00:00:00Z' }],
  ])

  it('merges source_name/source_updated_at onto a forked row', () => {
    const [row] = annotateLineage(
      [{ forked_from: 'orig-1', created_at: '2026-01-15T00:00:00Z' }],
      sources,
    )
    expect(row.source_name).toBe('Community Planner')
    expect(row.source_updated_at).toBe('2026-02-01T00:00:00Z')
  })

  it('leaves lineage fields null for a non-fork (forked_from null)', () => {
    const [row] = annotateLineage(
      [{ forked_from: null, created_at: '2026-01-15T00:00:00Z' }],
      sources,
    )
    expect(row.source_name).toBeNull()
    expect(row.source_updated_at).toBeNull()
  })

  it('leaves lineage fields null when the source is missing from the map (orphan)', () => {
    // forked_from points at a source that was deleted / is unreadable → not in
    // the map. The annotator treats a miss as "source gone" (nulls, no chip).
    const [row] = annotateLineage(
      [{ forked_from: 'deleted-source', created_at: '2026-01-15T00:00:00Z' }],
      sources,
    )
    expect(row.source_name).toBeNull()
    expect(row.source_updated_at).toBeNull()
  })

  it('preserves every original field on the row (spread, not replace)', () => {
    const [row] = annotateLineage(
      [{ id: 'copy-1', name: 'My Planner', forked_from: 'orig-1', created_at: '2026-01-15T00:00:00Z' }],
      sources,
    )
    expect(row.id).toBe('copy-1')
    expect(row.name).toBe('My Planner')
  })

  it('annotates a mixed batch independently (fork + non-fork + orphan)', () => {
    const rows = annotateLineage(
      [
        { id: 'a', forked_from: 'orig-1', created_at: '2026-01-15T00:00:00Z' },
        { id: 'b', forked_from: null, created_at: '2026-01-15T00:00:00Z' },
        { id: 'c', forked_from: 'gone', created_at: '2026-01-15T00:00:00Z' },
      ],
      sources,
    )
    expect(rows.map((r) => r.source_name)).toEqual(['Community Planner', null, null])
  })

  it('returns [] for an empty input', () => {
    expect(annotateLineage([], sources)).toEqual([])
  })
})

/**
 * A single-call Supabase fake for `fetchLineageSources`. Captures the columns
 * passed to `.select()` and the ids passed to `.in()`, then resolves the
 * builder (thenable) with `{ data }`.
 */
function fakeClient(rows: { id: string; name: string | null; updated_at: string | null }[]) {
  const calls: { selectCols?: string; inCol?: string; inIds?: string[]; fromCount: number } = {
    fromCount: 0,
  }
  const builder: Record<string, unknown> = {
    select: (cols: string) => {
      calls.selectCols = cols
      return builder
    },
    in: (col: string, ids: string[]) => {
      calls.inCol = col
      calls.inIds = ids
      return builder
    },
    then: (resolve: (v: { data: unknown }) => unknown) =>
      Promise.resolve(resolve({ data: rows })),
  }
  const client = {
    from: vi.fn(() => {
      calls.fromCount += 1
      return builder
    }),
  } as unknown as SupabaseClient
  return { client, calls }
}

describe('fetchLineageSources (batched lookup)', () => {
  it('issues ONE IN() query over the distinct non-null forked_from ids', async () => {
    const { client, calls } = fakeClient([
      { id: 'orig-1', name: 'A', updated_at: '2026-02-01T00:00:00Z' },
      { id: 'orig-2', name: 'B', updated_at: '2026-01-01T00:00:00Z' },
    ])
    const map = await fetchLineageSources(client, [
      { forked_from: 'orig-1' },
      { forked_from: 'orig-2' },
      { forked_from: 'orig-1' }, // duplicate → collapsed
      { forked_from: null }, // ignored
    ])
    expect(calls.fromCount).toBe(1) // one batched query, not one-per-row
    expect(calls.inCol).toBe('id')
    expect(new Set(calls.inIds)).toEqual(new Set(['orig-1', 'orig-2']))
    expect(map.get('orig-1')).toEqual({ name: 'A', updated_at: '2026-02-01T00:00:00Z' })
    expect(map.get('orig-2')).toEqual({ name: 'B', updated_at: '2026-01-01T00:00:00Z' })
  })

  it('selects ONLY id/name/updated_at — never a prompt/config column', async () => {
    const { client, calls } = fakeClient([])
    await fetchLineageSources(client, [{ forked_from: 'orig-1' }])
    expect(calls.selectCols).toBe('id, name, updated_at')
    expect(calls.selectCols).not.toMatch(/system_prompt|agent_config|extraction_config/)
  })

  it('short-circuits (no query) when no row has a forked_from', async () => {
    const { client, calls } = fakeClient([])
    const map = await fetchLineageSources(client, [{ forked_from: null }, {}])
    expect(calls.fromCount).toBe(0)
    expect(map.size).toBe(0)
  })

  it('tolerates a null data payload (returns an empty map)', async () => {
    const client = {
      from: () => ({ select: () => ({ in: () => Promise.resolve({ data: null }) }) }),
    } as unknown as SupabaseClient
    const map = await fetchLineageSources(client, [{ forked_from: 'orig-1' }])
    expect(map.size).toBe(0)
  })
})
