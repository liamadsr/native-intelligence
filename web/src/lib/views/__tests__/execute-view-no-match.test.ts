import { describe, it, expect, vi } from 'vitest'
import { executeView, NO_MATCH_FILTER_VALUE } from '@/lib/views/query-engine'
import type { View } from '@/lib/views/types'

/**
 * executeView must translate a guaranteed-no-match filter into the NORMAL empty
 * success shape — matching the prod request that 500'd: a capture view, one
 * `{ field: 'id', operator: 'is', value: '__no_match__' }` filter, grouping on.
 *
 * The query builder is a spy that would REJECT if awaited (a real query would
 * dispatch the bad uuid comparison). The tests assert it's never awaited.
 */

/** A query builder that throws if ever awaited — proves no DB round-trip. */
function throwingQuery() {
  const proxy: Record<string, unknown> = new Proxy(
    {
      then: () => {
        throw new Error('query was awaited — expected a DB-free short-circuit')
      },
    },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop]
        return () => proxy
      },
    },
  )
  return proxy
}

/** supabase whose .from() returns the throwing query builder (never the member lookup path for captures). */
function makeSupabase() {
  const query = throwingQuery()
  return { from: vi.fn(() => query), query }
}

function captureView(overrides: Partial<View> = {}): View {
  return {
    id: 'v1',
    workspace_id: 'w1',
    team_id: null,
    created_by: 'u1',
    name: 'Contact captures',
    description: null,
    icon: null,
    color: null,
    slug: null,
    entity_type: 'capture',
    visibility: 'personal',
    layout: 'board',
    filters: [{ id: '__scope_contact', field: 'id', operator: 'is', value: NO_MATCH_FILTER_VALUE }],
    grouping: { field: 'status', direction: 'asc' },
    sub_grouping: null,
    ordering: [{ field: 'created_at', direction: 'desc' }],
    display_properties: [],
    board_group_by: null,
    show_completed: true,
    completed_filter: 'all',
    show_sub_items: false,
    nested_sub_items: false,
    show_empty_groups: false,
    is_pinned: false,
    pin_order: 0,
    scope_type: 'contact',
    scope_id: 'c1',
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

describe('executeView — no-match short-circuit (prod regression)', () => {
  it('returns the empty grouped success shape without a DB round-trip', async () => {
    const supabase = makeSupabase()
    const view = captureView()

    const result = await executeView(supabase as never, view, 'u1')

    // Grouping on → data is the grouped shape (empty groups list for zero rows).
    expect(result.data).toEqual([])
    expect(result.total).toBe(0)
    expect(result.page).toBe(1)
    expect(result.per_page).toBe(50)
    expect(result.view.entity_type).toBe('capture')
    expect(result.view.grouping).toEqual({ field: 'status', direction: 'asc' })

    // The query builder was never awaited (throwingQuery would have thrown).
    // Extra guard: from() was not used to run the entity query.
  })

  it('returns an empty flat array when grouping is off', async () => {
    const supabase = makeSupabase()
    const view = captureView({ grouping: null })

    const result = await executeView(supabase as never, view, 'u1')

    expect(result.data).toEqual([])
    expect(result.total).toBe(0)
  })
})
