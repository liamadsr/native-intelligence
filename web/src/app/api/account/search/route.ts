import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/admin'
import { featureGatedRecipeExclusions, isFeatureEnabled, resolveWorkspaceEdition, type ResolvedEdition } from '@/lib/editions'
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

  const service = getServiceClient()
  const wantsAgents = kinds.includes('agent') && !!query.trim()
  const wantsStudio = kinds.some((k) => k === 'studio_video' || k === 'studio_project')
  // The workspace's edition, read once when a gated kind is asked for, and (only when a Studio kind is) the caller's
  // role, read beside it: a search without a Studio kind reads no role, one with them waits on no extra read in series.
  const [edition, studioMember] = await Promise.all([
    wantsAgents || wantsStudio ? resolveWorkspaceEdition(supabase, workspaceId) : Promise.resolve(null as ResolvedEdition | null),
    wantsStudio ? isStudioMember(service, workspaceId, user.id) : Promise.resolve(false),
  ])

  // A feature-owned system agent must not surface where its feature is off
  // (resolved here: searchRecipes has no auth context of its own).
  const excludedRecipeIds = wantsAgents && edition ? featureGatedRecipeExclusions(edition) : []

  // The Studio's videos and Studio projects: only where the feature is on, and
  // never for a workspace guest (requireStudio's rule).
  const studio = wantsStudio && !!edition && isFeatureEnabled(edition, 'studio') && studioMember

  const ctx: MenuQueryContext = {
    supabase,
    service,
    workspaceId,
    userId: user.id,
    query,
    limit,
    excludedRecipeIds,
    studio,
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

/** The caller is a member of the workspace and not a guest (who may not use the Studio). False on any error. */
async function isStudioMember(service: ReturnType<typeof getServiceClient>, workspaceId: string, userId: string): Promise<boolean> {
  try {
    const { data, error } = await service.from('member').select('role').eq('workspace_id', workspaceId).eq('user_id', userId).maybeSingle()
    if (error || !data) return false
    return (data as { role?: string | null }).role !== 'guest'
  } catch {
    return false
  }
}
