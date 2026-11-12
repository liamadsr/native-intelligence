/**
 * /api/account/studio/* — the Studio (making videos and ads): the editor's whole API behind one route.
 *
 *   /file/<workspace>/<key…>   a stored file (media, exports, thumbnails), streamed with byte ranges, for members
 *                              of that workspace (a <video> or <img> request carries the session cookie only)
 *   everything else            the person's current workspace, members but guests (src/lib/studio/server/routes)
 *
 * The paths are the editor's own: /projects/:id is a video, /campaigns are studio projects. Errors are
 * `{ error, code? }` with the error a sentence the editor shows as is.
 */
import { requireStudio, requireStudioMemberOf } from '@/lib/studio/server/auth'
import { handleFile, handleStudio } from '@/lib/studio/server/http'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 300

type Params = { params: Promise<{ path?: string[] }> }

async function handle(request: Request, { params }: Params): Promise<Response> {
  const segments = (await params).path ?? []
  if (segments[0] === 'file') return handleFile(request, segments.slice(1), requireStudioMemberOf)
  const ctx = await requireStudio()
  if (ctx instanceof Response) return ctx
  return handleStudio(request, segments, ctx)
}

export { handle as GET, handle as HEAD, handle as POST, handle as PUT, handle as PATCH, handle as DELETE }
