/**
 * Hiding a FEATURE's system library rows from a workspace that does not have
 * that feature.
 *
 * A system `recipe` (`is_system = true`) is visible to every workspace by RLS —
 * that is what makes `/create-skill` work everywhere. A feature-owned system
 * skill must not be: `/create-eval` in a workspace with Evals off would run with
 * an empty tool set and no way to save anything, which reads as a broken command
 * rather than an absent one. So every surface that LISTS or RESOLVES system
 * recipes subtracts the ids of features that are not effectively on
 * (`featureGatedRecipeExclusions`).
 *
 * The empty case is load-bearing: with nothing gated the query must be returned
 * UNTOUCHED, so a workspace with every feature on issues byte-identical SQL to
 * what it issued before this existed.
 */

/** The subset of a PostgREST filter builder this helper needs. */
interface NotFilterable<T> {
  not(column: string, operator: string, value: string): T
}

/**
 * Exclude a set of recipe ids from a `recipe` query. A no-op — the SAME query
 * object, not a copy — when nothing is gated.
 */
export function excludeFeatureGatedRecipes<T extends NotFilterable<T>>(
  query: T,
  ids: readonly string[],
): T {
  if (ids.length === 0) return query
  return query.not('id', 'in', `(${ids.join(',')})`)
}

/** True when `id` is one of the gated ids — for single-row lookups, which must
 *  read as "not found" rather than 403 (the row is invisible, not forbidden). */
export function isFeatureGatedRecipe(id: string | null | undefined, ids: readonly string[]): boolean {
  return !!id && ids.includes(id)
}
