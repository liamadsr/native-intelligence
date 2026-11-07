/**
 * Unit tests for the slug-hygiene helper (Phase 2 —
 * docs/plans/agents-skills-page-redesign.md §6).
 *
 * `ensureUniqueSlug` owns collision avoidance for the /command namespace: a slug
 * must be unique across the current workspace's rows PLUS every system row (they
 * are shared into every workspace). It issues ONE query
 * (`is_system=true OR workspace_id=<ws>`, slug not null, minus the edited row)
 * and picks `base`, then `base-2`, `base-3`, … in memory. These tests drive that
 * loop with a fake Supabase client that returns a fixed set of taken slugs.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ensureUniqueSlug, normalizeSlug } from '../slug'

/**
 * A minimal Supabase query-builder fake. `.from().select().or().not().neq()`
 * all return `this`; awaiting the builder (it's thenable) resolves to
 * `{ data }`, matching how `ensureUniqueSlug` does `await query`.
 *
 * `rows` is the set of existing recipe rows the namespace query would return;
 * when `excludeId` is passed the helper adds `.neq('id', id)`, so we filter it
 * out here to mirror the DB.
 */
function fakeClient(rows: { id: string; slug: string | null }[]) {
  const calls: { neqId?: string } = {}
  const builder: Record<string, unknown> = {
    select: () => builder,
    or: () => builder,
    not: () => builder,
    neq: (_col: string, val: string) => {
      calls.neqId = val
      return builder
    },
    then: (resolve: (v: { data: unknown }) => unknown) => {
      const data = calls.neqId ? rows.filter((r) => r.id !== calls.neqId) : rows
      return Promise.resolve(resolve({ data }))
    },
  }
  return {
    from: () => builder,
  } as unknown as SupabaseClient
}

const WS = 'ws-1'

describe('normalizeSlug', () => {
  it('lowercases, hyphenates, and trims to the /command shape', () => {
    expect(normalizeSlug('Weekly Planner')).toBe('weekly-planner')
    expect(normalizeSlug('  Foo!!  Bar  ')).toBe('foo-bar')
    expect(normalizeSlug('___')).toBe('')
    expect(normalizeSlug('Déjà Vu')).toBe('d-j-vu')
  })

  it('caps at 64 chars', () => {
    const long = 'a'.repeat(200)
    expect(normalizeSlug(long)).toHaveLength(64)
  })
})

describe('ensureUniqueSlug', () => {
  it('returns the base when it is free', async () => {
    const client = fakeClient([{ id: 'r1', slug: 'other' }])
    expect(await ensureUniqueSlug(client, WS, 'planner')).toBe('planner')
  })

  it('returns an empty base unchanged (the caller validates it)', async () => {
    const client = fakeClient([])
    expect(await ensureUniqueSlug(client, WS, '')).toBe('')
  })

  it('suffixes to base-2 when the base is taken', async () => {
    const client = fakeClient([{ id: 'r1', slug: 'planner' }])
    expect(await ensureUniqueSlug(client, WS, 'planner')).toBe('planner-2')
  })

  it('suffixes to base-3 when base and base-2 are both taken', async () => {
    const client = fakeClient([
      { id: 'r1', slug: 'planner' },
      { id: 'r2', slug: 'planner-2' },
    ])
    expect(await ensureUniqueSlug(client, WS, 'planner')).toBe('planner-3')
  })

  it('skips gaps and takes the first free suffix', async () => {
    // planner and planner-3 taken, planner-2 free → picks planner-2.
    const client = fakeClient([
      { id: 'r1', slug: 'planner' },
      { id: 'r3', slug: 'planner-3' },
    ])
    expect(await ensureUniqueSlug(client, WS, 'planner')).toBe('planner-2')
  })

  it('excludeId lets a row keep its own slug (no self-collision)', async () => {
    // The only row holding "planner" IS the row being edited → base is free.
    const client = fakeClient([{ id: 'self', slug: 'planner' }])
    expect(await ensureUniqueSlug(client, WS, 'planner', 'self')).toBe('planner')
  })

  it('excludeId does not shield a DIFFERENT row holding the slug', async () => {
    const client = fakeClient([
      { id: 'self', slug: 'other' },
      { id: 'sibling', slug: 'planner' },
    ])
    expect(await ensureUniqueSlug(client, WS, 'planner', 'self')).toBe('planner-2')
  })

  it('ignores null slugs when computing the taken set', async () => {
    const client = fakeClient([
      { id: 'r1', slug: null },
      { id: 'r2', slug: null },
    ])
    expect(await ensureUniqueSlug(client, WS, 'planner')).toBe('planner')
  })

  it('keeps the suffixed slug within the 64-char budget by trimming the base', async () => {
    const base = 'a'.repeat(64) // already at the ceiling
    const client = fakeClient([{ id: 'r1', slug: base }])
    const result = await ensureUniqueSlug(client, WS, base)
    expect(result.length).toBeLessThanOrEqual(64)
    expect(result.endsWith('-2')).toBe(true)
    // No exposed double-hyphen from the cut.
    expect(result.includes('--')).toBe(false)
  })
})
