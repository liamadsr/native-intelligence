/**
 * POST /api/local-agent/agent/studio/capture: a product component the Mac body rendered for a Studio product job
 * (src/lib/studio/server/products.ts acceptCapture), on the job's session token (../route.ts says who may).
 *
 * The body is the file itself (a transparent .webm or a .png still), at most CAPTURE_MAX_BYTES, read under that cap
 * (a body past it is cut off, never held whole); `x-studio-capture` is what it is, as base64url JSON
 * (product-contract.ts CaptureMetaSchema: the job, the component, its size and length, the code key and commit it
 * was built from). The job is checked before the body is read; the content type, the name and the file's own first
 * bytes must all say the kind the header says. It comes into the library through the import every upload takes (the
 * Studio worker checks the file), with that provenance, then is placed or swapped in as the job said.
 */
import { NextResponse } from 'next/server'
import { apiError, badRequest } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { StudioError } from '@/lib/studio/server/errors'
import { sniffMedia } from '@/lib/studio/server/library'
import { macStudio, readCappedBody } from '@/lib/studio/server/product-mac'
import { CaptureMetaSchema } from '@/lib/studio/server/product-contract'
import { acceptCapture, getProductJob, macHoldsJob } from '@/lib/studio/server/products'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
/** The import waits for the worker (up to a minute), then the placement. */
export const maxDuration = 120

/** The largest capture taken: 100 MB (a 60 s capture at 2x is a few MB). */
const CAPTURE_MAX_BYTES = 100 * 1024 * 1024

/** What each kind of capture is: its content type, its name's extension and what its bytes must be. */
const KINDS = { video: { type: 'video/webm', ext: 'webm' }, still: { type: 'image/png', ext: 'png' } } as const

/** The capture's description from its header, or null. */
function readMeta(header: string | null) {
  if (!header || header.length > 16_384) return null
  try {
    return CaptureMetaSchema.safeParse(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')))
  } catch {
    return null
  }
}

const tooLarge = () => apiError('That capture is larger than 100 MB.', { status: 413, code: 'TOO_LARGE' })

export async function POST(request: Request) {
  const mac = await macStudio(request, getServiceClient())
  if (mac instanceof Response) return mac
  const meta = readMeta(request.headers.get('x-studio-capture'))
  if (!meta?.success) return badRequest(`x-studio-capture must describe the capture${meta && !meta.success ? `: ${meta.error.issues[0]?.path.join('.')} ${meta.error.issues[0]?.message}` : ''}`)
  const want = KINDS[meta.data.kind]
  const type = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (type !== want.type) return apiError(`A ${meta.data.kind} capture is sent as ${want.type}.`, { status: 415, code: 'WRONG_TYPE' })
  if (!meta.data.name.toLowerCase().endsWith(`.${want.ext}`)) return badRequest(`A ${meta.data.kind} capture's name ends in .${want.ext}.`)
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > CAPTURE_MAX_BYTES) return tooLarge()
  try {
    // Who may send it is settled before a byte of it is read.
    const job = await getProductJob(mac.ctx, meta.data.job)
    if (!macHoldsJob(job, mac.caller)) {
      return apiError('That is not a Studio product job this local agent is running.', { status: 404, code: 'NOT_FOUND' })
    }
    const bytes = await readCappedBody(request, CAPTURE_MAX_BYTES)
    if (!bytes) return tooLarge()
    if (!bytes.byteLength) return badRequest('The capture is empty.')
    if (sniffMedia(bytes)?.ext !== want.ext) return apiError(`That file is not a ${want.ext === 'png' ? 'PNG' : 'WebM'}.`, { status: 415, code: 'WRONG_TYPE' })
    return NextResponse.json(await acceptCapture(mac.ctx, job, meta.data, bytes))
  } catch (error) {
    if (error instanceof StudioError) return apiError(error.message, { status: error.status, code: error.code })
    console.error('[studio] product capture:', error instanceof Error ? error.message : error)
    return apiError('The Studio could not take that capture just now. Try again.', { status: 500, code: 'INTERNAL' })
  }
}
