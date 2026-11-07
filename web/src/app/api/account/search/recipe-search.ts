/**
 * Library-item (agent / skill) search for the ⌘K palette.
 *
 * Agents and skills live in the `recipe` table, which the `unified_search`
 * Postgres RPC does not index — and extending the RPC would need a migration.
 * Instead we run a small direct query here with the CALLER's Supabase client so
 * the recipe SELECT RLS policy is what decides visibility (system items +
 * the caller's workspace items), exactly like the account list routes.
 *
 * The results are normalized into the SAME shape the RPC returns
 * (`result_type / result_id / title / subtitle / icon / rank / metadata`) so the
 * palette treats agents and skills like any other result type without a special
 * case in the client.
 */

import type { LibraryCategory } from '@/lib/types/library'
import { excludeFeatureGatedRecipes } from '@/lib/library/feature-gate'

/** One row of the unified palette result set (matches the unified_search RPC). */
export interface SearchResultRow {
  result_type: string
  result_id: string
  title: string
  subtitle: string
  icon: string
  rank: number
  metadata: Record<string, unknown>
}

/** The raw recipe columns we read for a palette match. */
interface RecipeSearchRow {
  id: string
  name: string
  description: string | null
  category: string
  slug: string | null
  icon: string | null
}

/**
 * Minimal structural type for the Supabase query-builder chain we use. Declared
 * locally (rather than importing the full generated client type) so this helper
 * stays testable with a lightweight fake and doesn't couple to the DB typegen.
 * Every method returns `this` so calls chain; the builder is awaited for the
 * final `{ data, error }`.
 */
export interface RecipeQueryBuilder
  extends PromiseLike<{ data: RecipeSearchRow[] | null; error: { message: string } | null }> {
  select(columns: string): RecipeQueryBuilder
  or(filter: string): RecipeQueryBuilder
  in(column: string, values: readonly string[]): RecipeQueryBuilder
  not(column: string, operator: string, value: string): RecipeQueryBuilder
  limit(count: number): RecipeQueryBuilder
}

export interface SupabaseLike {
  from(table: 'recipe'): RecipeQueryBuilder
}

export interface SearchRecipesArgs {
  workspaceId: string
  query: string
  /** Which library categories to include (subset of agent/skill). */
  categories: LibraryCategory[]
  limit: number
  /**
   * System recipe ids to hide — a feature-owned system skill whose feature is
   * off in this workspace. Computed by the CALLER (which has the auth context
   * to resolve the edition) rather than here, so this helper stays a pure query
   * over the client it is handed. Omit / empty for no exclusions.
   */
  excludeIds?: readonly string[]
}

/**
 * Escape a user query for use inside a PostgREST `or(...)` filter value. Commas
 * and parentheses are the filter grammar's delimiters, so a query containing
 * them would break the filter (or worse, inject extra conditions). Strip them —
 * the remaining substring still drives a useful `ilike` match.
 */
export function sanitizeIlikeTerm(query: string): string {
  return query.trim().replace(/[(),*]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Rank a recipe row against the query so exact/prefix name matches sort above
 * description-only matches. Mirrors the intent of the RPC's ts_rank ordering
 * without needing FTS: name hits outrank description hits, and a shorter name
 * (closer to the query) edges out a longer one. Range roughly [0, 1].
 */
export function rankRecipe(row: RecipeSearchRow, query: string): number {
  const q = query.trim().toLowerCase()
  const name = row.name.toLowerCase()
  const slug = (row.slug || '').toLowerCase()
  if (!q) return 0.1
  if (name === q || slug === q) return 1
  if (name.startsWith(q) || slug.startsWith(q)) return 0.8
  if (name.includes(q)) return 0.6
  if (slug.includes(q)) return 0.5
  // Description-only match.
  return 0.3
}

/**
 * Search agents/skills visible to the caller. RLS on `recipe` scopes the rows;
 * we additionally bound by workspace + category and match name/description/slug
 * case-insensitively. Returns rows already normalized to the palette's shape.
 */
export async function searchRecipes(
  supabase: SupabaseLike,
  { workspaceId, query, categories, limit, excludeIds }: SearchRecipesArgs,
): Promise<SearchResultRow[]> {
  const term = sanitizeIlikeTerm(query)
  if (!term) return []

  const pattern = `%${term}%`
  const base = supabase
    .from('recipe')
    .select('id, name, description, category, slug, icon')
    // RLS already limits visibility to system + this workspace's rows; scope to
    // the active workspace (plus system items) explicitly so a shared client
    // can't leak another workspace's recipes into these results.
    .or(`is_system.eq.true,workspace_id.eq.${workspaceId}`)
    .in('category', categories)
    .or(`name.ilike.${pattern},description.ilike.${pattern},slug.ilike.${pattern}`)

  const { data, error } = await excludeFeatureGatedRecipes(base, excludeIds ?? []).limit(limit)

  if (error || !data) return []

  return data
    .map((row): SearchResultRow => {
      const category = row.category as LibraryCategory
      return {
        result_type: category, // 'agent' | 'skill'
        result_id: row.id,
        title: row.name,
        subtitle: row.description || '',
        // Skills carry an emoji icon; agents render a generated glyph in the
        // palette, so leave icon empty and let the client fall back to the
        // type icon.
        icon: category === 'skill' ? row.icon || '' : '',
        rank: rankRecipe(row, query),
        metadata: { category, slug: row.slug ?? null },
      }
    })
    .sort((a, b) => b.rank - a.rank)
}
