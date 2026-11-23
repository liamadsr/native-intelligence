import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { createCanvas, listCanvases } from '@/lib/canvas/store'
import { canvasRefusal } from '@/lib/canvas/responses'
import type { CanvasVisibility } from '@/lib/canvas/types'
import { listSharingByRecord } from '@/lib/entity-access/store'

/** GET: the workspace's canvases (?archived=1 for the archived ones). POST: a new canvas. */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth
  try {
    const canvases = await listCanvases(supabase, workspaceId, { archived: request.nextUrl.searchParams.get('archived') === '1' })
    // Each row's sharing (688): how many its owner shared it with, or that it was shared with the viewer.
    const sharing = await listSharingByRecord(
      supabase,
      { workspaceId, memberId: member.id },
      'canvas',
      canvases.map((c) => ({ id: c.id, owner: c.owner_member_id ?? null, visibility: c.visibility })),
    )
    return NextResponse.json({ canvases: canvases.map((c) => ({ ...c, sharing: sharing.get(c.id) ?? { shared_count: 0, shared_with_me: false } })) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load canvases')
  }
}

/** POST { title?, visibility?, project_id? }: a new canvas, owned by the caller. */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth
  const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>
  if (typeof body !== 'object' || Array.isArray(body)) return badRequest('Bad request.')
  try {
    const result = await createCanvas(
      supabase,
      workspaceId,
      {
        title: typeof body.title === 'string' ? body.title : undefined,
        visibility: body.visibility === undefined ? undefined : (body.visibility as CanvasVisibility),
        project_id: typeof body.project_id === 'string' ? body.project_id : null,
      },
      { userId: user.id, ownerMemberId: member.id },
    )
    if (!result.ok) return canvasRefusal(result)
    return NextResponse.json({ canvas: result.value }, { status: 201 })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not make the canvas')
  }
}
