import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { syncCanvasRecordLinks, touchesRecords } from '@/lib/canvas/links'
import { badRequest, serverError } from '@/lib/api-errors'
import { writeItems } from '@/lib/canvas/store'
import { canvasRefusal } from '@/lib/canvas/responses'
import type { CanvasItemsWrite } from '@/lib/canvas/types'

type Ctx = { params: Promise<{ id: string }> }

/** POST a CanvasItemsWrite ({ upsert?, remove? }): the changed items, one version bump, and the links its record cards make. */
export async function POST(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  const body = (await request.json().catch(() => null)) as CanvasItemsWrite | null
  if (!body || typeof body !== 'object') return badRequest('A write needs items.')
  try {
    const result = await writeItems(supabase, workspaceId, id, { upsert: body.upsert, remove: body.remove }, { userId: user.id })
    if (!result.ok) return canvasRefusal(result)
    // A card added or taken off: the canvas's links to records follow (never fails the save).
    if (touchesRecords(body)) {
      const { data: me } = await supabase.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', user.id).maybeSingle()
      const linked = await syncCanvasRecordLinks(supabase, { workspaceId, canvasId: id, userId: user.id, memberId: (me as { id: string } | null)?.id ?? null })
      if (linked.error) console.warn('[canvas] record links not synced:', linked.error)
    }
    return NextResponse.json({ ok: true, version: result.value.version })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not save the canvas')
  }
}
