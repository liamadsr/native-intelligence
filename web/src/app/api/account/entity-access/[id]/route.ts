/**
 * /api/account/entity-access/[id] (migrations 492, 512)
 *   PATCH  { level: 'view'|'edit' } → { ok: true } the grant's level changed,
 *          by someone who may share its record. 404 when there is none the
 *          person may change. A member raised from view to edit is told
 *          (record_shared, src/lib/entity-access/notify.ts).
 *   DELETE → { ok: true } one grant removed: by someone who may share its
 *          record, or by whoever made it (a share-by-mention's Undo). 404
 *          when there is none the person may remove.
 * A canvas or spreadsheet grant removed, or lowered to view, is announced in
 * its presence room (lib/canvas/access-notice.ts) so its open editors ask again.
 * Runs as the person, under RLS.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { isGrantLevel } from '@/lib/entity-access/model'
import { notifyRecordShared, readGrantForNotice, type GrantForNotice } from '@/lib/entity-access/notify'
import { announceAccessChanged, announceCanvasAccessChanged } from '@/lib/canvas/access-notice'
import { spreadsheetPresenceTopic } from '@/lib/spreadsheets/presence-topic'
import { getServiceClient } from '@/lib/admin'

/** A canvas's or a spreadsheet's open editors ask again whether they may open or edit it. Never throws. */
async function announceIfCanvas(grant: GrantForNotice | null): Promise<void> {
  if (grant?.type !== 'canvas' && grant?.type !== 'spreadsheet') return
  try {
    if (grant.type === 'canvas') await announceCanvasAccessChanged(getServiceClient(), grant.id)
    else await announceAccessChanged(getServiceClient(), spreadsheetPresenceTopic(grant.id))
  } catch {
    /* no service client: the editor's next save or read fails under RLS in any case */
  }
}
import { removeEntityGrant, setEntityGrantLevel } from '@/lib/entity-access/store'
import { isUuid } from '@/lib/team-chat/types'

type Params = { params: Promise<{ id: string }> }

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  let input: Record<string, unknown>
  try {
    input = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (!isGrantLevel(input.level)) return badRequest('level takes view or edit')
  try {
    // The grant as it was, under the person's RLS: whether this raises it from view to edit.
    const before = await readGrantForNotice(auth.supabase, auth.workspaceId, id)
    const changed = await setEntityGrantLevel(auth.supabase, auth.workspaceId, id, input.level)
    if (!changed) return notFound()
    if (before && before.level === 'view' && input.level === 'edit') {
      await notifyRecordShared(auth.supabase, { workspaceId: auth.workspaceId, actorMemberId: auth.member.id, ...before, level: 'edit', raised: true })
    }
    if (before && before.level === 'edit' && input.level === 'view') await announceIfCanvas(before)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[entity-access] level change failed:', err instanceof Error ? err.message : 'unknown')
    return serverError()
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound()
  try {
    const before = await readGrantForNotice(auth.supabase, auth.workspaceId, id)
    const removed = await removeEntityGrant(auth.supabase, auth.workspaceId, id)
    if (!removed) return notFound()
    await announceIfCanvas(before)
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[entity-access] remove failed:', err instanceof Error ? err.message : 'unknown')
    return serverError()
  }
}
