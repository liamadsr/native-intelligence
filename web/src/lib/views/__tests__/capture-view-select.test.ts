/**
 * CAPTURE_VIEW_SELECT — what a capture LIST row carries.
 *
 * The point is what is NOT here: `summary` and `participants`. The list
 * renders neither, yet the default captures view is grouped by day, which
 * flips per_page to 500 — so a multi-KB AI summary plus a participants JSON
 * blob per row put 100KB–1MB of data nobody draws on every list load (and on
 * every realtime-triggered refetch). The detail panel fetches the full record
 * itself; the history-entry label in tab-content's buildEntryForItem degrades
 * to omitting the snippet/names when a row doesn't carry them.
 *
 * Both directions are pinned: the heavy columns stay out, and every field the
 * list DOES render (or the pipeline reads — project enrichment on project_id,
 * grouping on started_at, tab history on duration_seconds) stays in.
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
    // Capture queries carry the visibility predicate (see capture-visibility.test.ts).
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

function captureColumns(): string[] {
  const { supabase, selects } = makeSupabase()
  buildEntityQuery(supabase as never, 'capture', 'ws-1', 'user-1')
  return selects[0].split(',').map((c) => c.trim())
}

describe('CAPTURE_VIEW_SELECT', () => {
  it('does NOT ship summary — multi-KB of AI text per row the list never renders', () => {
    expect(captureColumns()).not.toContain('summary')
  })

  it('does NOT ship participants — a JSON blob per row the list never renders', () => {
    expect(captureColumns()).not.toContain('participants')
  })

  it('keeps every field the list and views pipeline actually read', () => {
    const columns = captureColumns()
    for (const column of [
      'id', 'title', 'recorded_at', 'created_at', 'status', 'is_pinned',
      'duration_seconds', 'started_at', 'ended_at', 'ai_processed',
      'auto_capture_status', 'scheduled_start', 'scheduled_end',
      'user_id', 'team_id', 'project_id', 'workspace_id',
    ]) {
      expect(columns).toContain(column)
    }
  })
})
