/**
 * /api/account/seo/ai-visibility/[id]/runs: a tracker's checks.
 *
 *   GET   ?offset=  the checks, newest first, a page at a time. Free.
 *   POST  { confirmed? }: start a check now (PAID: one answer per active
 *         prompt per engine, metered against the workspace's monthly
 *         ceiling as the person's own request). A check estimated above
 *         CONFIRM_ABOVE_USD answers 409 CONFIRMATION_REQUIRED with the
 *         estimate until `confirmed: true`. One live check per tracker (409
 *         RUN_IN_PROGRESS carries it). The answers are bought in the
 *         background; read the check at /runs/[id] every poll_after_seconds.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { aiFailureResponse, jsonBody, UUID } from '@/lib/seo/ai-visibility/http'
import { startRunRequestSchema } from '@/lib/seo/ai-visibility/input'
import { getTracker, listRuns } from '@/lib/seo/ai-visibility/queries'
import { startManualRun } from '@/lib/seo/ai-visibility/runs'
import { NextResponse, type NextRequest } from 'next/server'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Tracker not found')
  const offset = Number(request.nextUrl.searchParams.get('offset') ?? 0)
  try {
    const svc = getServiceClient()
    if (!(await getTracker(svc, auth.workspaceId, id)))
      return notFound('Tracker not found')
    return NextResponse.json(
      await listRuns(
        svc,
        auth.workspaceId,
        id,
        Number.isFinite(offset) ? offset : 0,
      ),
    )
  } catch (err) {
    console.error('[seo-ai] runs read failed', err)
    return serverError('Could not load the checks just now.')
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Tracker not found')
  const parsed = startRunRequestSchema.safeParse(
    (await jsonBody(request)) ?? {},
  )
  if (!parsed.success) return badRequest('That request isn’t valid.')
  try {
    const out = await startManualRun(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      id,
      { confirmed: parsed.data.confirmed },
    )
    if (!out.ok) return aiFailureResponse(out)
    return NextResponse.json(
      { run: out.run, estimate: out.estimate },
      { status: 201 },
    )
  } catch (err) {
    console.error('[seo-ai] start check failed', err)
    return serverError('Could not start the check just now.')
  }
}
