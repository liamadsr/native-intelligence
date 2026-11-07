/**
 * Capture visibility in the Views query engine.
 *
 * Every list, board and grouped count in the app funnels through
 * buildEntityQuery('capture', ...). Without the visibility predicate here, a
 * private ("Only me") capture shows up in every teammate's captures view —
 * this is the single highest-traffic read path for captures.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildEntityQuery } from '@/lib/views/query-engine'

/** A Supabase query builder that records select columns and .or() expressions. */
function makeSupabase() {
  const selects: string[] = []
  const ors: string[] = []
  const chain = {
    select: vi.fn((columns: string) => {
      selects.push(columns)
      return chain
    }),
    or: vi.fn((expr: string) => {
      ors.push(expr)
      return chain
    }),
    eq: vi.fn(() => chain),
    is: vi.fn(() => chain),
    neq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
  }
  return { supabase: { from: vi.fn(() => chain) }, selects, ors, chain }
}

describe('buildEntityQuery — capture visibility', () => {
  it('applies the visibility predicate keyed on the requesting user', () => {
    const { supabase, ors } = makeSupabase()
    buildEntityQuery(supabase as never, 'capture', 'ws-1', 'user-1')
    expect(ors).toContain('visibility.eq.workspace,user_id.eq.user-1')
  })

  it('keys the predicate on the ACTUAL requester, not a constant', () => {
    const { supabase, ors } = makeSupabase()
    buildEntityQuery(supabase as never, 'capture', 'ws-1', 'user-other')
    expect(ors).toContain('visibility.eq.workspace,user_id.eq.user-other')
  })

  it('still scopes to the workspace', () => {
    const { supabase, chain } = makeSupabase()
    buildEntityQuery(supabase as never, 'capture', 'ws-1', 'user-1')
    expect(chain.eq).toHaveBeenCalledWith('workspace_id', 'ws-1')
  })

  it('ships the visibility column so rows can render the lock badge', () => {
    const { supabase, selects } = makeSupabase()
    buildEntityQuery(supabase as never, 'capture', 'ws-1', 'user-1')
    const columns = selects[0].split(',').map((c) => c.trim())
    expect(columns).toContain('visibility')
  })

  it('does NOT apply a capture visibility predicate to other entity types', () => {
    for (const entity of ['contact', 'document', 'project'] as const) {
      const { supabase, ors } = makeSupabase()
      buildEntityQuery(supabase as never, entity, 'ws-1', 'user-1')
      expect(ors.some((o) => o.includes('visibility.eq.workspace'))).toBe(false)
    }
  })
})
