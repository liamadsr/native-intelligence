import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { parseFilters } from '@/lib/knowledge/graph-map'
import { getTiles } from '@/lib/knowledge/graph-map/service'
import {
  MAX_TILES_PER_REQUEST,
  parseTileId,
  type TileId,
} from '@/lib/knowledge/graph-map/types'
import { MAP_HEADERS } from '../headers'

/**
 * GET /api/account/knowledge/map/tiles?v=<version>&<filters>&t=z.x.y,z.x.y,…
 *
 * Streams the tiles the viewport needs but the initial `…/map` response did
 * not inline. `v` pins the version the client's manifest came from: if the
 * workspace has changed since, the manifest's tile ids no longer describe the
 * current map, so we answer 409 `stale_map` rather than serving tiles from a
 * different map (which would draw nodes at stale positions). The client
 * answers a 409 by re-fetching `…/map`.
 *
 * Filters must match the ones the manifest was built with — they decide which
 * nodes fill which tiles (§4.3), so they are part of the request, not state.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { searchParams } = request.nextUrl

  const version = searchParams.get('v')
  if (!version) return badRequest('v (map version) is required')

  // Validated before the tile ids so a malformed filter payload is reported as
  // itself, rather than as whatever the tile list happens to say.
  const parsed = parseFilters(searchParams)
  if (!parsed.ok) return badRequest(parsed.error)

  const raw = (searchParams.get('t') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (raw.length === 0) return badRequest('t (tile ids) is required')
  if (raw.length > MAX_TILES_PER_REQUEST) {
    return badRequest(`at most ${MAX_TILES_PER_REQUEST} tiles per request`)
  }

  // Validate EVERY id: a malformed or out-of-range id is a client bug, and
  // silently dropping it would leave a hole on the canvas that looks like
  // missing data rather than a bad request.
  const ids: TileId[] = []
  for (const id of raw) {
    if (!parseTileId(id)) return badRequest(`invalid tile id: ${id}`)
    ids.push(id)
  }

  try {
    const tiles = await getTiles({
      supabase,
      workspaceId,
      userId: user.id,
      filters: parsed.filters,
      version,
      ids,
    })

    if (tiles === 'stale') {
      // The api-errors shape plus one extra top-level `stale` flag: the tile
      // store checks a boolean on the body rather than string-matching a code.
      return NextResponse.json(
        { error: 'Map version is no longer current', code: 'stale_map', stale: true },
        { status: 409, headers: MAP_HEADERS },
      )
    }

    return NextResponse.json({ tiles }, { headers: MAP_HEADERS })
  } catch (err) {
    console.error('[knowledge/map/tiles] build failed:', err)
    return serverError('Failed to build knowledge map tiles')
  }
}
