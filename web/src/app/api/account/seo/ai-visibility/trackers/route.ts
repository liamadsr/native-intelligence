/**
 * /api/account/seo/ai-visibility/trackers: the workspace's AI visibility
 * trackers.
 *
 *   GET   the trackers, newest first, each with its prompt counts and latest
 *         check, plus the workspace's own site (the setup form's default).
 *   POST  { brand_name, brand_aliases?, domain?, competitors?, location_code?,
 *         language_code?, engines?, schedule_interval?, paused?, prompts?,
 *         confirmed? }: create a tracker. Saving costs nothing; a schedule
 *         spends every period, so creating one with a schedule answers 409
 *         CONFIRMATION_REQUIRED with the estimate until `confirmed: true`.
 *
 * Any member may read and create. Free.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { aiFailureResponse, jsonBody } from '@/lib/seo/ai-visibility/http'
import { createTrackerRequestSchema } from '@/lib/seo/ai-visibility/input'
import { listTrackers } from '@/lib/seo/ai-visibility/queries'
import { createTracker } from '@/lib/seo/ai-visibility/trackers'
import { workspaceSiteUrl } from '@/lib/seo/site'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  try {
    const svc = getServiceClient()
    const [trackers, site] = await Promise.all([
      listTrackers(svc, auth.workspaceId),
      workspaceSiteUrl(svc, auth.workspaceId),
    ])
    return NextResponse.json({ trackers, default_domain: site })
  } catch (err) {
    console.error('[seo-ai] list trackers failed', err)
    return serverError('Could not load your AI visibility trackers just now.')
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const parsed = createTrackerRequestSchema.safeParse(await jsonBody(request))
  if (!parsed.success) return badRequest('That tracker isn’t valid.')
  const { prompts, confirmed, ...fields } = parsed.data
  try {
    const out = await createTracker(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      fields,
      { confirmed, prompts },
    )
    if (!out.ok) return aiFailureResponse(out)
    return NextResponse.json(
      { tracker: out.tracker, prompts: out.prompts, estimate: out.estimate },
      { status: 201 },
    )
  } catch (err) {
    console.error('[seo-ai] create tracker failed', err)
    return serverError('Could not save the tracker just now.')
  }
}
