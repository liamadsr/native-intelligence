import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { getCanvas } from '@/lib/canvas/store'
import {
  CANVAS_MEDIA_BUCKET,
  CANVAS_MEDIA_MAX_BYTES,
  CANVAS_MEDIA_MAX_LABEL,
  CANVAS_MEDIA_TYPES,
  canvasMediaPath,
  canvasMediaUrl,
  isCanvasMediaPath,
} from '@/lib/canvas/media'
import { getServiceClient } from '@/lib/supabase/service'

type Ctx = { params: Promise<{ id: string }> }

/**
 * GET ?path=: a canvas's image or video. The caller must be able to open the
 * canvas (read under their own client), and the path must be this canvas's.
 * Answers with a redirect to a link that lasts ten minutes.
 */
export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  const path = request.nextUrl.searchParams.get('path')
  try {
    const found = await getCanvas(supabase, workspaceId, id, { userId: user.id })
    if (!found) return notFound('That canvas is not here.')
    if (!isCanvasMediaPath(path, found.canvas.workspace_id, id)) return badRequest('That file is not on this canvas.')
    const { data, error } = await getServiceClient().storage.from(CANVAS_MEDIA_BUCKET).createSignedUrl(path, 600)
    if (error || !data?.signedUrl) return notFound('That file is gone.')
    const res = NextResponse.redirect(data.signedUrl, 302)
    // The link is good for ten minutes; let the browser reuse it for five.
    res.headers.set('Cache-Control', 'private, max-age=300')
    return res
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not open the file')
  }
}

/**
 * POST a file (multipart, field `file`): an image or a video for this canvas.
 * Only someone who can edit the canvas. Answers { path, url, kind }.
 */
export async function POST(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  try {
    const found = await getCanvas(supabase, workspaceId, id, { userId: user.id })
    if (!found) return notFound('That canvas is not here.')
    if (!found.can_edit) return forbidden('You can view this canvas but not change it.')
    const form = await request.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return badRequest('Send the file as "file".')
    const type = CANVAS_MEDIA_TYPES[file.type.toLowerCase()]
    if (!type) return badRequest('A canvas takes PNG, JPEG, GIF and WebP images, and MP4, WebM and MOV video.')
    if (file.size <= 0) return badRequest('That file is empty.')
    if (file.size > CANVAS_MEDIA_MAX_BYTES) return badRequest(`That file is over ${CANVAS_MEDIA_MAX_LABEL}.`)
    const path = canvasMediaPath(found.canvas.workspace_id, id, crypto.randomUUID(), type.ext)
    const { error } = await getServiceClient()
      .storage.from(CANVAS_MEDIA_BUCKET)
      .upload(path, Buffer.from(await file.arrayBuffer()), { contentType: file.type, upsert: false })
    if (error) return serverError(error.message)
    return NextResponse.json({ path, url: canvasMediaUrl(id, path), kind: type.kind }, { status: 201 })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not store the file')
  }
}
