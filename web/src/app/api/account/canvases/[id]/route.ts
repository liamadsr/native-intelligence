import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { deleteCanvas, getCanvas, updateCanvas } from '@/lib/canvas/store'
import { canvasRefusal } from '@/lib/canvas/responses'
import { CANVAS_MEDIA_BUCKET, removeCanvasMedia, type MediaBucket } from '@/lib/canvas/media'
import { getServiceClient } from '@/lib/supabase/service'
import type { CanvasVisibility } from '@/lib/canvas/types'
import { loadRecordSharing } from '@/lib/entity-access/store'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET: one canvas with its items, whether the caller may edit it, and its
 * sharing (migration 688): whether they may share it, with how many, and
 * whether it is open to them only because it was shared with them.
 */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  try {
    const canvas = await getCanvas(supabase, workspaceId, id, { userId: user.id })
    if (!canvas) return notFound('Canvas not found')
    const sharing = await loadRecordSharing(supabase, workspaceId, 'canvas', id)
    // `viewer`: who is looking, so the editor keeps unsent edits per person.
    return NextResponse.json({ ...canvas, viewer: user.id, sharing })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load the canvas')
  }
}

/** PATCH { title?, visibility?, project_id?, settings?, archived? }: the canvas's own fields. */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Nothing to change.')
  try {
    const result = await updateCanvas(
      supabase,
      workspaceId,
      id,
      {
        ...(body.title !== undefined ? { title: typeof body.title === 'string' ? body.title : '' } : {}),
        ...(body.visibility !== undefined ? { visibility: body.visibility as CanvasVisibility } : {}),
        ...(body.project_id !== undefined ? { project_id: typeof body.project_id === 'string' ? body.project_id : null } : {}),
        ...(body.settings !== undefined ? { settings: body.settings as Record<string, unknown> } : {}),
        ...(body.archived !== undefined ? { archived: body.archived === true } : {}),
      },
      { userId: user.id },
    )
    if (!result.ok) return canvasRefusal(result)
    return NextResponse.json({ canvas: result.value })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not change the canvas')
  }
}

/** DELETE: archive the canvas; ?permanent=1 deletes it for good. */
export async function DELETE(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  try {
    const permanent = request.nextUrl.searchParams.get('permanent') === '1'
    const result = await deleteCanvas(supabase, workspaceId, id, { userId: user.id }, { permanent })
    if (!result.ok) return canvasRefusal(result)
    // Gone for good: its images and video go too. Only after the row's own
    // delete passed the policy; a file that will not go is logged, not a failure.
    if (permanent) {
      try {
        const cleared = await removeCanvasMedia(getServiceClient().storage.from(CANVAS_MEDIA_BUCKET) as unknown as MediaBucket, workspaceId, id)
        if (cleared.error) console.warn('[canvas] files left behind after a delete:', cleared.error)
      } catch (e) {
        console.warn('[canvas] files left behind after a delete:', e instanceof Error ? e.message : e)
      }
    }
    return NextResponse.json({ ok: true })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not delete the canvas')
  }
}
