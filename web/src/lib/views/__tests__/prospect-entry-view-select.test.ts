/**
 * PROSPECT_ENTRY_VIEW_SELECT — what a prospect-list ENTRY row carries.
 *
 * This exists because the select was wrong in a way nothing could catch. The
 * list-detail page renders its rows through this query (it embeds
 * `<UnifiedViewLayout entityType="prospect_list_entry">`), and
 * `ProspectEntryRowBody` reads `research` (the employee-count chip) and
 * `fit_signals` (the matched-signal chips and the citation favicon). Both were
 * omitted. Every accessor in that component degrades to null on a missing key,
 * so nothing threw and nothing logged — three affordances simply rendered
 * blank on every row, which is the worst way for a column list to be wrong.
 *
 * Both directions are pinned deliberately:
 *  - the two blobs the ROW reads must stay IN, so the silent-blank regression
 *    cannot come back;
 *  - `sources` must stay OUT. It is the largest of the three blobs, it belongs
 *    to the entry DETAIL panel's citation list, and no row cell reads it — the
 *    row's one link comes from a signal's `evidence_url`. A future "just add
 *    the rest of the blobs" edit is the thing this half of the test stops.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildEntityQuery } from '@/lib/views/query-engine'

/** A Supabase query builder that records the select string it was handed. */
function makeSupabase() {
  const selects: string[] = []
  const chain = {
    select: vi.fn((columns: string) => {
      selects.push(columns)
      return chain
    }),
    eq: vi.fn(() => chain),
    or: vi.fn(() => chain),
    is: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
  }
  return {
    supabase: { from: vi.fn(() => chain) },
    selects,
  }
}

function entryColumns(): string[] {
  const { supabase, selects } = makeSupabase()
  buildEntityQuery(supabase as never, 'prospect_list_entry', 'ws-1', 'user-1')
  return selects[0].split(',').map((c) => c.trim())
}

describe('PROSPECT_ENTRY_VIEW_SELECT', () => {
  it('ships research — the row reads the employee-count chip out of the blob', () => {
    expect(entryColumns()).toContain('research')
  })

  it('does NOT ship the columns migration 256 dropped', () => {
    for (const gone of ['fit_tier', 'fit_signals', 'fit_confidence']) {
      expect(entryColumns()).not.toContain(gone)
    }
  })

  it('does NOT ship sources — the detail panel fetches its own citations', () => {
    expect(entryColumns()).not.toContain('sources')
  })

  it('keeps every field the company and person rows actually read', () => {
    const columns = entryColumns()
    for (const column of [
      // Identity + routing.
      'id', 'workspace_id', 'list_id', 'kind', 'candidate_key', 'candidate',
      // Promotion pointers, and the parent a person hangs off.
      'company_id', 'contact_id', 'parent_entry_id',
      // Chips: stage, the person row's needs_review marker, the score and its why.
      'stage', 'identity_state', 'fit_score', 'fit_rationale',
      // Dismissal, provenance, ordering.
      'dismissed_reason', 'dismissed_at', 'discovered_by_run_id',
      'created_at', 'updated_at',
    ]) {
      expect(columns).toContain(column)
    }
  })
})
