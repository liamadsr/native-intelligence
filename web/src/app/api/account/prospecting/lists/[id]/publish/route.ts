/**
 * POST /api/account/prospecting/lists/[id]/publish — the list becomes (or
 * updates) its group in the CRM (migration 259).
 *
 * Everything saved on the list that the CRM group does not hold yet is
 * promoted and grouped under the list; a second press with nothing new is a
 * 200 with an empty `saved`. The namesake gate holds `needs_review` people
 * back here exactly as it did from bulk Save — they come back in `skipped`
 * and the per-row confirm publishes them one at a time.
 *
 * Decision 5 again: ANY member can publish a list. There is no role gate.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { publishList } from '@/lib/prospecting/publish'

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  const result = await publishList(supabase, { workspaceId, userId: user.id, listId: id })
  if (!result.ok) {
    if (result.code === 'NOT_FOUND') return notFound('List not found')
    if (result.code === 'INVALID_INPUT') return badRequest(result.error)
    return serverError()
  }

  return NextResponse.json({
    saved: result.saved,
    skipped: result.skipped,
    list_ids: result.list_ids,
    published_at: result.published_at,
    list_name: result.list_name,
  })
}
