/**
 * Shared query helpers for library items (skills and agents).
 *
 * The underlying table is `public.recipe` (internal name, never user-facing
 * — see src/lib/types/library.ts for the vocabulary). Both category routes
 * share ~70% of their logic; this module centralizes it.
 *
 * Usage from a route handler:
 *
 *   import { requireWorkspace } from '@/lib/api-auth'
 *   import { serverError } from '@/lib/api-errors'
 *   import { listLibraryItems } from '@/lib/library/queries'
 *
 *   export async function GET(request: NextRequest) {
 *     const auth = await requireWorkspace()
 *     if (auth instanceof Response) return auth
 *     const { data, error } = await listLibraryItems(auth, 'skill', {
 *       mine: request.nextUrl.searchParams.get('mine') === 'true',
 *     })
 *     if (error) return serverError(error.message)
 *     return NextResponse.json({ items: data })
 *   }
 */
import type { WorkspaceAuthContext } from '@/lib/api-auth'
import type { LibraryCategory } from '@/lib/types/library'
import { featureGatedRecipeExclusions, resolveWorkspaceEdition } from '@/lib/editions'
import { excludeFeatureGatedRecipes } from './feature-gate'

/**
 * Full column set — used for detail (get-by-id), create, and update
 * responses where the caller needs the system_prompt / config blobs.
 */
export const LIBRARY_ITEM_FIELDS =
  'id, name, icon, color, description, system_prompt, extraction_config, is_system, is_default, sort_order, created_at, category, slug, agent_config, model, visibility, created_by, forked_from, fork_count, author_name, author_avatar_url, marketplace_category, featured, area'

/**
 * Lightweight catalog subset — used for list endpoints / MCP list tools.
 *
 * Returning the full LIBRARY_ITEM_FIELDS on a list of 20 items would burn
 * thousands of LLM context tokens (system_prompt + agent_config are the
 * heavy fields). The list/detail split mirrors how Anthropic recommends
 * shaping MCP catalog tools: list is cheap and high-level, get returns
 * everything.
 *
 * Includes enough for the caller to triage and pick: identifiers, display
 * fields, sharing scope, and source-of-truth flags. Excludes prompts,
 * configs, and timestamps.
 */
export const LIBRARY_LIST_FIELDS =
  'id, name, icon, color, description, category, slug, is_system, is_default, visibility, created_by, forked_from, fork_count, author_name, marketplace_category, featured'

/**
 * Marketplace-card subset — lighter payload for browsing public/system items.
 */
export const MARKETPLACE_CARD_FIELDS =
  'id, name, icon, color, description, category, slug, author_name, author_avatar_url, fork_count, marketplace_category, featured, created_at'

/**
 * Marketplace-detail subset — used when viewing a single public item.
 */
export const MARKETPLACE_DETAIL_FIELDS =
  'id, name, icon, color, description, category, slug, author_name, author_avatar_url, fork_count, marketplace_category, featured, created_at, agent_config'

/** Slugs reserved by the slash-command picker — cannot be used as skill slugs. */
export const RESERVED_SLUGS = ['clear', 'reset', 'help']

export interface ListOptions {
  /** Filter to items the current user created. */
  mine?: boolean
  /**
   * Include the lens skills (agent_config.lens: content-lens, marketing-lens,
   * flows F3). They only run as the skill of a call loop, so the library, the
   * slash picker and the teammate skill picker leave them out; the Flows
   * editor's skill picker asks for them.
   */
  includeLenses?: boolean
}

/** Leave the lens skills out of a recipe listing (F3 review S6). */
export function excludeLensSkills<T extends { is(column: string, value: null): T }>(query: T): T {
  return query.is('agent_config->>lens', null)
}

/**
 * List library items visible to the current workspace, optionally
 * filtered by category and/or ownership. Returns system items (workspace_id
 * IS NULL) plus the workspace's own items.
 */
export async function listLibraryItems(
  { supabase, user, workspaceId }: WorkspaceAuthContext,
  category: LibraryCategory | null,
  opts: ListOptions = {},
) {
  // A feature-owned system skill (today only `/create-eval`) is invisible while
  // its feature is off. ONE settings read; an empty result leaves the query
  // byte-identical to what it was before the gate existed.
  const gated = featureGatedRecipeExclusions(
    await resolveWorkspaceEdition(supabase, workspaceId),
  )

  let query = excludeFeatureGatedRecipes(
    supabase
      .from('recipe')
      .select(LIBRARY_ITEM_FIELDS)
      .or(`is_system.eq.true,workspace_id.eq.${workspaceId}`),
    gated,
  )

  if (opts.mine) {
    query = query.eq('created_by', user.id).eq('is_system', false)
  }

  // Only skills carry a lens.
  if (category === 'skill' && !opts.includeLenses) {
    query = excludeLensSkills(query)
  }

  if (category) {
    query = query.eq('category', category)
  }

  return query
    .order('is_system', { ascending: false })
    .order('sort_order', { ascending: true })
}

// ─── Fork lineage enrichment ─────────────────────────────────────────
//
// A forked item carries `forked_from` (the source's id, ON DELETE SET NULL).
// The list payloads annotate each fork with its source's *display* facts —
// name + updated_at — so the UI can show "Forked from {name}" and a quiet
// "source has changed" hint without the row already carrying that data.
//
// The source may be a PUBLIC listing owned by ANOTHER workspace, so it's read
// with the same request-scoped client the Discover route uses for public rows
// (RLS permits reading is_system OR visibility='public' cross-tenant). We
// select ONLY id/name/updated_at — never system_prompt or any config blob —
// so the enrichment can't leak a source's private prompt into a fork's payload.

/** The minimal source facts a forked row is annotated with. */
export interface LineageSource {
  name: string | null
  updated_at: string | null
}

/** A row shaped enough for lineage annotation — the list rows are a superset. */
export interface LineageAnnotatable {
  forked_from?: string | null
  created_at?: string | null
}

/** The lineage fields merged onto a forked row's payload. */
export interface LineageFields {
  source_name: string | null
  source_updated_at: string | null
}

/**
 * Batched source lookup for a set of already-fetched rows. Collects the
 * distinct non-null `forked_from` ids and reads their display facts in ONE
 * IN() query. Rows with no `forked_from`, or whose source was deleted
 * (forked_from null'd) or is otherwise unreadable, simply don't appear in the
 * returned map — the annotator treats a miss as "source gone" (shows nothing).
 *
 * Reads via the caller's request-scoped client so cross-tenant PUBLIC sources
 * resolve under RLS exactly as the Discover route reads them. Selects only
 * id/name/updated_at — no prompt/config ever crosses the workspace boundary.
 */
export async function fetchLineageSources(
  supabase: WorkspaceAuthContext['supabase'],
  rows: LineageAnnotatable[],
): Promise<Map<string, LineageSource>> {
  const ids = Array.from(
    new Set(rows.map((r) => r.forked_from).filter((x): x is string => !!x)),
  )
  const map = new Map<string, LineageSource>()
  if (ids.length === 0) return map

  const { data } = await supabase
    .from('recipe')
    .select('id, name, updated_at')
    .in('id', ids)

  for (const s of (data as { id: string; name: string | null; updated_at: string | null }[] | null) ?? []) {
    map.set(s.id, { name: s.name, updated_at: s.updated_at })
  }
  return map
}

/**
 * Pure lineage annotator: rows + a source map → the same rows, each forked one
 * carrying its source's `source_name` and `source_updated_at`. Non-forks and
 * forks whose source is missing from the map (deleted / unreadable) get null
 * lineage fields, so the UI renders nothing for them. No I/O — unit-tested.
 *
 * The "source has changed" hint is a pure comparison the UI makes from the
 * annotated fields (source_updated_at > the fork's created_at); we surface the
 * raw timestamps rather than a boolean so the row still has the source name to
 * show even when it hasn't diverged.
 */
export function annotateLineage<T extends LineageAnnotatable>(
  rows: T[],
  sources: Map<string, LineageSource>,
): (T & LineageFields)[] {
  return rows.map((row) => {
    const source = row.forked_from ? sources.get(row.forked_from) : undefined
    return {
      ...row,
      source_name: source?.name ?? null,
      source_updated_at: source?.updated_at ?? null,
    }
  })
}

/**
 * List + annotate in one call: fetch the workspace's items, then batch-resolve
 * and merge fork-source display facts. This is what the account list routes
 * return so the client gets lineage without a second round-trip. On a list
 * error the annotation is skipped and the raw error is passed through.
 */
export async function listLibraryItemsWithLineage(
  auth: WorkspaceAuthContext,
  category: LibraryCategory | null,
  opts: ListOptions = {},
) {
  const { data, error } = await listLibraryItems(auth, category, opts)
  if (error || !data) return { data, error }
  const sources = await fetchLineageSources(auth.supabase, data as LineageAnnotatable[])
  return { data: annotateLineage(data as (LineageAnnotatable & Record<string, unknown>)[], sources), error }
}

export interface CreateLibraryItemInput {
  name: string
  category: LibraryCategory
  visibility?: 'personal' | 'workspace' | 'public'
  system_prompt?: string
  icon?: string | null
  color?: string | null
  description?: string | null
  sort_order?: number
  model?: string | null
  slug?: string | null
  agent_config?: Record<string, unknown> | null
  /** A skill's area (migration 316), already validated (parseSkillArea). */
  area?: string | null
}

/**
 * Build the row to insert into `recipe`. Category-specific defaults applied
 * here so route handlers stay thin.
 */
export function buildInsertRow(
  { user, workspaceId }: WorkspaceAuthContext,
  input: CreateLibraryItemInput,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    workspace_id: workspaceId,
    name: input.name,
    system_prompt: input.system_prompt || '',
    is_system: false,
    category: input.category,
    visibility: input.visibility || 'workspace',
    created_by: user.id,
  }

  if (input.icon !== undefined) row.icon = input.icon
  if (input.color !== undefined) row.color = input.color
  if (input.description !== undefined) row.description = input.description
  if (input.sort_order !== undefined) row.sort_order = input.sort_order
  if (input.model !== undefined) row.model = input.model || null

  // agent_config persists for both categories: skills store persona styling
  // (response_style, context_rules); agents store the tool allowlist
  // (enabled_tools, disabled_tools).
  if (input.agent_config !== undefined) row.agent_config = input.agent_config

  if (input.category === 'skill') {
    if (input.slug) row.slug = input.slug
    if (input.area !== undefined) row.area = input.area
  }

  return row
}

/** The single message shown when a non-admin attempts to publish to Discover. */
export const PUBLISH_ROLE_ERROR =
  'Only workspace owners and admins can publish to Discover'

/**
 * Publishing to Discover ('public') makes an item visible to EVERY Dial8 user,
 * platform-wide — a workspace-boundary-crossing act. Migration 191 opened recipe
 * writes to every member (so they can author their own personal/workspace items),
 * which silently also let any member set visibility='public'. This restores the
 * pre-191 invariant that only owners/admins can publish, enforced in the route
 * (RLS can't distinguish "publish" from an ordinary write). Returns true when the
 * given member role may publish; non-public writes never call this.
 */
export function canPublishPublic(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/**
 * Validate a skill slug. Returns null if valid, or an error string.
 */
export function validateSlug(slug: string): string | null {
  if (!slug) return 'Could not generate a valid slug'
  if (RESERVED_SLUGS.includes(slug)) return `"${slug}" is a reserved command name`
  return null
}

/**
 * Normalize a name into a slug. Lowercase, ASCII-safe, hyphen-separated.
 */
export function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

