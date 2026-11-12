/**
 * /api/account/seo/ai-visibility/[id]: one AI visibility tracker.
 *
 *   GET     the tracker with its prompts, recent checks, the live check,
 *           the cost estimate (one check, a month of the schedule) and the
 *           latest completed check's headline (AiTrackerSummary). Free.
 *   PATCH   change it (any of the create fields, and `confirmed`). A change
 *           that raises a scheduled tracker's monthly cost answers 409
 *           CONFIRMATION_REQUIRED with both estimates until `confirmed: true`.
 *           Whoever turns the schedule on pays for it from then on.
 *   DELETE  delete it with its prompts, checks and answers (409 while a
 *           check runs).
 *
 * Any member may read and change. Nothing here spends.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { aiFailureResponse, jsonBody, UUID } from '@/lib/seo/ai-visibility/http'
import { updateTrackerRequestSchema } from '@/lib/seo/ai-visibility/input'
import { getTrackerSummary } from '@/lib/seo/ai-visibility/summary'
import { deleteTracker, updateTracker } from '@/lib/seo/ai-visibility/trackers'
import { NextResponse, type NextRequest } from 'next/server'

type Params = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Tracker not found')
  try {
    const summary = await getTrackerSummary(
      getServiceClient(),
      auth.workspaceId,
      id,
    )
    if (!summary) return notFound('Tracker not found')
    return NextResponse.json(summary)
  } catch (err) {
    console.error('[seo-ai] tracker read failed', err)
    return serverError('Could not load the tracker just now.')
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Tracker not found')
  const parsed = updateTrackerRequestSchema.safeParse(await jsonBody(request))
  if (!parsed.success) return badRequest('That change isn’t valid.')
  const { confirmed, ...patch } = parsed.data
  try {
    const out = await updateTracker(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      id,
      patch,
      { confirmed },
    )
    if (!out.ok) return aiFailureResponse(out)
    return NextResponse.json({ tracker: out.tracker, estimate: out.estimate })
  } catch (err) {
    console.error('[seo-ai] tracker update failed', err)
    return serverError('Could not save the tracker just now.')
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Tracker not found')
  try {
    const out = await deleteTracker(
      getServiceClient(),
      { workspaceId: auth.workspaceId },
      id,
    )
    if (!out.ok) return aiFailureResponse(out)
    return NextResponse.json({ deleted: true, tracker: out.tracker })
  } catch (err) {
    console.error('[seo-ai] tracker delete failed', err)
    return serverError('Could not delete the tracker just now.')
  }
}
