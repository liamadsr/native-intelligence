import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { writeItems } from '@/lib/canvas/store'
import { canvasRefusal } from '@/lib/canvas/responses'
import type { CanvasItemsWrite } from '@/lib/canvas/types'

type Ctx = { params: Promise<{ id: string }> }

/** POST a CanvasItemsWrite ({ upsert?, remove? }): the changed items, one version bump. */
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
    return NextResponse.json({ ok: true, version: result.value.version })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not save the canvas')
  }
}
