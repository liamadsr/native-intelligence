/**
 * GET /api/account/seo/ai-visibility/[id]/sources?run_id=&group_by=domain|page&domain=&offset=
 *
 * The sources leaderboard: which domains (or pages) the AI answers cited,
 * most-cited first, each marked own, competitor or other, with how many
 * answers and prompts cited it (AiSourcesView). Defaults to the tracker's
 * latest completed check; `run_id` reads another of its checks. Free.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { UUID } from '@/lib/seo/ai-visibility/http'
import {
  getRunRow,
  getRunSources,
  getTracker,
  latestCompletedRun,
} from '@/lib/seo/ai-visibility/queries'
import { NextResponse, type NextRequest } from 'next/server'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Tracker not found')
  const search = request.nextUrl.searchParams
  const runId = search.get('run_id')
  if (runId && !UUID.test(runId)) return notFound('Check not found')
  const groupBy = search.get('group_by') === 'page' ? 'page' : 'domain'
  const domain =
    search.get('domain')?.trim().toLowerCase().slice(0, 253) || null
  const offset = Number(search.get('offset') ?? 0)
  try {
    const svc = getServiceClient()
    if (!(await getTracker(svc, auth.workspaceId, id)))
      return notFound('Tracker not found')
    const run = runId
      ? await getRunRow(svc, auth.workspaceId, runId)
      : await latestCompletedRun(svc, auth.workspaceId, id)
    if (runId && (!run || run.tracker_id !== id))
      return notFound('Check not found')
    if (!run)
      return NextResponse.json({
        sources: {
          run_id: null,
          group_by: groupBy,
          rows: [],
          total_count: 0,
          next_offset: null,
        },
      })
    const sources = await getRunSources(svc, auth.workspaceId, run.id, {
      groupBy,
      domain,
      offset: Number.isFinite(offset) ? offset : 0,
    })
    return NextResponse.json({ sources })
  } catch (err) {
    console.error('[seo-ai] sources read failed', err)
    return serverError('Could not load the sources just now.')
  }
}
