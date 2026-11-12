/**
 * The Mac body's Studio product jobs (src/lib/studio/server/products.ts), on the job's session token like every Mac body
 * call (src/lib/studio/server/product-mac.ts):
 *
 *   GET  ?job=<id>   the job to run: what to do, the product's settings, and for a capture or a refresh what to make.
 *                    Only the person's own job, made for the folder this session runs in.
 *   POST {report}    what an onboarding, a listing or a refresh found (product-contract.ts ReportSchema).
 *
 * Captures (the files) come to ./capture. Nothing here runs the product's code: that ran on the Mac, in the job's fence.
 */
import { NextResponse } from 'next/server'
import { apiError, badRequest } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { StudioError } from '@/lib/studio/server/errors'
import { macStudio, readCappedBody } from '@/lib/studio/server/product-mac'
import { ReportSchema } from '@/lib/studio/server/product-contract'
import { applyReport, getProductJob, jobForMac, macHoldsJob } from '@/lib/studio/server/products'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** The largest report taken (a listing of 2000 components is well under it), read under that cap. */
const REPORT_MAX_BYTES = 8 * 1024 * 1024

/** A Studio error as the route's answer (its sentence and code). */
function answerError(error: unknown): Response {
  if (error instanceof StudioError) return apiError(error.message, { status: error.status, code: error.code })
  console.error('[studio] product job:', error instanceof Error ? error.message : error)
  return apiError('The Studio could not take that just now. Try again.', { status: 500, code: 'INTERNAL' })
}

export async function GET(request: Request) {
  const mac = await macStudio(request, getServiceClient())
  if (mac instanceof Response) return mac
  const id = new URL(request.url).searchParams.get('job') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) return badRequest('job must be a Studio product job id')
  try {
    const { job, product } = await jobForMac(mac.ctx, id, mac.caller)
    return NextResponse.json({
      job: { id: job.id, kind: job.kind, title: job.title ?? null, capture: job.capture ? { component: job.capture.component, options: job.capture.options } : null, refresh: job.refresh ? { items: job.refresh.items.map(({ component, options, key }) => ({ component, options, key })) } : null },
      kit: product?.kit ?? null,
    })
  } catch (error) {
    return answerError(error)
  }
}

export async function POST(request: Request) {
  const mac = await macStudio(request, getServiceClient())
  if (mac instanceof Response) return mac
  const body = await readCappedBody(request, REPORT_MAX_BYTES)
  if (!body) return apiError('That report is too large.', { status: 413, code: 'TOO_LARGE' })
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(body))
  } catch {
    return badRequest('invalid JSON body')
  }
  const parsed = ReportSchema.safeParse(raw)
  if (!parsed.success) return badRequest(`That report does not fit: ${parsed.error.issues[0]?.path.join('.') ?? ''} ${parsed.error.issues[0]?.message ?? ''}`.trim())
  try {
    // Only a job this session took and is still running: a finished or expired job takes no second report.
    const job = await getProductJob(mac.ctx, parsed.data.job)
    if (!macHoldsJob(job, mac.caller)) {
      return apiError('That is not a Studio product job this local agent is running.', { status: 404, code: 'NOT_FOUND' })
    }
    const saved = await applyReport(mac.ctx, job, parsed.data, mac.names)
    return NextResponse.json({ status: saved.status, product: saved.slug, ...(saved.error ? { error: saved.error } : {}), result: saved.result ?? null })
  } catch (error) {
    return answerError(error)
  }
}
