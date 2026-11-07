/**
 * Slug hygiene for library items (Phase 2 — docs/plans/agents-skills-page-redesign.md).
 *
 * Slugs are the /command namespace: unique within a workspace (system rows
 * form a shared namespace every workspace sees). CLEANUP.md documented a live
 * triple-booking of /brief before this existed. One helper owns normalization
 * and uniqueness so the create/edit routes and the marketplace fork route
 * cannot drift.
 */
import type { SupabaseClient } from '@supabase/supabase-js'

/** Lowercase, hyphens, trimmed — the shape /commands expect. '' when nothing survives. */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** Hard ceiling on suffix probes — bounds the loop if the namespace is pathological. */
const MAX_SUFFIX = 999

/**
 * Returns `base` if free within the workspace(+system) namespace, else the
 * first free `base-2`, `base-3`, … `excludeId` skips the row being edited.
 *
 * Namespace: a `/command` resolves against the current workspace's rows PLUS
 * every system row (system rows are shared into every workspace). So a new
 * slug must dodge collisions in both — matching migration 027's two partial
 * unique indexes (system: `(slug) WHERE workspace_id IS NULL`; workspace:
 * `(workspace_id, slug)`). We query `is_system=true OR workspace_id=<ws>` in
 * one round trip and dedupe in memory, rather than N existence probes.
 *
 * The suffixed candidate is kept within the 64-char slug budget by trimming
 * `base` (not the suffix) — `foo…-12` stays a valid slug and its numeric tail
 * survives. `base` is assumed already normalized (see `normalizeSlug`).
 */
export async function ensureUniqueSlug(
  supabase: SupabaseClient,
  workspaceId: string,
  base: string,
  excludeId?: string,
): Promise<string> {
  // Empty base can't be made unique — hand it back for the caller's validator.
  if (!base) return base

  let query = supabase
    .from('recipe')
    .select('id, slug')
    .or(`is_system.eq.true,workspace_id.eq.${workspaceId}`)
    .not('slug', 'is', null)

  if (excludeId) {
    query = query.neq('id', excludeId)
  }

  const { data } = await query
  const taken = new Set(
    (data ?? [])
      .map((r) => (r as { slug: string | null }).slug)
      .filter((s): s is string => !!s),
  )

  if (!taken.has(base)) return base

  for (let n = 2; n <= MAX_SUFFIX; n++) {
    const candidate = withSuffix(base, n)
    if (!taken.has(candidate)) return candidate
  }

  // Namespace is saturated for this base within our probe budget. Fall through
  // to a timestamp-tagged candidate — practically collision-free, still ≤64ch.
  return withSuffix(base, Date.now() % 100000)
}

/**
 * Append `-<n>` to `base`, trimming `base` (never the numeric tail) so the
 * whole slug stays within the 64-char budget. `foo-2`, or if `base` is long,
 * `<truncated>-42`.
 */
function withSuffix(base: string, n: number): string {
  const suffix = `-${n}`
  const room = 64 - suffix.length
  // Trim to room, then strip any trailing hyphen the cut may have exposed so we
  // don't produce `foo--2`.
  const trimmed = base.slice(0, room).replace(/-+$/g, '')
  return `${trimmed}${suffix}`
}
