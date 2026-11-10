/**
 * /api/account/entity-access/[id] (migration 492)
 *   DELETE → { ok: true } one grant removed: by someone who may share its
 *          record, or by whoever made it (a share-by-mention's Undo). 404
 *          when there is none the person may remove.
 * Runs as the person, under RLS.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { removeEntityGrant } from '@/lib/entity-access/store'
import { isUuid } from '@/lib/team-chat/types'

type Params = { params: Promise<{ id: string }> }

export async function DELETE(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const removed = await removeEntityGrant(auth.supabase, auth.workspaceId, id)
    if (!removed) return notFound()
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[entity-access] remove failed:', err instanceof Error ? err.message : 'unknown')
    return serverError()
  }
}
