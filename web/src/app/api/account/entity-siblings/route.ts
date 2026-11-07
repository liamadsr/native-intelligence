/**
 * GET /api/account/entity-siblings?type=<entity>&id=<uuid>
 *
 * Answers "what sits directly above and below this entity in its default
 * list?" so the detail-panel prev/next arrows keep working when the tab was
 * opened WITHOUT a list behind it (deep link, search hit, chat citation,
 * history restore). The client's list-derived neighbours always win when a
 * list is mounted — this route is the fallback that makes the arrows a
 * property of the entity rather than a property of the mounted list.
 *
 * "prev" is the item ABOVE the current one in the default (newest-first)
 * ordering, "next" the one BELOW (older) — matching what the arrows do when a
 * list IS mounted.
 *
 * Deliberate implementation choice: rather than express each ordering as a
 * pair of SQL keyset queries (which SQL cannot do for the action ladder — the
 * identifier is TEXT like 'GEN-52', so 'GEN-9' sorts AFTER it lexically), we
 * fetch the ordering scope's minimal columns, sort in the route, and scan for
 * the neighbours. Workspace datasets are small (single-digit thousands at the
 * top end) and the query is index-friendly; the .limit() below bounds the read,
 * and the ORDER BY applied with it keeps the retained rows the newest ones —
 * an unordered LIMIT would keep an arbitrary planner-chosen subset instead.
 *
 * A missing entity returns 200 with both neighbours null, not 404: the client
 * treats "no siblings" and "entity gone" identically (hide the arrows), and a
 * 404 would surface as an error toast on a perfectly ordinary race (the row
 * was deleted in another tab while this one still shows it).
 */
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { isEntityType, resolveSiblings } from '@/lib/views/entity-siblings'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { searchParams } = new URL(request.url)
  const type = searchParams.get('type')
  const id = searchParams.get('id')

  if (!isEntityType(type)) {
    return badRequest('Unknown entity type', { type })
  }
  if (!id) return badRequest('id is required')

  const result = await resolveSiblings(supabase, workspaceId, type, id)
  if (result instanceof Response) return result

  return NextResponse.json(result)
}
