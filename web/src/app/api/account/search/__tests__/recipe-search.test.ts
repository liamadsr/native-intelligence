import { describe, it, expect } from 'vitest'
import {
  sanitizeIlikeTerm,
  rankRecipe,
  searchRecipes,
  type RecipeQueryBuilder,
  type SupabaseLike,
} from '../recipe-search'

/**
 * Unit tests for the agent/skill (recipe) palette search helper.
 *
 * Covers the pure ranking/sanitizing helpers plus `searchRecipes`, which is
 * exercised through a fake Supabase query builder that records the chained
 * filters. The contract that matters: results come back in the unified
 * `result_type/result_id/...` shape, ranked name-first, and the query is
 * workspace- + category-scoped and sanitized before hitting the `or(ilike)`
 * filter.
 */

interface FakeRow {
  id: string
  name: string
  description: string | null
  category: string
  slug: string | null
  icon: string | null
}

/** A query builder that records every filter call and resolves to `rows`. */
function fakeBuilder(rows: FakeRow[], error: { message: string } | null = null) {
  const calls: {
    select: string[]
    or: string[]
    in: [string, readonly string[]][]
    not: [string, string, string][]
    limit: number[]
  } = {
    select: [],
    or: [],
    in: [],
    not: [],
    limit: [],
  }
  const builder: RecipeQueryBuilder = {
    select(cols) {
      calls.select.push(cols)
      return builder
    },
    or(filter) {
      calls.or.push(filter)
      return builder
    },
    in(col, values) {
      calls.in.push([col, values])
      return builder
    },
    not(col, op, value) {
      calls.not.push([col, op, value])
      return builder
    },
    limit(count) {
      calls.limit.push(count)
      return builder
    },
    then(onFulfilled) {
      return Promise.resolve({ data: error ? null : rows, error }).then(onFulfilled)
    },
  }
  const supabase: SupabaseLike = { from: () => builder }
  return { supabase, calls }
}

describe('sanitizeIlikeTerm', () => {
  it('strips PostgREST filter delimiters that would break an or() filter', () => {
    expect(sanitizeIlikeTerm('plan(week),now')).toBe('plan week now')
  })
  it('collapses whitespace and trims', () => {
    expect(sanitizeIlikeTerm('  weekly   plan  ')).toBe('weekly plan')
  })
  it('returns empty string for whitespace-only input', () => {
    expect(sanitizeIlikeTerm('   ')).toBe('')
  })
})

describe('rankRecipe', () => {
  const row = (over: Partial<FakeRow>): FakeRow => ({
    id: '1', name: 'Plan Week', description: 'plans your week', category: 'skill', slug: 'plan-week', icon: null, ...over,
  })

  it('ranks an exact name match highest', () => {
    expect(rankRecipe(row({ name: 'planner' }), 'planner')).toBe(1)
  })
  it('ranks a slug exact match as high as a name exact match', () => {
    expect(rankRecipe(row({ name: 'Weekly Planner', slug: 'plan-week' }), 'plan-week')).toBe(1)
  })
  it('ranks a name prefix above a plain includes', () => {
    // Null the slug so only the NAME position drives the rank in this comparison.
    expect(rankRecipe(row({ name: 'Planner Pro', slug: null }), 'plan')).toBeGreaterThan(
      rankRecipe(row({ name: 'My Planner', slug: null }), 'plan'),
    )
  })
  it('ranks a description-only match lowest', () => {
    const desc = rankRecipe(row({ name: 'Zebra', slug: 'zebra', description: 'plan your week' }), 'plan')
    const nameHit = rankRecipe(row({ name: 'Plan' }), 'plan')
    expect(desc).toBeLessThan(nameHit)
  })
})

describe('searchRecipes', () => {
  const rows: FakeRow[] = [
    { id: 'a', name: 'Weekly Planner', description: 'plans your week', category: 'skill', slug: 'plan-week', icon: '📅' },
    { id: 'b', name: 'Plan', description: null, category: 'agent', slug: null, icon: null },
  ]

  it('normalizes rows into the unified palette result shape', async () => {
    const { supabase } = fakeBuilder(rows)
    const out = await searchRecipes(supabase, {
      workspaceId: 'ws-1',
      query: 'plan',
      categories: ['agent', 'skill'],
      limit: 20,
    })
    // Exact name match ('Plan') ranks first.
    expect(out[0]).toMatchObject({ result_type: 'agent', result_id: 'b', title: 'Plan' })
    expect(out[1]).toMatchObject({ result_type: 'skill', result_id: 'a', title: 'Weekly Planner' })
    // Skill carries its emoji; agent leaves icon empty for the client fallback.
    expect(out[1].icon).toBe('📅')
    expect(out[0].icon).toBe('')
    // Metadata carries category + slug for the client.
    expect(out[1].metadata).toEqual({ category: 'skill', slug: 'plan-week' })
  })

  it('scopes to the workspace (+ system) and requested categories, and sanitizes the term', async () => {
    const { supabase, calls } = fakeBuilder(rows)
    await searchRecipes(supabase, {
      workspaceId: 'ws-1',
      query: 'plan(x)',
      categories: ['skill'],
      limit: 5,
    })
    // First or() is the visibility scope; second is the ilike match.
    expect(calls.or[0]).toBe('is_system.eq.true,workspace_id.eq.ws-1')
    expect(calls.or[1]).toContain('name.ilike.%plan x%')
    expect(calls.in[0]).toEqual(['category', ['skill']])
    expect(calls.limit[0]).toBe(5)
  })

  it('returns [] for an empty/whitespace query without querying', async () => {
    const { supabase, calls } = fakeBuilder(rows)
    const out = await searchRecipes(supabase, {
      workspaceId: 'ws-1',
      query: '   ',
      categories: ['agent', 'skill'],
      limit: 20,
    })
    expect(out).toEqual([])
    expect(calls.or).toHaveLength(0)
  })

  it('returns [] on a query error rather than throwing', async () => {
    const { supabase } = fakeBuilder([], { message: 'boom' })
    const out = await searchRecipes(supabase, {
      workspaceId: 'ws-1',
      query: 'plan',
      categories: ['agent', 'skill'],
      limit: 20,
    })
    expect(out).toEqual([])
  })
})
