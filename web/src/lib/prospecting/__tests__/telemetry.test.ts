/**
 * Per-angle telemetry (§14). Two facts are worth pinning and would otherwise
 * be silent:
 *
 *   1. `found` and `new` come from DIFFERENT tables and are meant to disagree.
 *      Reading both from one would either lose the suppressed candidates (the
 *      cost of the angle) or count deleted entries (rows the board does not
 *      show). A test that only asserts they are equal would pass on the wrong
 *      implementation.
 *   2. Both reads are PAGED. `prospect_run_candidate` is the largest table in
 *      the feature — it records every suppressed candidate — so an unpaginated
 *      read under-reports `found` for exactly the busy lists this table exists
 *      for, silently.
 */
import { describe, it, expect } from 'vitest'
import { listAngleTelemetry } from '../telemetry'
import { makeFakeSupabase, filterArgs, hasWorkspaceFilter, type Captured } from './fake-supabase'

const WS = 'ws-1'
const LIST = 'list-1'

/** The `[from, to]` of the last `.range(...)` on a query. */
function range(q: Captured): [number, number] | undefined {
  return filterArgs(q, 'range').at(-1) as [number, number] | undefined
}

/** A handler that serves two fixed tables, sliced by the requested window so
 *  `readAll`'s short-page termination is exercised for real. */
function serve(
  candidates: Array<{ discovery_angle: string | null }>,
  entries: Array<{ discovery_angle: string | null; stage: string }>,
) {
  return (q: Captured) => {
    const rows = q.table === 'prospect_run_candidate' ? candidates : entries
    const r = range(q)
    return { data: r ? rows.slice(r[0], r[1] + 1) : rows }
  }
}

describe('listAngleTelemetry', () => {
  it('reports found from the ledger and new/saved from the entries', async () => {
    const { client } = makeFakeSupabase(
      serve(
        [
          // The angle SAW six candidates…
          ...Array.from({ length: 6 }, () => ({ discovery_angle: 'lookalike' })),
          { discovery_angle: 'use_case' },
          { discovery_angle: 'use_case' },
        ],
        [
          // …and two of them survived the exclusion set as entries, one saved.
          { discovery_angle: 'lookalike', stage: 'saved' },
          { discovery_angle: 'lookalike', stage: 'discovered' },
          { discovery_angle: 'use_case', stage: 'dismissed' },
        ],
      ),
    )

    const out = await listAngleTelemetry(client, { workspaceId: WS, listId: LIST })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.angles).toEqual([
      // Ordered by `found` descending — the expensive angles lead, because the
      // tuning question is which one spends the most for the least.
      { angle: 'lookalike', found: 6, new: 2, saved: 1 },
      { angle: 'use_case', found: 2, new: 1, saved: 0 },
    ])
  })

  it('shows an angle that found plenty and kept NOTHING', async () => {
    // The single most actionable row in the table: this angle is pure cost.
    // A read that started from entries would omit it entirely.
    const { client } = makeFakeSupabase(
      serve([{ discovery_angle: 'hiring_signal' }, { discovery_angle: 'hiring_signal' }], []),
    )
    const out = await listAngleTelemetry(client, { workspaceId: WS, listId: LIST })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.angles).toEqual([{ angle: 'hiring_signal', found: 2, new: 0, saved: 0 }])
  })

  it('shows an entry whose angle produced no surviving ledger rows', async () => {
    // The mirror case: the ledger was pruned by the retention sweep but the
    // entry it produced lives on. `found: 0` with `new: 1` is honest.
    const { client } = makeFakeSupabase(
      serve([], [{ discovery_angle: 'lookalike', stage: 'saved' }]),
    )
    const out = await listAngleTelemetry(client, { workspaceId: WS, listId: LIST })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.angles).toEqual([{ angle: 'lookalike', found: 0, new: 1, saved: 1 }])
  })

  it('omits NULL-angle rows rather than inventing an "unknown" bucket', async () => {
    // A NULL angle is a hand-added entry or a pre-stamp row. Bucketing it
    // would put a number nobody can act on beside four meant to be compared.
    const { client } = makeFakeSupabase(
      serve(
        [{ discovery_angle: null }, { discovery_angle: 'lookalike' }],
        [
          { discovery_angle: null, stage: 'saved' },
          { discovery_angle: 'lookalike', stage: 'saved' },
        ],
      ),
    )
    const out = await listAngleTelemetry(client, { workspaceId: WS, listId: LIST })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.angles).toEqual([{ angle: 'lookalike', found: 1, new: 1, saved: 1 }])
  })

  it('counts saved as a SUBSET of new, never in addition to it', async () => {
    const { client } = makeFakeSupabase(
      serve(
        [],
        [
          { discovery_angle: 'a', stage: 'saved' },
          { discovery_angle: 'a', stage: 'saved' },
          { discovery_angle: 'a', stage: 'shortlisted' },
        ],
      ),
    )
    const out = await listAngleTelemetry(client, { workspaceId: WS, listId: LIST })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.angles[0]).toEqual({ angle: 'a', found: 0, new: 3, saved: 2 })
  })

  it('PAGES the ledger read — an unpaginated one silently under-reports found', async () => {
    // 1000 is PostgREST's default cap, and it truncates with no error. Exactly
    // 1000 rows on page one therefore proves nothing about there being no page
    // two, so `readAll` must ask for one.
    const candidates = Array.from({ length: 1400 }, () => ({ discovery_angle: 'lookalike' }))
    const { client, queries } = makeFakeSupabase(serve(candidates, []))

    const out = await listAngleTelemetry(client, { workspaceId: WS, listId: LIST })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.angles[0].found).toBe(1400)

    const ledgerReads = queries.filter((q) => q.table === 'prospect_run_candidate')
    expect(ledgerReads).toHaveLength(2)
    expect(range(ledgerReads[0])).toEqual([0, 999])
    expect(range(ledgerReads[1])).toEqual([1000, 1999])
  })

  it('pages the ENTRIES read too', async () => {
    const entries = Array.from({ length: 1001 }, () => ({
      discovery_angle: 'a',
      stage: 'saved',
    }))
    const { client, queries } = makeFakeSupabase(serve([], entries))
    const out = await listAngleTelemetry(client, { workspaceId: WS, listId: LIST })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.angles[0]).toEqual({ angle: 'a', found: 0, new: 1001, saved: 1001 })
    expect(queries.filter((q) => q.table === 'prospect_list_entry')).toHaveLength(2)
  })

  it('orders every read stably, or the pages would overlap', async () => {
    // Without an ORDER BY, PostgREST may return the same row in two windows —
    // which would DOUBLE-count it in `found`.
    const { client, queries } = makeFakeSupabase(serve([], []))
    await listAngleTelemetry(client, { workspaceId: WS, listId: LIST })
    for (const q of queries) {
      expect(filterArgs(q, 'order').length, q.table).toBeGreaterThan(0)
    }
  })

  it('scopes BOTH reads to the workspace and the list — RLS is never alone', async () => {
    const { client, queries } = makeFakeSupabase(serve([], []))
    await listAngleTelemetry(client, { workspaceId: WS, listId: LIST })
    expect(queries).toHaveLength(2)
    for (const q of queries) {
      expect(hasWorkspaceFilter(q, WS), q.table).toBe(true)
      expect(filterArgs(q, 'eq'), q.table).toContainEqual(['list_id', LIST])
    }
  })

  it('surfaces a read failure rather than reporting an empty table', async () => {
    // A swallowed error would render "no angles have run yet" for a list that
    // has run four — and the user would tune against nothing.
    const { client } = makeFakeSupabase((q) =>
      q.table === 'prospect_run_candidate'
        ? { error: { message: 'boom' } }
        : { data: [] },
    )
    const out = await listAngleTelemetry(client, { workspaceId: WS, listId: LIST })
    expect(out).toMatchObject({ ok: false, code: 'DB_ERROR' })
  })
})
