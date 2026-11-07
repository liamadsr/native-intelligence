import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/admin'
import { featureGatedRecipeExclusions, resolveWorkspaceEdition } from '@/lib/editions'
import {
  MENU_SEARCH_DEFAULT_LIMIT,
  MENU_SEARCH_KINDS,
  MENU_SEARCH_MAX_LIMIT,
  isMenuSearchKind,
  type MenuSearchKind,
  type MenuSearchResponse,
} from '@/lib/search/menu-search'
import { MENU_QUERIES, type MenuQueryContext } from './menu-queries'

/**
 * GET /api/account/search?q=&types=&limit= — the composer menu's search
 * (docs/plans/slash-search.md): every kind asked for (`types`, comma-separated;
 * all of them by default) in one answer, `limit` rows each, best first. With
 * nothing typed, each kind's most recent rows.
 *
 * The workspace is the composer's (`x-workspace-id`, membership checked by
 * requireWorkspace). Each kind is read in parallel; one that fails comes back
 * empty and the rest still answer.
 */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { searchParams } = request.nextUrl
  const query = (searchParams.get('q') ?? '').slice(0, 200)
  const typesParam = searchParams.get('types')
  const kinds: MenuSearchKind[] = typesParam
    ? [...new Set(typesParam.split(',').map((t) => t.trim()).filter(isMenuSearchKind))]
    : [...MENU_SEARCH_KINDS]
  const limitParam = parseInt(searchParams.get('limit') || '', 10)
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, MENU_SEARCH_MAX_LIMIT) : MENU_SEARCH_DEFAULT_LIMIT

  // A feature-owned system agent must not surface where its feature is off
  // (resolved here: searchRecipes has no auth context of its own).
  const excludedRecipeIds = kinds.includes('agent') && query.trim()
    ? featureGatedRecipeExclusions(await resolveWorkspaceEdition(supabase, workspaceId))
    : []

  const ctx: MenuQueryContext = {
    supabase,
    service: getServiceClient(),
    workspaceId,
    userId: user.id,
    query,
    limit,
    excludedRecipeIds,
  }
  const found = await Promise.all(
    kinds.map((kind) =>
      MENU_QUERIES[kind](ctx).catch((err) => {
        console.error(`[menu-search] ${kind} threw:`, err)
        return []
      }),
    ),
  )

  const body: MenuSearchResponse = {
    query,
    results: Object.fromEntries(kinds.map((kind, i) => [kind, found[i]])),
  }
  return NextResponse.json(body)
}
