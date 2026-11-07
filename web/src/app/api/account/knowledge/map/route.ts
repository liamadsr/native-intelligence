import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { parseFilters } from '@/lib/knowledge/graph-map'
import { getMap } from '@/lib/knowledge/graph-map/service'
import { MAP_HEADERS } from './headers'

/**
 * GET /api/account/knowledge/map?<filters>[&have=<version>]
 *
 * The Knowledge Map's entry point. Replaces the whole-workspace payload of
 * `GET /api/account/knowledge`: instead of every claim, edge and source
 * excerpt, this returns the map's metadata (world bounds, counts, tile
 * manifest) plus the most important tiles inlined — so a workspace of a few
 * thousand nodes is exactly one request and everything else is fetched per
 * tile as the viewer zooms.
 *
 * `have=<version>` is the realtime revalidation path (§4.5): when the caller's
 * version still matches the source probe we answer `{ unchanged: true }` after
 * four head queries, without building anything.
 *
 * Filters are applied on the SERVER before tiling — positions come from the
 * unfiltered layout, so toggling a filter re-ranks which nodes fill which
 * tiles but never moves a node (§4.3).
 *
 * Read-only. Built entirely from rows the caller can read under their own RLS.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { searchParams } = request.nextUrl
  // A filter payload the map cannot make sense of is a bad REQUEST, not a
  // broken map: answering 500 would send the client into its retry/reload
  // path over something no retry can fix.
  const parsed = parseFilters(searchParams)
  if (!parsed.ok) return badRequest(parsed.error)
  const have = searchParams.get('have') ?? undefined

  try {
    const body = await getMap({
      supabase,
      workspaceId,
      userId: user.id,
      filters: parsed.filters,
      have,
    })
    return NextResponse.json(body, { headers: MAP_HEADERS })
  } catch (err) {
    console.error('[knowledge/map] build failed:', err)
    return serverError('Failed to build the knowledge map')
  }
}
